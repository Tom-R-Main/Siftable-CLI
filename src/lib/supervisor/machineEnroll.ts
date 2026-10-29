/**
 * `sift machine enroll` (first-run U2c): one browser approval gives this
 * machine a supervisor credential and an enrollment, held by the
 * siftable-supervisor account.
 *
 * Recovery rules (Release #16979, DB #16978):
 * - The journal is on disk before any network call. A retry of the same
 *   enrollment reuses its key and runner id; only a new enrollment gets a
 *   new key.
 * - The token is delivered once. If a poll reply is lost and the request
 *   then reads as expired, the approval may have happened: the state becomes
 *   delivery_unknown and is never silently re-enrolled.
 * - --replace revokes the old enrollment first, with the old credential, at
 *   the old API only (no redirects). An unknown revoke outcome stops the
 *   replacement. Old keys and records are kept under retired/.
 */
import {createPrivateKey, randomUUID} from 'node:crypto';
import {
  generateMachineKey,
  machineKeyFingerprint,
  type MachineHostLabels,
  type MachineScope,
  rawEd25519PublicKey,
  signMachineEnrollmentRequest,
} from './machineProtocol.js';
import {
  commitMachine,
  ensureStateDirectory,
  inspectMachineState,
  type MachineRecord,
  type MachineStateOptions,
  type PendingEnrollment,
  readCredential,
  readKey,
  retireMachineState,
  writeCredential,
  writeKey,
  writePending,
} from './machineState.js';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export interface MachineEnrollDeps {
  fetch: typeof fetch;
  state: MachineStateOptions;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  /** Progress for the operator; never receives the token. */
  log: (line: string) => void;
}

export interface MachineEnrollOptions {
  apiUrl: string;
  scope: MachineScope;
  host: MachineHostLabels;
  setupId?: string;
  replace: boolean;
}

export interface MachineEnrollResult {
  enrollmentId: string;
  runnerId: string;
  fingerprint: string;
  qualified: false;
  replaced?: {enrollmentId: string; retiredTo: string};
}

export class MachineEnrollError extends Error {}

const sameScope = (a: MachineScope, b: MachineScope) =>
  a.type === b.type && (a.type === 'user' || a.id === (b as {id: string}).id);

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Revokes the recorded enrollment with its own credential, at its own API. */
async function revokeRecorded(deps: MachineEnrollDeps, machine: MachineRecord): Promise<void> {
  const token = await readCredential(deps.state);
  if (!token) throw new MachineEnrollError('The recorded enrollment has no credential to revoke it with');
  let response: Response;
  try {
    response = await deps.fetch(`${machine.apiUrl}/api/v1/machines/enrollments/${machine.enrollmentId}/revoke`, {
      method: 'POST', redirect: 'error', headers: {Authorization: `Bearer ${token}`},
    });
  } catch {
    throw new MachineEnrollError('The old enrollment\'s revocation did not get a reply. Nothing was replaced; run again with --replace.');
  }
  // 401: the old credential is revoked or expired; the owner can still revoke the enrollment in the browser.
  if (response.ok) return;
  throw new MachineEnrollError(`The old enrollment was not revoked (HTTP ${response.status}). Nothing was replaced. `
    + `Revoke runner ${machine.runnerId} in the browser if its credential is gone, then run again with --replace.`);
}

async function startOrResume(deps: MachineEnrollDeps, options: MachineEnrollOptions): Promise<{pending: PendingEnrollment; replaced?: MachineEnrollResult['replaced']}> {
  await ensureStateDirectory(deps.state);
  let state = await inspectMachineState(deps.state);
  let replaced: MachineEnrollResult['replaced'];
  if (state.kind === 'enrolled') {
    if (!options.replace) {
      throw new MachineEnrollError(`This machine is already enrolled (runner ${state.machine.runnerId}). Use --replace to enroll it again.`);
    }
    await revokeRecorded(deps, state.machine);
    replaced = {enrollmentId: state.machine.enrollmentId, retiredTo: await retireMachineState(deps.state, deps.now())};
    state = {kind: 'empty'};
  } else if (state.kind === 'partial') {
    if (!options.replace) {
      throw new MachineEnrollError(`${deps.state.root} holds a partial enrollment (${state.present.join(', ')}). Inspect it, then run again with --replace.`);
    }
    await retireMachineState(deps.state, deps.now());
    state = {kind: 'empty'};
  } else if (state.kind === 'pending') {
    const reusable = state.pending.state !== 'delivery_unknown'
      && state.pending.apiUrl === options.apiUrl && sameScope(state.pending.scope, options.scope);
    if (state.pending.state === 'delivery_unknown' && !options.replace) {
      throw new MachineEnrollError(`An approval for runner ${state.pending.runnerId} may have completed, but its credential was lost. `
        + 'Revoke that runner in the browser, then run again with --replace.');
    }
    if (!reusable) {
      if (!options.replace) throw new MachineEnrollError('An enrollment for a different API or workspace is in progress. Run again with --replace to start over.');
      await retireMachineState(deps.state, deps.now());
      state = {kind: 'empty'};
    }
  }
  if (state.kind === 'pending') return {pending: state.pending, replaced};
  // A new enrollment: the key and the journal are on disk before any request.
  const key = generateMachineKey();
  const publicKey = rawEd25519PublicKey(key.privateKey);
  await writeKey(deps.state, key.pem);
  const pending: PendingEnrollment = {
    version: 1, apiUrl: options.apiUrl, scope: options.scope, runnerId: randomUUID(),
    fingerprint: machineKeyFingerprint(publicKey), publicKey, ...(options.setupId ? {setupId: options.setupId} : {}),
    state: 'requesting', createdAt: deps.now().toISOString(),
  };
  await writePending(deps.state, pending);
  return {pending, replaced};
}

async function requestDevice(deps: MachineEnrollDeps, options: MachineEnrollOptions, pending: PendingEnrollment): Promise<PendingEnrollment> {
  const pem = await readKey(deps.state);
  if (!pem) throw new MachineEnrollError('The enrollment key is missing');
  const privateKey = createPrivateKey(pem);
  if (rawEd25519PublicKey(privateKey) !== pending.publicKey) throw new MachineEnrollError('The enrollment key does not match the journal');
  const body = signMachineEnrollmentRequest({
    publicKey: pending.publicKey, fingerprint: pending.fingerprint, runnerId: pending.runnerId,
    scope: pending.scope, selfReportedHost: options.host,
  }, privateKey, deps.now());
  let response: Response;
  try {
    response = await deps.fetch(`${pending.apiUrl}/auth/device/machine`, {
      method: 'POST', redirect: 'error', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
  } catch {
    throw new MachineEnrollError('Could not reach the API to start enrollment. Run the command again; it reuses this machine\'s key.');
  }
  const device = await readJson(response);
  if (!response.ok || !device || typeof device.device_code !== 'string' || typeof device.user_code !== 'string') {
    throw new MachineEnrollError(`Enrollment could not start (HTTP ${response.status}${typeof device?.detail === 'string' ? `: ${device.detail}` : ''}).`);
  }
  const next: PendingEnrollment = {
    ...pending, state: 'polling',
    device: {
      deviceCode: device.device_code, userCode: device.user_code,
      verificationUriComplete: String(device.verification_uri_complete ?? ''),
      expiresAt: new Date(deps.now().getTime() + Number(device.expires_in ?? 900) * 1000).toISOString(),
      interval: Number(device.interval ?? 5),
    },
  };
  await writePending(deps.state, next);
  return next;
}

async function poll(
  deps: MachineEnrollDeps, pending: PendingEnrollment, device: NonNullable<PendingEnrollment['device']>,
): Promise<{token: string; enrollmentId: string}> {
  let interval = Math.max(device.interval, 1) * 1000;
  let replyLost = false;
  const markUnknown = async () => {
    await writePending(deps.state, {...pending, state: 'delivery_unknown'});
    return new MachineEnrollError(`The approval for runner ${pending.runnerId} may have completed, but its reply was lost. `
      + 'Revoke that runner in the browser, then run again with --replace.');
  };
  while (deps.now().getTime() < Date.parse(device.expiresAt)) {
    await deps.sleep(interval);
    let response: Response;
    let body: Record<string, unknown> | null;
    try {
      response = await deps.fetch(`${pending.apiUrl}/auth/device/token`, {
        method: 'POST', redirect: 'error', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({device_code: device.deviceCode, grant_type: GRANT_TYPE}),
      });
      body = await readJson(response);
    } catch {
      replyLost = true;
      continue;
    }
    if (response.ok && body && typeof body.access_token === 'string') {
      const machine = body.machine as {enrollmentId?: unknown; runnerId?: unknown; publicKeyFingerprint?: unknown} | undefined;
      if (machine?.runnerId !== pending.runnerId || machine?.publicKeyFingerprint !== pending.fingerprint || typeof machine?.enrollmentId !== 'string') {
        throw new MachineEnrollError('The approved enrollment does not match this machine. Nothing was saved.');
      }
      return {token: body.access_token, enrollmentId: machine.enrollmentId};
    }
    const error = body?.error;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (error === 'expired_token' || error === 'access_denied') {
      if (replyLost) throw await markUnknown();
      await writePending(deps.state, {...pending, state: 'requesting', device: undefined});
      throw new MachineEnrollError(error === 'access_denied'
        ? 'The approval was denied.'
        : 'The approval code expired. Run the command again; it reuses this machine\'s key.');
    }
    // A server error or an unreadable reply may have carried the one-time token.
    replyLost = true;
  }
  if (replyLost) throw await markUnknown();
  await writePending(deps.state, {...pending, state: 'requesting', device: undefined});
  throw new MachineEnrollError('The approval code expired. Run the command again; it reuses this machine\'s key.');
}

export async function enrollMachine(deps: MachineEnrollDeps, options: MachineEnrollOptions): Promise<MachineEnrollResult> {
  const started = await startOrResume(deps, options);
  let pending = started.pending;
  const deviceLive = pending.state === 'polling' && pending.device && Date.parse(pending.device.expiresAt) > deps.now().getTime();
  if (!deviceLive) pending = await requestDevice(deps, options, pending);
  const device = pending.device;
  if (!device) throw new MachineEnrollError('Enrollment did not start; run the command again');
  deps.log(`Machine key fingerprint: ${pending.fingerprint}`);
  deps.log(`Runner: ${pending.runnerId}`);
  deps.log(`Approve this machine in the browser with code ${device.userCode}: ${device.verificationUriComplete}`);
  const delivered = await poll(deps, pending, device);
  // The credential before the commit marker; machine.json last.
  await writeCredential(deps.state, delivered.token);
  await commitMachine(deps.state, {
    version: 1, apiUrl: pending.apiUrl, enrollmentId: delivered.enrollmentId, runnerId: pending.runnerId,
    fingerprint: pending.fingerprint, scope: pending.scope, ...(pending.setupId ? {setupId: pending.setupId} : {}),
    enrolledAt: deps.now().toISOString(),
  });
  return {enrollmentId: delivered.enrollmentId, runnerId: pending.runnerId, fingerprint: pending.fingerprint, qualified: false,
    ...(started.replaced ? {replaced: started.replaced} : {})};
}

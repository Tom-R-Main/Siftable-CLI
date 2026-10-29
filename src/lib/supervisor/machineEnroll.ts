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
  acquireStateLock,
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
  /**
   * With --replace, for state that cannot revoke itself (a lost delivery or a
   * partial directory): the runner the operator revoked in the browser, or
   * `unknown` when the state names none.
   */
  abandonRunner?: string;
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
async function revokeRecorded(deps: MachineEnrollDeps, options: MachineEnrollOptions, machine: MachineRecord): Promise<void> {
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
  if (response.ok) return;
  // A 401 means the old credential has expired or was revoked, so this machine can no longer revoke
  // its own enrollment. The owner revokes it in the browser and names it, as for a lost delivery.
  if (response.status === 401 && options.abandonRunner === machine.runnerId) return;
  throw new MachineEnrollError(`The old enrollment was not revoked (HTTP ${response.status}). Nothing was replaced. `
    + (response.status === 401
      ? `Its credential no longer works: revoke runner ${machine.runnerId} in the browser, then run again with --replace --abandon-runner ${machine.runnerId}.`
      : 'Run again with --replace.'));
}

async function startOrResume(deps: MachineEnrollDeps, options: MachineEnrollOptions):
  Promise<{pending: PendingEnrollment; replaced?: MachineEnrollResult['replaced']} | {delivered: PendingEnrollment}> {
  await ensureStateDirectory(deps.state);
  let state = await inspectMachineState(deps.state);
  let replaced: MachineEnrollResult['replaced'];
  // An earlier run saved the token and stopped before its commit: finish that enrollment.
  if (state.kind === 'delivered') return {delivered: state.pending};
  if (state.kind === 'enrolled') {
    if (!options.replace) {
      throw new MachineEnrollError(`This machine is already enrolled (runner ${state.machine.runnerId}). Use --replace to enroll it again.`);
    }
    await revokeRecorded(deps, options, state.machine);
    replaced = {enrollmentId: state.machine.enrollmentId, retiredTo: await retireMachineState(deps.state, deps.now())};
    state = {kind: 'empty'};
  } else if (state.kind === 'partial') {
    // A partial directory may hold a live enrollment this command cannot revoke.
    requireAbandon(options, 'unknown', `${deps.state.root} holds a partial enrollment (${state.present.join(', ')}). `
      + 'If you approved a machine from it, revoke that runner in the browser.');
    await retireMachineState(deps.state, deps.now());
    state = {kind: 'empty'};
  } else if (state.kind === 'pending') {
    if (state.pending.state === 'delivered') {
      // The token was handed out and the run stopped before saving it: it is gone, the enrollment is live.
      requireAbandon(options, state.pending.runnerId, `Enrollment ${state.pending.enrollmentId} for runner ${state.pending.runnerId} `
        + 'was approved, but its credential was lost before it was saved. Revoke that runner in the browser.');
      await retireMachineState(deps.state, deps.now());
      state = {kind: 'empty'};
    } else if (state.pending.state === 'delivery_unknown') {
      requireAbandon(options, state.pending.runnerId, `An approval for runner ${state.pending.runnerId} may have completed, `
        + 'but its credential was lost. Revoke that runner in the browser.');
      await retireMachineState(deps.state, deps.now());
      state = {kind: 'empty'};
    } else if (state.pending.apiUrl !== options.apiUrl || !sameScope(state.pending.scope, options.scope)) {
      if (!options.replace) throw new MachineEnrollError('An enrollment for a different API or workspace is in progress. Run again with --replace to start over.');
      // Never approved here, or its device code is still open: either way no credential exists yet.
      if (state.pending.state === 'polling') {
        requireAbandon(options, state.pending.runnerId, `An approval for runner ${state.pending.runnerId} may be in progress. `
          + 'If you approved it, revoke that runner in the browser.');
      }
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

/** Starting over from state that cannot revoke itself needs the operator to name what they revoked. */
function requireAbandon(options: MachineEnrollOptions, runnerId: string, problem: string): void {
  if (options.replace && options.abandonRunner === runnerId) return;
  throw new MachineEnrollError(`${problem} Then run again with --replace --abandon-runner ${runnerId}.`);
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
  deps: MachineEnrollDeps, pending: PendingEnrollment, device: NonNullable<PendingEnrollment['device']>, resumed: boolean,
): Promise<{token: string; enrollmentId: string}> {
  let interval = Math.max(device.interval, 1) * 1000;
  // A journal still polling from an earlier run may have had its one-time token consumed by that run.
  let replyLost = resumed;
  const markUnknown = async () => {
    await writePending(deps.state, {...pending, state: 'delivery_unknown'});
    return new MachineEnrollError(`The approval for runner ${pending.runnerId} may have completed, but its reply was lost. `
      + `If you approved it, revoke that runner in the browser. Then run again with --replace --abandon-runner ${pending.runnerId}.`);
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
  await ensureStateDirectory(deps.state);
  const release = await acquireStateLock(deps.state);
  try {
    return await enrollLocked(deps, options);
  } finally {
    await release();
  }
}

async function commitDelivered(deps: MachineEnrollDeps, pending: PendingEnrollment, enrollmentId: string): Promise<void> {
  await commitMachine(deps.state, {
    version: 1, apiUrl: pending.apiUrl, enrollmentId, runnerId: pending.runnerId,
    fingerprint: pending.fingerprint, scope: pending.scope, ...(pending.setupId ? {setupId: pending.setupId} : {}),
    enrolledAt: deps.now().toISOString(),
  });
}

async function enrollLocked(deps: MachineEnrollDeps, options: MachineEnrollOptions): Promise<MachineEnrollResult> {
  const started = await startOrResume(deps, options);
  if ('delivered' in started) {
    const {delivered} = started;
    await commitDelivered(deps, delivered, delivered.enrollmentId as string);
    deps.log(`Finished the enrollment an earlier run received: runner ${delivered.runnerId}.`);
    return {enrollmentId: delivered.enrollmentId as string, runnerId: delivered.runnerId, fingerprint: delivered.fingerprint, qualified: false};
  }
  let pending = started.pending;
  const resumed = pending.state === 'polling';
  if (resumed && !(pending.device && Date.parse(pending.device.expiresAt) > deps.now().getTime())) {
    // The earlier run's code expired with no reply on record: its approval may have been delivered.
    await writePending(deps.state, {...pending, state: 'delivery_unknown'});
    throw new MachineEnrollError(`The approval for runner ${pending.runnerId} may have completed during an earlier run. `
      + `If you approved it, revoke that runner in the browser. Then run again with --replace --abandon-runner ${pending.runnerId}.`);
  }
  if (!resumed) pending = await requestDevice(deps, options, pending);
  const device = pending.device;
  if (!device) throw new MachineEnrollError('Enrollment did not start; run the command again');
  deps.log(`Machine key fingerprint: ${pending.fingerprint}`);
  deps.log(`Runner: ${pending.runnerId}`);
  deps.log(`Approve this machine in the browser with code ${device.userCode}: ${device.verificationUriComplete}`);
  const delivered = await poll(deps, pending, device, resumed);
  // The enrollment id first, so a stop before the commit is recoverable; then the credential; machine.json last.
  const recorded: PendingEnrollment = {...pending, state: 'delivered', enrollmentId: delivered.enrollmentId};
  await writePending(deps.state, recorded);
  await writeCredential(deps.state, delivered.token);
  await commitDelivered(deps, recorded, delivered.enrollmentId);
  return {enrollmentId: delivered.enrollmentId, runnerId: pending.runnerId, fingerprint: pending.fingerprint, qualified: false,
    ...(started.replaced ? {replaced: started.replaced} : {})};
}

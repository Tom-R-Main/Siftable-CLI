/**
 * Enrollment of a Siftable-hosted machine (hosted-machines-v1.md, H3). The
 * controller runs these over SSM, as root, on the instance it started:
 *
 *   sift machine keygen --hosted <id>   creates the machine key, or loads it,
 *                                       and prints only the public key; the
 *                                       controller binds it on the server
 *   sift machine enroll --hosted <id>   proves it holds that key and is that
 *                                       instance, and saves the credential
 *
 * Nothing secret is passed in: the key is made here and never leaves the state
 * directory, and the credential arrives in the enrollment reply. A credential
 * is saved only if its generation is higher than the one already saved, so a
 * late reply never replaces a newer credential.
 *
 * The signed payloads must match the server's byte for byte
 * (exf-app/src/services/hostedMachineEnrollment.ts); both sides test the same
 * literal strings.
 */
import {createPrivateKey, sign, type KeyObject} from 'node:crypto';
import {generateMachineKey, machineKeyFingerprint, type MachineScope, rawEd25519PublicKey} from './machineProtocol.js';
import {
  acquireStateLock,
  commitMachine,
  ensureStateDirectory,
  inspectMachineState,
  type MachineRecord,
  type MachineStateOptions,
  readCredentialRecord,
  readKey,
  updateMachine,
  writeCredentialRecord,
  writeKey,
} from './machineState.js';
import {fetchOwnEnrollment, MachineEnrollError} from './machineEnroll.js';

export const HOSTED_CHALLENGE_CONTEXT = 'sift.machine.hosted.challenge.v1';
export const HOSTED_ENROLLMENT_CONTEXT = 'sift.machine.hosted.enrollment.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function hostedChallengeRequestPayload(input: {hostedMachineId: string; fingerprint: string; issuedAt: string}): string {
  return JSON.stringify({context: HOSTED_CHALLENGE_CONTEXT, hostedMachineId: input.hostedMachineId, fingerprint: input.fingerprint, issuedAt: input.issuedAt});
}

export function hostedEnrollmentPayload(input: {
  hostedMachineId: string; runnerId: string; fingerprint: string; nonce: string; credentialGeneration: number;
}): string {
  return JSON.stringify({context: HOSTED_ENROLLMENT_CONTEXT, hostedMachineId: input.hostedMachineId, runnerId: input.runnerId,
    fingerprint: input.fingerprint, nonce: input.nonce, credentialGeneration: input.credentialGeneration});
}

/** The instance identity document and its base64 signature, as IMDSv2 serves them. */
export interface InstanceIdentity {document: string; signature: string}

const IMDS = 'http://169.254.169.254';

/** Reads the identity document over IMDSv2 (token first); the document's bytes are kept exactly. */
export async function readInstanceIdentity(fetchImpl: typeof fetch): Promise<InstanceIdentity> {
  const signal = AbortSignal.timeout(5_000);
  const token = await fetchImpl(`${IMDS}/latest/api/token`, {
    method: 'PUT', redirect: 'error', signal, headers: {'X-aws-ec2-metadata-token-ttl-seconds': '60'},
  });
  if (!token.ok) throw new MachineEnrollError(`The instance metadata service refused a token (HTTP ${token.status}).`);
  const headers = {'X-aws-ec2-metadata-token': await token.text()};
  const read = async (pathname: string) => {
    const response = await fetchImpl(`${IMDS}${pathname}`, {method: 'GET', redirect: 'error', signal, headers});
    if (!response.ok) throw new MachineEnrollError(`The instance metadata service did not return ${pathname} (HTTP ${response.status}).`);
    return response.text();
  };
  return {document: await read('/latest/dynamic/instance-identity/document'), signature: await read('/latest/dynamic/instance-identity/signature')};
}

function assertHostedId(hostedMachineId: string): void {
  if (!UUID.test(hostedMachineId)) throw new MachineEnrollError('--hosted must be the hosted machine id');
}

/** Loads the machine key, or creates it, and returns its public key (base64 of the raw 32 bytes). */
export async function hostedKeygen(state: MachineStateOptions, hostedMachineId: string): Promise<{publicKey: string; fingerprint: string}> {
  assertHostedId(hostedMachineId);
  await ensureStateDirectory(state);
  const release = await acquireStateLock(state);
  try {
    const current = await inspectMachineState(state);
    if (current.kind === 'enrolled' && current.machine.hostedMachineId !== hostedMachineId) {
      throw new MachineEnrollError('This machine is already enrolled for something else; a hosted machine starts with empty state.');
    }
    // A key alone is what an earlier keygen left; anything else unfinished is a device enrollment.
    const keyOnly = current.kind === 'partial' && current.present.length === 1 && current.present[0] === 'enrollment-key.pem';
    if (current.kind === 'pending' || current.kind === 'delivered' || (current.kind === 'partial' && !keyOnly)) {
      throw new MachineEnrollError('This machine has an unfinished device enrollment; a hosted machine starts with empty state.');
    }
    const existing = await readKey(state);
    const privateKey = existing ? createPrivateKey(existing) : await (async () => {
      const generated = generateMachineKey();
      await writeKey(state, generated.pem);
      return generated.privateKey;
    })();
    const publicKey = rawEd25519PublicKey(privateKey);
    return {publicKey, fingerprint: machineKeyFingerprint(publicKey)};
  } finally {
    await release();
  }
}

export interface HostedEnrollDeps {
  fetch: typeof fetch;
  state: MachineStateOptions;
  now: () => Date;
  identity: () => Promise<InstanceIdentity>;
}

export interface HostedEnrollResult {
  enrollmentId: string;
  runnerId: string;
  fingerprint: string;
  credentialGeneration: number;
  /** False when a newer credential was already saved and this reply's was discarded. */
  saved: boolean;
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {method: 'POST', redirect: 'error', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  } catch {
    throw new MachineEnrollError(`No reply from ${url}; run the command again.`);
  }
  const parsed = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !parsed) {
    throw new MachineEnrollError(response.status === 403 ? 'The server refused this machine\'s enrollment.' : `Enrollment failed (HTTP ${response.status}).`);
  }
  return parsed;
}

function signed(privateKey: KeyObject, payload: string): string {
  return sign(null, Buffer.from(payload), privateKey).toString('base64url');
}

/** Enrolls with the bound key, or, after a lost reply, gets the rotated credential. */
export async function hostedEnroll(deps: HostedEnrollDeps, options: {apiUrl: string; hostedMachineId: string}): Promise<HostedEnrollResult> {
  assertHostedId(options.hostedMachineId);
  const {apiUrl, hostedMachineId} = options;
  await ensureStateDirectory(deps.state);
  const release = await acquireStateLock(deps.state);
  try {
    const pem = await readKey(deps.state);
    if (!pem) throw new MachineEnrollError('No machine key; run sift machine keygen --hosted first.');
    const privateKey = createPrivateKey(pem);
    const publicKey = rawEd25519PublicKey(privateKey);
    const fingerprint = machineKeyFingerprint(publicKey);

    const issuedAt = deps.now().toISOString();
    const challenge = await postJson(deps.fetch, `${apiUrl}/auth/device/machine/hosted/challenge`, {
      hostedMachineId, publicKey, issuedAt, signature: signed(privateKey, hostedChallengeRequestPayload({hostedMachineId, fingerprint, issuedAt})),
    });
    const {nonce, credentialGeneration, runnerId} = challenge;
    if (typeof nonce !== 'string' || typeof credentialGeneration !== 'number' || typeof runnerId !== 'string') {
      throw new MachineEnrollError('The server sent an unexpected challenge.');
    }
    const identity = await deps.identity();
    const enrolled = await postJson(deps.fetch, `${apiUrl}/auth/device/machine/hosted`, {
      hostedMachineId, publicKey, nonce, credentialGeneration, identityDocument: identity.document, identitySignature: identity.signature,
      signature: signed(privateKey, hostedEnrollmentPayload({hostedMachineId, runnerId, fingerprint, nonce, credentialGeneration})),
    });
    const token = enrolled.access_token;
    const generation = enrolled.credential_generation;
    const machine = enrolled.machine as {enrollmentId?: unknown; runnerId?: unknown; publicKeyFingerprint?: unknown; orgId?: unknown} | undefined;
    if (typeof token !== 'string' || typeof generation !== 'number' || !machine || typeof machine.enrollmentId !== 'string'
      || machine.runnerId !== runnerId || machine.publicKeyFingerprint !== fingerprint) {
      throw new MachineEnrollError('The server described a different machine than this one.');
    }

    // Keep only the newest credential: a late reply with an older generation is discarded.
    const saved = await readCredentialRecord(deps.state);
    if (saved && typeof saved.generation === 'number' && saved.generation >= generation) {
      return {enrollmentId: machine.enrollmentId, runnerId, fingerprint, credentialGeneration: saved.generation, saved: false};
    }
    await writeCredentialRecord(deps.state, {token, generation});
    const scope: MachineScope = typeof machine.orgId === 'string' ? {type: 'workspace', id: machine.orgId} : {type: 'user'};
    const record: MachineRecord = {version: 1, apiUrl, enrollmentId: machine.enrollmentId, runnerId, fingerprint, scope,
      enrolledAt: deps.now().toISOString(), hostedMachineId};
    const current = await inspectMachineState(deps.state);
    if (current.kind === 'enrolled') await updateMachine(deps.state, {...current.machine, ...record, enrolledAt: current.machine.enrolledAt});
    else await commitMachine(deps.state, record);
    // The supervisor binds qualification challenges to its credential id, read with the credential itself.
    const own = await fetchOwnEnrollment(deps.fetch, record, token);
    await updateMachine(deps.state, {...record, credentialId: own.credentialId});
    return {enrollmentId: machine.enrollmentId, runnerId, fingerprint, credentialGeneration: generation, saved: true};
  } finally {
    await release();
  }
}

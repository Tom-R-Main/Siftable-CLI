/**
 * The machine supervisor enrollment protocol, client side (first-run U2c).
 *
 * The published CLI does not depend on @execufunction/shared, so this file
 * keeps its own copy of the server's `machineSupervisorProofBinding`
 * (exf-app/src/services/machineSupervisorDeviceFlow.ts). A golden vector in
 * both packages' tests pins the two to the same bytes.
 */
import {createHash, createPublicKey, generateKeyPairSync, type KeyObject, randomBytes, sign} from 'node:crypto';

export const MACHINE_SUPERVISOR_PROOF_CONTEXT = 'sift.machine.supervisor.enrollment.v1';

export type MachineScope = {type: 'user'} | {type: 'workspace'; id: string};

export interface MachineHostLabels {
  hostname?: string;
  os: string;
  arch: string;
  agentVersion?: string;
}

export interface MachineEnrollmentRequest {
  publicKey: string;
  fingerprint: string;
  runnerId: string;
  scope: MachineScope;
  selfReportedHost: MachineHostLabels;
  proof: {nonce: string; issuedAt: string; signature: string};
}

/** The exact bytes the server verifies. Key order matters: keep it identical to the server's. */
export function machineSupervisorProofBinding(
  input: Omit<MachineEnrollmentRequest, 'proof'>,
  proof: {nonce: string; issuedAt: string},
): string {
  return JSON.stringify({
    context: MACHINE_SUPERVISOR_PROOF_CONTEXT,
    keyType: 'ed25519',
    publicKey: input.publicKey,
    fingerprint: input.fingerprint,
    runnerId: input.runnerId,
    scope: input.scope.type === 'workspace' ? {type: 'workspace', id: input.scope.id} : {type: 'user'},
    selfReportedHost: {
      hostname: input.selfReportedHost.hostname ?? null,
      os: input.selfReportedHost.os,
      arch: input.selfReportedHost.arch,
      agentVersion: input.selfReportedHost.agentVersion ?? null,
    },
    nonce: proof.nonce,
    issuedAt: proof.issuedAt,
  });
}

/** The raw 32-byte public key of an Ed25519 key, base64. */
export function rawEd25519PublicKey(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({format: 'der', type: 'spki'});
  return spki.subarray(spki.length - 32).toString('base64');
}

export function machineKeyFingerprint(publicKeyBase64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex');
}

export function generateMachineKey(): {privateKey: KeyObject; pem: string} {
  const {privateKey} = generateKeyPairSync('ed25519');
  return {privateKey, pem: privateKey.export({format: 'pem', type: 'pkcs8'}).toString()};
}

/** Host labels are shown to the approver only. Values are kept within the server's printable 1–128 limit. */
export function machineHostLabels(input: {hostname?: string; os: string; arch: string; agentVersion?: string}): MachineHostLabels {
  const clean = (value: string | undefined) => {
    const printable = (value ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 128);
    return printable.length > 0 ? printable : undefined;
  };
  return {
    ...(clean(input.hostname) ? {hostname: clean(input.hostname)} : {}),
    os: clean(input.os) ?? 'unknown',
    arch: clean(input.arch) ?? 'unknown',
    ...(clean(input.agentVersion) ? {agentVersion: clean(input.agentVersion)} : {}),
  };
}

/**
 * A signed request. The key and runner id stay the same across retries of one
 * enrollment; each request gets a fresh nonce and time, since the server
 * accepts a proof once and only within five minutes.
 */
export function signMachineEnrollmentRequest(
  unsigned: Omit<MachineEnrollmentRequest, 'proof'>,
  privateKey: KeyObject,
  now: Date = new Date(),
): MachineEnrollmentRequest {
  const proofFields = {nonce: randomBytes(32).toString('base64url'), issuedAt: now.toISOString()};
  const signature = sign(null, Buffer.from(machineSupervisorProofBinding(unsigned, proofFields)), privateKey).toString('base64url');
  return {...unsigned, proof: {...proofFields, signature}};
}

export function parseMachineScope(value: string): MachineScope {
  if (value === 'personal') return {type: 'user'};
  const id = value.startsWith('workspace:') ? value.slice('workspace:'.length) : value;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('--workspace must be personal or a workspace UUID');
  }
  return {type: 'workspace', id};
}

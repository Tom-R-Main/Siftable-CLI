import {
  constants as cryptoConstants,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';

export const ENVIRONMENT_ENDPOINT_CLASSES = [
  'interactive_desktop', 'remote_vm', 'noninteractive_runner', 'shared_host',
  'ci_runner', 'production_host', 'multi_tenant',
] as const;
export type EnvironmentEndpointClass = typeof ENVIRONMENT_ENDPOINT_CLASSES[number];

export const ENVIRONMENT_ENDPOINT_STORAGE_TIERS = [
  'hardware_host_bound', 'systemd_managed', 'convenience_keyring', 'none',
] as const;
export type EnvironmentEndpointStorageTier = typeof ENVIRONMENT_ENDPOINT_STORAGE_TIERS[number];

export interface EnvironmentEndpointEnrollmentRequest {
  publicKey: string;
  fingerprint: string;
  endpointClass: EnvironmentEndpointClass;
  storageTier: EnvironmentEndpointStorageTier;
  owner: {type: 'user'} | {type: 'workspace'; id: string};
  selfReportedHost: {hostname?: string; os: string; arch: string; agentVersion?: string};
  dedicated: boolean;
  killSwitchEnabled: boolean;
  proof: EnvironmentEndpointEnrollmentProof;
}

export interface EnvironmentEndpointEnrollmentProof {
  nonce: string;
  issuedAt: string;
  signature: string;
}

export interface EnvironmentEndpointPendingResult {
  status: 'authorization_pending';
  endpointFingerprint: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export function environmentEndpointPendingResult(input: {
  endpointFingerprint: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}): EnvironmentEndpointPendingResult {
  return {status: 'authorization_pending', ...input};
}

type UnsignedEnvironmentEndpointEnrollmentRequest = Omit<
  EnvironmentEndpointEnrollmentRequest,
  'proof'
>;

export function environmentEndpointEnrollmentProofBinding(
  input: UnsignedEnvironmentEndpointEnrollmentRequest,
  proof: Pick<EnvironmentEndpointEnrollmentProof, 'nonce' | 'issuedAt'>,
): string {
  return JSON.stringify({
    proofContext: 'sift.vault.endpoint.enrollment.v1',
    publicKey: input.publicKey,
    fingerprint: input.fingerprint,
    endpointClass: input.endpointClass,
    storageTier: input.storageTier,
    owner: input.owner.type === 'workspace'
      ? {type: 'workspace', id: input.owner.id}
      : {type: 'user'},
    selfReportedHost: {
      hostname: input.selfReportedHost.hostname ?? null,
      os: input.selfReportedHost.os,
      arch: input.selfReportedHost.arch,
      agentVersion: input.selfReportedHost.agentVersion ?? null,
    },
    dedicated: input.dedicated,
    killSwitchEnabled: input.killSwitchEnabled,
    proofNonce: proof.nonce,
    proofIssuedAt: proof.issuedAt,
  });
}

export function signEnvironmentEndpointEnrollmentRequest(
  input: UnsignedEnvironmentEndpointEnrollmentRequest,
  privateKey: KeyObject,
  now = new Date(),
): EnvironmentEndpointEnrollmentRequest {
  const proof = {
    nonce: randomBytes(32).toString('base64url'),
    issuedAt: now.toISOString(),
  };
  return {
    ...input,
    proof: {
      ...proof,
      signature: sign(
        'sha256',
        Buffer.from(environmentEndpointEnrollmentProofBinding(input, proof)),
        {
          key: privateKey,
          padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
          saltLength: 32,
        },
      ).toString('base64url'),
    },
  };
}

export function buildEnvironmentEndpointEnrollmentRequest(input: {
  publicKey: string;
  fingerprint: string;
  endpointClass: EnvironmentEndpointClass;
  storageTier: EnvironmentEndpointStorageTier;
  owner: string;
  host: EnvironmentEndpointEnrollmentRequest['selfReportedHost'];
  dedicated: boolean;
  killSwitchEnabled: boolean;
}): UnsignedEnvironmentEndpointEnrollmentRequest {
  if (!/^[0-9a-f]{64}$/.test(input.fingerprint)) {
    throw new Error('Endpoint fingerprint must be a full SHA-256 digest');
  }
  if (!input.publicKey.includes('BEGIN PUBLIC KEY')) {
    throw new Error('Endpoint enrollment requires an SPKI public key');
  }
  const owner = input.owner === 'personal'
    ? {type: 'user' as const}
    : input.owner.startsWith('workspace:') && input.owner.slice(10)
      ? {type: 'workspace' as const, id: input.owner.slice(10)}
      : null;
  if (!owner) throw new Error('Owner must be personal or workspace:<uuid>');
  return {
    publicKey: input.publicKey,
    fingerprint: input.fingerprint,
    endpointClass: input.endpointClass,
    storageTier: input.storageTier,
    owner,
    selfReportedHost: input.host,
    dedicated: input.dedicated,
    killSwitchEnabled: input.killSwitchEnabled,
  };
}

export function assertEndpointStorageImplementation(input: {
  platform: NodeJS.Platform;
  storageTier: EnvironmentEndpointStorageTier;
  systemdCredentialStoreAvailable?: boolean;
  secretServiceKeyringAvailable?: boolean;
}): void {
  if (input.platform === 'darwin' && input.storageTier === 'convenience_keyring') return;
  if (
    input.platform === 'linux'
    && input.storageTier === 'systemd_managed'
    && input.systemdCredentialStoreAvailable
  ) return;
  if (
    input.platform === 'linux'
    && input.storageTier === 'convenience_keyring'
    && input.secretServiceKeyringAvailable
  ) return;
  if (input.storageTier === 'none') return;
  throw new Error(
    `The ${input.storageTier} identity store is not available on ${input.platform}; enrollment fails closed.`,
  );
}

export function environmentEndpointClientCapabilities(
  surface: 'cli' | 'mcp_local' | 'mcp_hosted',
): {request: true; status: true; redeem: boolean} {
  return {request: true, status: true, redeem: surface !== 'mcp_hosted'};
}

export type EnvironmentEndpointRecovery =
  | 'tpm_pcr_reseal'
  | 'cloned_disk'
  | 'rebuilt_vm'
  | 'lost_keyring'
  | 'hostname_drift'
  | 'clock_skew'
  | 'endpoint_rename'
  | 'endpoint_loss';

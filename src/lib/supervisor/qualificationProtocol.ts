/**
 * The machine qualification protocol, client side (first-run U2d-1).
 *
 * The published CLI ships without the monorepo's shared contracts package, so
 * this file keeps its own copy of the server's qualification constants, its
 * canonical JSON and its signed payload. Golden vectors in this package's
 * tests and in exf-app's pin the two copies to the same bytes.
 */

export const MACHINE_QUALIFICATION_CONTEXT = 'sift.machine.supervisor.qualification.v1';
export const MACHINE_QUALIFICATION_PURPOSE = 'qualification';
export const MACHINE_QUALIFICATION_VERSION = 1;

export const MACHINE_ISOLATION_PROFILE_V1 = {
  version: 1,
  user: 'unprivileged',
  readOnlyRoot: true,
  noNewPrivileges: true,
  hostHome: false,
  dockerSocket: false,
  network: 'relay_only',
  repository: 'read_only_except_write_scope',
  cgroup: 'per_attempt',
} as const;
export type MachineIsolationProfile = typeof MACHINE_ISOLATION_PROFILE_V1;

export const MACHINE_REQUIRED_PROBES = {
  read_supervisor_credential: 'blocked',
  reach_provider_direct: 'blocked',
  open_docker_socket: 'blocked',
  see_host_processes: 'blocked',
  reach_relay: 'reached',
} as const;
export type MachineProbeId = keyof typeof MACHINE_REQUIRED_PROBES;
export type MachineProbeOutcome = 'blocked' | 'reached' | 'error';

export const MACHINE_PROBE_CODES = [
  'ok', 'permission_denied', 'not_found', 'connection_refused', 'timeout',
  'network_unreachable', 'read_succeeded', 'connect_succeeded', 'unexpected_error',
] as const;
export type MachineProbeCode = (typeof MACHINE_PROBE_CODES)[number];

export interface MachineQualificationTemplate {
  probeSchemaVersion: 1;
  isolationProfileVersion: 1;
  isolationProfile: MachineIsolationProfile;
  imageRef: string;
}

export interface MachineQualificationBinding {
  context: typeof MACHINE_QUALIFICATION_CONTEXT;
  purpose: typeof MACHINE_QUALIFICATION_PURPOSE;
  version: typeof MACHINE_QUALIFICATION_VERSION;
  challengeId: string;
  userId: string;
  orgId: string | null;
  enrollmentId: string;
  runnerId: string;
  keyFingerprint: string;
  enrolledTokenId: string;
  templateDigest: string;
  expiresAt: string;
}

export interface MachineQualificationReport {
  probes: Record<MachineProbeId, {outcome: MachineProbeOutcome; code: MachineProbeCode}>;
  observedImageRef: string;
  observedIsolation: Record<string, string | number | boolean>;
  completedAt: string;
}

/** JSON with object keys sorted and no whitespace; plain data only. */
export function machineCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON has no non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(machineCanonicalJson).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${machineCanonicalJson(item)}`).join(',')}}`;
  }
  throw new Error('Canonical JSON accepts only plain data');
}

/** The exact bytes the supervisor signs: the binding the server issued, the nonce and the report's digest. */
export function machineQualificationSignedPayload(binding: MachineQualificationBinding, nonce: string, resultDigest: string): string {
  return machineCanonicalJson({binding, nonce, resultDigest});
}

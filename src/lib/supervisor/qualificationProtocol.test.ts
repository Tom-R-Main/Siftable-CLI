import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {
  MACHINE_ISOLATION_PROFILE_V1,
  machineCanonicalJson,
  type MachineQualificationBinding,
  type MachineQualificationReport,
  machineQualificationSignedPayload,
} from './qualificationProtocol.js';

/**
 * Golden vector. exf-app's machineQualificationService.vitest.ts asserts the
 * same three digests from the server's implementation; change both or neither.
 */
const IMAGE = `registry.example/sift-agent@sha256:${'a'.repeat(64)}`;
const BINDING: MachineQualificationBinding = {
  context: 'sift.machine.supervisor.qualification.v1', purpose: 'qualification', version: 1,
  challengeId: '44444444-4444-4444-8444-444444444444', userId: '22222222-2222-4222-8222-222222222222', orgId: null,
  enrollmentId: '33333333-3333-4333-8333-333333333333', runnerId: '7a0c2a59-4f3e-4c1d-9b2e-5d6f7a8b9c0d',
  keyFingerprint: 'f'.repeat(64), enrolledTokenId: '55555555-5555-4555-8555-555555555555',
  templateDigest: 'd'.repeat(64), expiresAt: '2026-10-29T05:10:00.000Z',
};
const REPORT: MachineQualificationReport = {
  probes: {
    read_supervisor_credential: {outcome: 'blocked', code: 'permission_denied'},
    reach_provider_direct: {outcome: 'blocked', code: 'network_unreachable'},
    open_docker_socket: {outcome: 'blocked', code: 'not_found'},
    see_host_processes: {outcome: 'blocked', code: 'ok'},
    reach_relay: {outcome: 'reached', code: 'ok'},
  },
  observedImageRef: IMAGE, observedIsolation: {...MACHINE_ISOLATION_PROFILE_V1}, completedAt: '2026-10-29T05:00:00.000Z',
};
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('qualification protocol golden vector', () => {
  it('canonicalizes the report, the signed payload and the template to the server\'s bytes', () => {
    const resultDigest = sha256(machineCanonicalJson(REPORT));
    expect(resultDigest).toBe('aee1d3e833025529b741b2ea23de29767679b1c806ff1414ecf425f041624bd5');
    expect(sha256(machineQualificationSignedPayload(BINDING, 'n'.repeat(43), resultDigest)))
      .toBe('cf162eee1a302d6eb6a84314d6e737eb24475d7ebe6558fdce79816195b80a09');
    expect(sha256(machineCanonicalJson({probeSchemaVersion: 1, isolationProfileVersion: 1, isolationProfile: MACHINE_ISOLATION_PROFILE_V1, imageRef: IMAGE})))
      .toBe('d796230ebe6a327d123cd211a9c8034db1534558ef11dcb3d88a0ee7934c2806');
  });

  it('refuses anything but plain data', () => {
    expect(() => machineCanonicalJson({at: new Date()})).toThrow(/plain data/);
  });
});

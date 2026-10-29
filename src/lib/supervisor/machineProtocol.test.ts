import {createPublicKey, verify} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {
  generateMachineKey,
  machineHostLabels,
  machineKeyFingerprint,
  machineSupervisorProofBinding,
  parseMachineScope,
  rawEd25519PublicKey,
  signMachineEnrollmentRequest,
} from './machineProtocol.js';

/**
 * The golden vector. exf-app's machineSupervisorDeviceFlow.vitest.ts asserts
 * the same bytes from the server's implementation; change both or neither.
 */
const MACHINE_ENROLLMENT_GOLDEN = {
  input: {
    publicKey: `${'A'.repeat(43)}=`,
    fingerprint: 'f'.repeat(64),
    runnerId: '7a0c2a59-4f3e-4c1d-9b2e-5d6f7a8b9c0d',
    scope: {type: 'workspace' as const, id: '11111111-2222-4333-8444-555555555555'},
    selfReportedHost: {hostname: 'vm-01', os: 'linux', arch: 'x64'},
  },
  proof: {nonce: 'n'.repeat(43), issuedAt: '2026-10-29T02:00:00.000Z'},
  binding: '{"context":"sift.machine.supervisor.enrollment.v1","keyType":"ed25519",'
    + '"publicKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","fingerprint":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",'
    + '"runnerId":"7a0c2a59-4f3e-4c1d-9b2e-5d6f7a8b9c0d","scope":{"type":"workspace","id":"11111111-2222-4333-8444-555555555555"},'
    + '"selfReportedHost":{"hostname":"vm-01","os":"linux","arch":"x64","agentVersion":null},'
    + '"nonce":"nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn","issuedAt":"2026-10-29T02:00:00.000Z"}',
};

describe('machine enrollment protocol', () => {
  it('produces the golden binding bytes', () => {
    expect(machineSupervisorProofBinding(MACHINE_ENROLLMENT_GOLDEN.input, MACHINE_ENROLLMENT_GOLDEN.proof))
      .toBe(MACHINE_ENROLLMENT_GOLDEN.binding);
  });

  it('signs a request the stored raw key verifies, with a fresh nonce each time', () => {
    const key = generateMachineKey();
    const publicKey = rawEd25519PublicKey(key.privateKey);
    expect(publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    const unsigned = {
      publicKey, fingerprint: machineKeyFingerprint(publicKey), runnerId: MACHINE_ENROLLMENT_GOLDEN.input.runnerId,
      scope: {type: 'user' as const}, selfReportedHost: {os: 'linux', arch: 'x64'},
    };
    const first = signMachineEnrollmentRequest(unsigned, key.privateKey, new Date('2026-10-29T02:00:00Z'));
    const second = signMachineEnrollmentRequest(unsigned, key.privateKey, new Date('2026-10-29T02:00:00Z'));
    expect(first.proof.nonce).not.toBe(second.proof.nonce);
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]);
    const verifier = createPublicKey({key: spki, format: 'der', type: 'spki'});
    expect(verify(null, Buffer.from(machineSupervisorProofBinding(unsigned, first.proof)), verifier,
      Buffer.from(first.proof.signature, 'base64url'))).toBe(true);
  });

  it('keeps host labels printable and within the server limit', () => {
    expect(machineHostLabels({hostname: `vm\u0000-${'x'.repeat(200)}`, os: 'linux', arch: 'x64', agentVersion: ''}))
      .toEqual({hostname: `vm-${'x'.repeat(125)}`, os: 'linux', arch: 'x64'});
  });

  it('accepts personal or a workspace UUID', () => {
    expect(parseMachineScope('personal')).toEqual({type: 'user'});
    expect(parseMachineScope('workspace:11111111-2222-4333-8444-555555555555'))
      .toEqual({type: 'workspace', id: '11111111-2222-4333-8444-555555555555'});
    expect(() => parseMachineScope('acme')).toThrow(/workspace UUID/);
  });
});

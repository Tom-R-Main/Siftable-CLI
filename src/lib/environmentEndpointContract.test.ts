import {describe, expect, it} from 'vitest';
import {
  constants as cryptoConstants,
  generateKeyPairSync,
  verify,
} from 'node:crypto';
import {
  assertEndpointStorageImplementation,
  buildEnvironmentEndpointEnrollmentRequest,
  environmentEndpointClientCapabilities,
  environmentEndpointEnrollmentProofBinding,
  environmentEndpointPendingResult,
  signEnvironmentEndpointEnrollmentRequest,
} from './environmentEndpointContract.js';

describe('environment endpoint protocol', () => {
  const request = {
    publicKey: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n',
    fingerprint: 'a'.repeat(64),
    endpointClass: 'interactive_desktop' as const,
    storageTier: 'convenience_keyring' as const,
    owner: 'personal',
    host: {os: 'darwin', arch: 'arm64'},
    dedicated: false,
    killSwitchEnabled: false,
  };

  it('uses one enrollment wire shape on macOS and Linux', () => {
    expect(buildEnvironmentEndpointEnrollmentRequest(request)).toMatchObject({
      endpointClass: 'interactive_desktop',
      storageTier: 'convenience_keyring',
      owner: {type: 'user'},
      selfReportedHost: {os: 'darwin', arch: 'arm64'},
    });
    expect(buildEnvironmentEndpointEnrollmentRequest({
      ...request,
      endpointClass: 'noninteractive_runner',
      storageTier: 'systemd_managed',
      host: {os: 'linux', arch: 'x64'},
    })).toMatchObject({
      endpointClass: 'noninteractive_runner',
      storageTier: 'systemd_managed',
      selfReportedHost: {os: 'linux', arch: 'x64'},
    });
  });

  it('never labels convenience keyring as hardware-backed', () => {
    expect(() => assertEndpointStorageImplementation({
      platform: 'darwin', storageTier: 'hardware_host_bound',
    })).toThrow('not available');
    expect(() => assertEndpointStorageImplementation({
      platform: 'darwin', storageTier: 'convenience_keyring',
    })).not.toThrow();
  });

  it('requires an actual systemd-managed store on Linux', () => {
    expect(() => assertEndpointStorageImplementation({
      platform: 'linux', storageTier: 'systemd_managed', systemdCredentialStoreAvailable: false,
    })).toThrow('fails closed');
    expect(() => assertEndpointStorageImplementation({
      platform: 'linux', storageTier: 'systemd_managed', systemdCredentialStoreAvailable: true,
    })).not.toThrow();
  });

  it('supports honest Linux convenience and unprotected tiers', () => {
    expect(() => assertEndpointStorageImplementation({
      platform: 'linux', storageTier: 'convenience_keyring',
      secretServiceKeyringAvailable: true,
    })).not.toThrow();
    expect(() => assertEndpointStorageImplementation({
      platform: 'linux', storageTier: 'convenience_keyring',
      secretServiceKeyringAvailable: false,
    })).toThrow('fails closed');
    expect(() => assertEndpointStorageImplementation({
      platform: 'linux', storageTier: 'none',
    })).not.toThrow();
  });

  it('keeps hosted MCP request/status-only', () => {
    expect(environmentEndpointClientCapabilities('mcp_hosted')).toEqual({
      request: true, status: true, redeem: false,
    });
  });

  it('signs a fresh proof over the exact enrollment contract', () => {
    const pair = generateKeyPairSync('rsa', {modulusLength: 3072});
    const publicKey = pair.publicKey.export({type: 'spki', format: 'pem'}).toString();
    const unsigned = buildEnvironmentEndpointEnrollmentRequest({...request, publicKey});
    const signed = signEnvironmentEndpointEnrollmentRequest(
      unsigned,
      pair.privateKey,
      new Date('2026-08-12T00:00:00.000Z'),
    );
    expect(verify(
      'sha256',
      Buffer.from(environmentEndpointEnrollmentProofBinding(unsigned, signed.proof)),
      {
        key: pair.publicKey,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
      Buffer.from(signed.proof.signature, 'base64url'),
    )).toBe(true);
  });

  it('returns exact approval details to noninteractive JSON callers', () => {
    expect(environmentEndpointPendingResult({
      endpointFingerprint: 'a'.repeat(64),
      deviceCode: 'opaque-device-code',
      userCode: 'BCDF-GHJK',
      verificationUri: 'https://siftable.io/app/device',
      verificationUriComplete: 'https://siftable.io/app/device?code=BCDF-GHJK',
      expiresIn: 900,
      interval: 5,
    })).toEqual({
      status: 'authorization_pending',
      endpointFingerprint: 'a'.repeat(64),
      deviceCode: 'opaque-device-code',
      userCode: 'BCDF-GHJK',
      verificationUri: 'https://siftable.io/app/device',
      verificationUriComplete: 'https://siftable.io/app/device?code=BCDF-GHJK',
      expiresIn: 900,
      interval: 5,
    });
  });
});

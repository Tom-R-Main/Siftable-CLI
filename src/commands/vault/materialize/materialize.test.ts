import {describe, expect, it, vi} from 'vitest';
import VaultMaterializeRequest from './request.js';
import VaultMaterializeStatus from './status.js';

function command<T>(constructor: {prototype: T}): T {
  return Object.create(constructor.prototype) as T;
}

describe('Vault materialization CLI surface', () => {
  it('requests exact destination metadata and status without plaintext output', async () => {
    const request = command(VaultMaterializeRequest);
    const requestApi = vi.fn().mockResolvedValue({
      materialization: {
        id: 'materialization-1',
        approvalId: 'approval-1',
        destinationPath: '/workspace/runtime/credential',
      },
      artifactEnvelope: {algorithm: 'RSA-OAEP-256+A256GCM', ciphertext: 'opaque'},
      artifactBinding: 'opaque-binding',
    });
    (request as any).parse = vi.fn().mockResolvedValue({flags: {
      entry: 'entry-1',
      field: 'value',
      destination: '/workspace/runtime/credential',
      workspace: '/workspace',
      mode: '0600',
      purpose: 'Write migration credential',
      nonce: 'n'.repeat(32),
      overwrite: false,
      'tracked-exception': false,
      'runner-public-key': '/dev/null',
      'runner-fingerprint': 'a'.repeat(64),
      'materializer-digest': 'b'.repeat(64),
    }});
    (request as any).apiRequest = requestApi;
    (request as any).jsonEnabled = () => true;
    (request as any).log = vi.fn();
    const requested = await request.run();
    expect(requestApi).toHaveBeenCalledWith(
      expect.not.objectContaining({workspace: '/workspace'}),
      '/api/v1/vault/materializations',
      expect.objectContaining({body: expect.objectContaining({
        surface: 'cli',
        destinationPath: '/workspace/runtime/credential',
        plaintextDisclosureAcknowledged: true,
      })}),
    );

    const status = command(VaultMaterializeStatus);
    const statusApi = vi.fn().mockResolvedValue({
      materialization: {
        id: 'materialization-1',
        status: 'pending',
        destinationPath: '/workspace/runtime/credential',
        requestedMode: '0600',
      },
    });
    (status as any).parse = vi.fn().mockResolvedValue({
      args: {id: 'materialization-1'},
      flags: {},
    });
    (status as any).apiRequest = statusApi;
    (status as any).jsonEnabled = () => true;
    (status as any).log = vi.fn();
    const inspected = await status.run();
    expect(statusApi.mock.calls[0][1]).toContain('surface=cli');
    expect(JSON.stringify({requested, inspected})).not.toContain('SENTINEL_PLAINTEXT');
    expect(JSON.stringify(inspected)).not.toContain('artifactEnvelope');
  });
});

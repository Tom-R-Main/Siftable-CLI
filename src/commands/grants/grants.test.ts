import {describe, expect, it, vi} from 'vitest';
import GrantsAdapters from './adapters.js';
import GrantsStatus from './status.js';
import GrantsRequest from './request.js';

function command<T>(constructor: {prototype: T}): T {
  return Object.create(constructor.prototype) as T;
}

describe('execution grant CLI surfaces', () => {
  it('provides adapter list and safe status parity', async () => {
    const adapters = command(GrantsAdapters);
    const adaptersApi = vi.fn().mockResolvedValue({
      adapters: [
        {id: 'github_gh', tier: 'contained', operations: ['repo_view'], threatDisclosure: 'bounded'},
        {id: 'terraform_apply', tier: 'bounded_only', operations: ['apply'], threatDisclosure: 'plugins observe credentials'},
        {id: 'generic_process', tier: 'unsupported', operations: [], threatDisclosure: 'no generic injection'},
      ],
    });
    (adapters as any).parse = vi.fn().mockResolvedValue({flags: {}});
    (adapters as any).apiRequest = adaptersApi;
    (adapters as any).jsonEnabled = () => true;
    (adapters as any).log = vi.fn();
    const listed = await adapters.run();
    expect(adaptersApi.mock.calls[0][1]).toContain('/execution-grants/adapters');

    const status = command(GrantsStatus);
    const statusApi = vi.fn().mockResolvedValue({
      grant: {
        id: 'grant-1',
        status: 'pending',
        containmentTier: 'contained',
        expiresAt: '2026-07-23T22:00:00.000Z',
        threatDisclosure: 'bounded',
      },
    });
    (status as any).parse = vi.fn().mockResolvedValue({args: {id: 'grant-1'}, flags: {}});
    (status as any).apiRequest = statusApi;
    (status as any).jsonEnabled = () => true;
    (status as any).log = vi.fn();
    const inspected = await status.run();
    expect(statusApi.mock.calls[0][1]).toContain('surface=cli');
    expect(JSON.stringify({listed, inspected})).not.toContain('SENTINEL_SECRET');
  });

  it('binds requests to a supplied runner public key and fixed executable digest', async () => {
    const request = command(GrantsRequest);
    const api = vi.fn().mockResolvedValue({
      grant: {id: 'grant-1', approvalId: 'approval-1'},
      handleEnvelope: {algorithm: 'RSA-OAEP-256+A256GCM', ciphertext: 'opaque'},
      handleBinding: 'opaque-binding',
    });
    (request as any).parse = vi.fn().mockResolvedValue({
      flags: {
        'vault-entry': 'entry-1',
        'credential-field': 'githubApp',
        issuer: 'github_app_installation',
        adapter: 'github_gh',
        operation: 'repo_view',
        audience: 'api.github.com',
        scope: '{"repository":"owner/repo"}',
        purpose: 'Inspect repository metadata',
        'runner-public-key': '/dev/null',
        'runner-fingerprint': 'a'.repeat(64),
        executable: '/usr/local/bin/gh',
        'executable-digest': 'b'.repeat(64),
      },
    });
    (request as any).apiRequest = api;
    (request as any).jsonEnabled = () => true;
    (request as any).log = vi.fn();
    await request.run();
    expect(api).toHaveBeenCalledWith(expect.anything(), '/api/v1/vault/execution-grants', {
      method: 'POST',
      body: expect.objectContaining({
        surface: 'cli',
        runnerPublicKeyFingerprint: 'a'.repeat(64),
        executablePath: '/usr/local/bin/gh',
        executableDigest: 'b'.repeat(64),
      }),
    });
  });
});

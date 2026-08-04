import {describe, expect, it, vi} from 'vitest';
import VaultMaterializeRequest from './request.js';
import VaultMaterializeRevoke from './revoke.js';
import {
  destinationPathForMaterialization,
  withMaterializationPreflightRecovery,
} from './run.js';
import VaultMaterializeStatus from './status.js';
import {
  assertCanonicalApprovalUrl,
  assertMaterializationSourceField,
  ownerFlagsForMaterializationSource,
  withMaterializationFailureRecovery,
  withMaterializationRecovery,
  withMaterializationSourceRecovery,
} from '../materialization-source.js';

function command<T>(constructor: {prototype: T}): T {
  return Object.create(constructor.prototype) as T;
}

describe('Vault materialization CLI surface', () => {
  it('canonicalizes relative destinations and explains why no approval exists after local rejection', () => {
    expect(destinationPathForMaterialization(
      '.supervise-inputs/corpus-key',
      '/private/tmp/checkout',
    )).toBe('/private/tmp/checkout/.supervise-inputs/corpus-key');

    const failure = withMaterializationPreflightRecovery(
      new Error('Destination is tracked by Git or matches secret-risk policy'),
    );
    expect(failure.message).toContain('before any approval was created');
    expect(failure.message).toContain('Recovery: sift vault materialize run --help');
    expect(failure.api).toEqual({
      type: 'vault_materialization_preflight_failed',
      extra: {
        retryable: false,
        recoveryCommand: 'sift vault materialize run --help',
      },
    });
    expect(failure.suggestions).toEqual(['sift vault materialize run --help']);
  });

  it('uses exact audited fields while keeping plaintext out of CLI output', async () => {
    const request = command(VaultMaterializeRequest);
    const requestApi = vi.fn().mockImplementation(async (_flags, url: string) => (
      url.includes('/sources/resolve') ? {entry: {
        id: 'entry-1', slug: 'entry', owner: 'personal', credentialFields: ['value'], credentialFieldsResolved: true,
      }} : {
      materialization: {
        id: 'materialization-1',
        approvalId: 'approval-1',
        destinationPath: '/workspace/runtime/credential',
      },
      artifactEnvelope: {algorithm: 'RSA-OAEP-256+A256GCM', ciphertext: 'opaque'},
      artifactBinding: 'opaque-binding',
      approvalUrl: 'https://siftable.io/app/vault/approvals?approval=approval-1',
    }));
    (request as any).parse = vi.fn().mockResolvedValue({flags: {
      entry: 'entry-1',
      field: 'value',
      destination: '/workspace/runtime/credential',
      'workspace-root': '/workspace',
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
    (request as any).jsonEnabled = () => false;
    const requestLog = vi.fn();
    (request as any).log = requestLog;
    const requested = await request.run();
    expect(requestApi).toHaveBeenCalledWith(
      expect.not.objectContaining({
        workspace: expect.anything(),
        'workspace-root': expect.anything(),
      }),
      '/api/v1/vault/materializations',
      expect.objectContaining({body: expect.objectContaining({
        surface: 'cli',
        contextContractVersion: 1,
        destinationPath: '/workspace/runtime/credential',
        workspaceRoot: '/workspace',
        plaintextDisclosureAcknowledged: true,
      })}),
    );
    expect(requestLog.mock.calls.flat().filter((line) => String(line).startsWith('Approval: http')))
      .toEqual(['Approval: https://siftable.io/app/vault/approvals?approval=approval-1']);

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
    expect(statusApi.mock.calls[0][1]).toContain('contextContractVersion=1');
    expect(JSON.stringify({requested, inspected})).not.toContain('SENTINEL_PLAINTEXT');
    expect(JSON.stringify(inspected)).not.toContain('artifactEnvelope');
  });

  it('makes an invalid field selection converge without creating an approval', () => {
    expect(() => assertMaterializationSourceField({
      id: 'entry-1',
      name: 'SSH key',
      slug: 'my_ssh',
      owner: 'personal',
      qualifiedSlug: 'personal/my_ssh',
      credentialFields: ['value'],
      credentialFieldsResolved: true,
    }, 'private_key')).toThrow('Valid fields: "value"');
  });

  it('restores typed recovery after BaseCommand collapses a materialization 404', async () => {
    const operation = withMaterializationRecovery(
      async () => {
        throw new Error('Not found: Vault materialization not found');
      },
      {
        type: 'vault_materialization_not_found',
        retryable: false,
        recoveryCommand: 'sift vault materialize run --help',
      },
    );

    await expect(operation).rejects.toMatchObject({
      api: {
        type: 'vault_materialization_not_found',
        extra: {
          retryable: false,
          recoveryCommand: 'sift vault materialize run --help',
        },
      },
      suggestions: ['sift vault materialize run --help'],
    });
  });

  it('accepts the deprecated absolute --workspace path without forwarding a tenant header', async () => {
    const request = command(VaultMaterializeRequest);
    const requestApi = vi.fn().mockImplementation(async (_flags, url: string) => (
      url.includes('/sources/resolve') ? {entry: {
        id: 'entry-1', slug: 'entry', owner: 'personal', credentialFields: ['value'], credentialFieldsResolved: true,
      }} : {
      materialization: {id: 'materialization-legacy', approvalId: 'approval-legacy'},
      artifactEnvelope: {ciphertext: 'opaque'},
      artifactBinding: 'opaque-binding',
      approvalUrl: 'https://siftable.io/app/vault/approvals?approval=approval-legacy',
    }));
    (request as any).parse = vi.fn().mockResolvedValue({flags: {
      entry: 'entry-1',
      field: 'value',
      destination: '/legacy/runtime/credential',
      workspace: '/legacy',
      mode: '0600',
      purpose: 'Compatibility proof',
      nonce: 'n'.repeat(32),
      overwrite: false,
      'tracked-exception': false,
      'runner-public-key': '/dev/null',
      'runner-fingerprint': 'a'.repeat(64),
      'materializer-digest': 'b'.repeat(64),
    }});
    (request as any).apiRequest = requestApi;
    (request as any).jsonEnabled = () => true;
    await request.run();
    expect(requestApi).toHaveBeenCalledWith(
      expect.not.objectContaining({workspace: expect.anything()}),
      '/api/v1/vault/materializations',
      expect.objectContaining({body: expect.objectContaining({workspaceRoot: '/legacy'})}),
    );
    expect(requestApi.mock.calls.at(-1)?.[2]).toEqual(expect.objectContaining({
      body: expect.objectContaining({contextContractVersion: 0}),
    }));
  });

  it('forwards one workspace identity through request, status, and revoke', async () => {
    const request = command(VaultMaterializeRequest);
    const requestApi = vi.fn().mockImplementation(async (_flags, url: string) => (
      url.includes('/sources/resolve') ? {entry: {
        id: 'entry-1', slug: 'entry', owner: 'workspace:workspace-1', credentialFields: ['value'], credentialFieldsResolved: true,
      }} : {
      materialization: {id: 'materialization-workspace', approvalId: 'approval-workspace'},
      artifactEnvelope: {ciphertext: 'opaque'},
      artifactBinding: 'opaque-binding',
      approvalUrl: 'https://siftable.io/app/vault/approvals?approval=approval-workspace',
    }));
    (request as any).parse = vi.fn().mockResolvedValue({flags: {
      entry: 'entry-1',
      field: 'value',
      destination: '/workspace/runtime/credential',
      workspace: 'workspace-1',
      'workspace-root': '/workspace',
      mode: '0600',
      purpose: 'Workspace compatibility proof',
      nonce: 'n'.repeat(32),
      overwrite: false,
      'tracked-exception': false,
      'runner-public-key': '/dev/null',
      'runner-fingerprint': 'a'.repeat(64),
      'materializer-digest': 'b'.repeat(64),
    }});
    (request as any).apiRequest = requestApi;
    (request as any).jsonEnabled = () => true;
    await request.run();
    expect(requestApi).toHaveBeenCalledWith(
      expect.objectContaining({workspace: 'workspace-1'}),
      '/api/v1/vault/materializations',
      expect.objectContaining({body: expect.objectContaining({contextContractVersion: 1})}),
    );

    const revoke = command(VaultMaterializeRevoke);
    const revokeApi = vi.fn().mockResolvedValue({materialization: {id: 'materialization-workspace'}});
    (revoke as any).parse = vi.fn().mockResolvedValue({
      args: {id: 'materialization-workspace'},
      flags: {owner: 'workspace:workspace-1'},
    });
    (revoke as any).apiRequest = revokeApi;
    (revoke as any).jsonEnabled = () => true;
    await revoke.run();
    expect(revokeApi).toHaveBeenCalledWith(
      expect.objectContaining({workspace: 'workspace-1'}),
      '/api/v1/vault/materializations/materialization-workspace/revoke',
      expect.objectContaining({body: {surface: 'cli', contextContractVersion: 1}}),
    );
  });

  it('requires an explicit legacy follow-up and never silently retries across owners', async () => {
    const originalWorkspace = process.env.SIFT_WORKSPACE_ID;
    process.env.SIFT_WORKSPACE_ID = 'workspace-current';
    try {
      const status = command(VaultMaterializeStatus);
      const statusApi = vi.fn().mockResolvedValue({
        materialization: {id: 'materialization-legacy', status: 'pending'},
      });
      (status as any).parse = vi.fn().mockResolvedValue({
        args: {id: 'materialization-legacy'},
        flags: {'legacy-context': true},
      });
      (status as any).apiRequest = statusApi;
      (status as any).jsonEnabled = () => true;
      await status.run();
      expect(statusApi).toHaveBeenCalledWith(
        expect.objectContaining({workspace: null}),
        expect.stringContaining('contextContractVersion=0'),
      );

      const revoke = command(VaultMaterializeRevoke);
      const revokeApi = vi.fn().mockResolvedValue({materialization: {id: 'materialization-legacy'}});
      (revoke as any).parse = vi.fn().mockResolvedValue({
        args: {id: 'materialization-legacy'},
        flags: {'legacy-context': true},
      });
      (revoke as any).apiRequest = revokeApi;
      (revoke as any).jsonEnabled = () => true;
      await revoke.run();
      expect(revokeApi).toHaveBeenCalledWith(
        expect.objectContaining({workspace: null}),
        '/api/v1/vault/materializations/materialization-legacy/revoke',
        expect.objectContaining({body: {surface: 'cli', contextContractVersion: 0}}),
      );
    } finally {
      if (originalWorkspace === undefined) delete process.env.SIFT_WORKSPACE_ID;
      else process.env.SIFT_WORKSPACE_ID = originalWorkspace;
    }
  });

  it('derives an exact owner from qualified slugs and validates the canonical URL', () => {
    expect(ownerFlagsForMaterializationSource({
      entry: 'personal/provider_key',
    })).toMatchObject({owner: 'personal'});
    expect(ownerFlagsForMaterializationSource({
      entry: 'workspace:00000000-0000-4000-8000-000000000010/provider_key',
    })).toMatchObject({
      owner: 'workspace:00000000-0000-4000-8000-000000000010',
      workspace: '00000000-0000-4000-8000-000000000010',
    });
    expect(() => ownerFlagsForMaterializationSource({
      entry: 'personal/provider_key',
      owner: 'workspace:00000000-0000-4000-8000-000000000010',
    })).toThrow('conflicts');
    expect(ownerFlagsForMaterializationSource({
      entry: 'personal/provider_key',
      workspace: '/legacy',
    }, {legacyMaterializationAlias: true})).toMatchObject({
      owner: 'personal',
      workspace: undefined,
    });
    expect(assertCanonicalApprovalUrl(
      'https://siftable.io/app/vault/approvals?approval=approval-1',
      'approval-1',
    )).toContain('approval=approval-1');
    expect(() => assertCanonicalApprovalUrl(
      'https://siftable.io/app/vault/approvals?approval=approval-2',
      'approval-1',
    )).toThrow('exact approval binding');
  });

  it('preserves machine-readable source recovery after BaseCommand collapses a 404', async () => {
    const failure = new Error('Not found: Vault materialization source not found') as Error & {
      api?: Record<string, unknown>;
      suggestions?: string[];
    };
    await expect(withMaterializationSourceRecovery(
      async () => { throw failure; },
      'personal/missing_key',
      'personal',
    )).rejects.toThrow('Recovery: sift vault search "missing_key" --owner personal');
    expect(failure.api).toEqual(expect.objectContaining({
      type: 'vault_materialization_source_not_found',
      extra: {
        retryable: false,
        recoveryCommand: 'sift vault search "missing_key" --owner personal',
      },
    }));
    expect(failure.suggestions).toEqual(['sift vault search "missing_key" --owner personal']);
  });

  it('classifies terminal and timeout failures with one executable status recovery', () => {
    const recoveryCommand = 'sift vault materialize status materialization-1';
    const timeout = withMaterializationFailureRecovery(
      new Error('Materialization approval timed out'),
      {
        type: 'vault_materialization_approval_timeout',
        retryable: true,
        recoveryCommand,
      },
    ) as Error & {api?: Record<string, any>; suggestions?: string[]};
    expect(timeout.message).toContain(`Recovery: ${recoveryCommand}`);
    expect(timeout.api?.extra).toEqual({retryable: true, recoveryCommand});
    expect(timeout.suggestions).toEqual([recoveryCommand]);

    const terminal = withMaterializationFailureRecovery(
      new Error('Materialization approval is denied'),
      {
        type: 'vault_materialization_approval_terminal',
        retryable: false,
        recoveryCommand,
      },
    ) as Error & {api?: Record<string, any>};
    expect(terminal.api?.extra).toEqual({retryable: false, recoveryCommand});
  });

  it('prints the typed lifecycle and its executable recovery command', async () => {
    const status = command(VaultMaterializeStatus);
    (status as any).parse = vi.fn().mockResolvedValue({
      args: {id: 'materialization-1'},
      flags: {},
    });
    (status as any).apiRequest = vi.fn().mockResolvedValue({materialization: {
      id: 'materialization-1',
      status: 'failed',
      destinationPath: '/workspace/runtime/credential',
      requestedMode: '0600',
      expiresAt: '2026-08-04T20:00:00.000Z',
      lifecycle: {
        state: 'failed',
        retryable: true,
        recoveryCommand: 'sift vault materialize run --help',
      },
    }});
    (status as any).jsonEnabled = () => false;
    const log = vi.fn();
    (status as any).log = log;
    await status.run();
    expect(log.mock.calls.flat()).toEqual(expect.arrayContaining([
      'Status: failed',
      'Recovery: sift vault materialize run --help',
    ]));
  });
});

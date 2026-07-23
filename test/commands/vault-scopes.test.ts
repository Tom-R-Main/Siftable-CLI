import { afterAll, describe, expect, it, vi } from 'vitest';
import VaultAudit from '../../src/commands/vault/audit.js';
import VaultCreate from '../../src/commands/vault/create.js';
import VaultList from '../../src/commands/vault/list.js';
import VaultSearch from '../../src/commands/vault/search.js';
import VaultUpdate from '../../src/commands/vault/update.js';
import { mockFetch, restoreFetch, runCommand } from '../helpers/mock-api';

afterAll(() => {
  restoreFetch();
});

describe('Vault CLI scopes', () => {
  it('declares the exact scope required by each command', () => {
    expect(VaultList.requiredScope).toBe('vault:metadata:read');
    expect(VaultSearch.requiredScope).toBe('vault:metadata:read');
    expect(VaultCreate.requiredScope).toBe('vault:manage');
    expect(VaultUpdate.requiredScope).toBe('vault:manage');
    expect(VaultAudit.requiredScope).toBe('vault:audit:read');
  });

  it('returns actionable incremental-consent guidance for a denied Vault call', async () => {
    const command = Object.create(VaultList.prototype) as VaultList;
    vi.spyOn(command as unknown as { error: (error: Error) => never }, 'error')
      .mockImplementation((error: Error) => {
        throw error;
      });

    let error: (Error & { suggestions?: string[] }) | undefined;
    try {
      (command as unknown as {
        handleApiError: (response: { statusCode: number; error: string }) => void;
      }).handleApiError({
        statusCode: 403,
        error: JSON.stringify({
          type: 'insufficient_pat_scope',
          title: 'Vault scope required',
          status: 403,
          detail: 'Required scope: vault:metadata:read',
          extra: { requiredScope: 'vault:metadata:read' },
        }),
      });
    } catch (caught) {
      error = caught as Error & { suggestions?: string[] };
    }

    expect(error).toBeDefined();
    expect(error!.message).toContain('Required scope: vault:metadata:read');
    expect(error!.suggestions).toContain(
      'Reauthorize explicitly with: sift auth login --scope vault:metadata:read',
    );
    expect(JSON.stringify(error)).not.toContain('sift_pat_test');
  });

  it('lists safe audit metadata without a plaintext field', async () => {
    mockFetch()
      .on('GET', '/api/v1/vault/audit')
      .reply(200, {
        entries: [{
          createdAt: '2026-07-23T20:00:00.000Z',
          action: 'read',
          vaultEntryId: 'entry-1',
          accessorType: 'user',
        }],
      })
      .install();

    const result = await runCommand([
      'vault', 'audit', '--token', 'sift_pat_test',
    ]);

    expect(result.stdout).toContain('entry-1');
    expect(result.stdout).not.toContain('payload');
    expect(result.stdout).not.toContain('secret');
  });
});

import {afterEach, describe, expect, it, vi} from 'vitest';
import VaultList from './list.js';
import VaultRead from './read.js';
import VaultSearch from './search.js';

function command<T>(constructor: {prototype: T}): T {
  return Object.create(constructor.prototype) as T;
}

const originalWorkspaceId = process.env.SIFT_WORKSPACE_ID;

afterEach(() => {
  if (originalWorkspaceId === undefined) delete process.env.SIFT_WORKSPACE_ID;
  else process.env.SIFT_WORKSPACE_ID = originalWorkspaceId;
});

describe('Vault owner-scoped commands', () => {
  it('routes retired plaintext reads directly to the supported governed flow', async () => {
    const read = command(VaultRead);
    (read as any).parse = vi.fn().mockResolvedValue({args: {id: 'entry-1'}, flags: {}});
    (read as any).error = vi.fn((message: string) => {
      throw new Error(message);
    });

    await expect(read.run()).rejects.toThrow('sift vault materialize run --help');
    await expect(read.run()).rejects.toThrow('first-party Siftable web Vault');
    await expect(read.run()).rejects.toThrow('Do not use generic `sift approvals request`');
  });

  it('lets --owner personal override an ambient workspace without unioning results', async () => {
    process.env.SIFT_WORKSPACE_ID = 'workspace-env';
    const list = command(VaultList);
    const client = {
      listVaultEntries: vi.fn().mockResolvedValue({
        statusCode: 200,
        data: {entries: [{
          id: 'entry-personal',
          name: 'Personal key',
          slug: 'provider_key',
          entryType: 'env_var',
          ownerType: 'user',
          ownerId: 'user-1',
          payload: {value: 'SENTINEL_PLAINTEXT'},
        }]},
      }),
    };
    const createClient = vi.fn().mockResolvedValue(client);
    (list as any).parse = vi.fn().mockResolvedValue({flags: {owner: 'personal'}});
    (list as any).client = createClient;
    (list as any).handleApiError = vi.fn();
    (list as any).jsonEnabled = () => true;
    const entries = await list.run() as Array<Record<string, unknown>>;
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({workspace: null}));
    expect(entries[0]).toMatchObject({owner: 'personal', qualifiedSlug: 'personal/provider_key'});
    expect(entries[0]).not.toHaveProperty('payload');
  });

  it('sends one explicit workspace owner and reports the server-persisted owner', async () => {
    const search = command(VaultSearch);
    const apiRequest = vi.fn().mockResolvedValue({entries: [{
          id: 'entry-workspace',
          name: 'Workspace key',
          slug: 'provider_key',
          owner: 'workspace:workspace-1',
          qualifiedSlug: 'workspace:workspace-1/provider_key',
          credentialFields: ['value'],
        }]});
    (search as any).parse = vi.fn().mockResolvedValue({
      args: {query: 'provider'},
      flags: {owner: 'workspace:workspace-1'},
    });
    (search as any).apiRequest = apiRequest;
    (search as any).jsonEnabled = () => true;
    const entries = await search.run() as Array<Record<string, unknown>>;
    expect(apiRequest).toHaveBeenCalledWith(
      expect.objectContaining({workspace: 'workspace-1'}),
      expect.stringContaining('search=provider'),
    );
    expect(entries[0]).toMatchObject({
      owner: 'workspace:workspace-1',
      qualifiedSlug: 'workspace:workspace-1/provider_key',
      credentialFields: ['value'],
    });
  });
});

import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BaseCommand} from './base-command.js';
import {writeSavedWorkspaceSelection} from './workspace-context.js';

class ContextTransportProbe extends BaseCommand {
  async run(): Promise<unknown> {
    return undefined;
  }

  request(flags: {token: string; 'api-url': string; workspace?: string | null}): Promise<unknown> {
    return this.apiRequest(flags, '/probe');
  }
}

const originalConfigDir = process.env.SIFT_CONFIG_DIR;
const originalWorkspaceId = process.env.SIFT_WORKSPACE_ID;
const directories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalConfigDir === undefined) delete process.env.SIFT_CONFIG_DIR;
  else process.env.SIFT_CONFIG_DIR = originalConfigDir;
  if (originalWorkspaceId === undefined) delete process.env.SIFT_WORKSPACE_ID;
  else process.env.SIFT_WORKSPACE_ID = originalWorkspaceId;
  delete process.env.EXF_WORKSPACE_ID;
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('Vault context request transport', () => {
  it('forwards a saved workspace and lets Personal explicitly suppress it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sift-vault-transport-'));
    directories.push(directory);
    process.env.SIFT_CONFIG_DIR = directory;
    delete process.env.SIFT_WORKSPACE_ID;
    writeSavedWorkspaceSelection({
      workspaceId: 'workspace-saved',
      workspaceName: 'Saved',
      selectedAt: '2026-08-04T00:00:00.000Z',
    });
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ok: true}),
    });
    vi.stubGlobal('fetch', fetch);
    const probe = Object.create(ContextTransportProbe.prototype) as ContextTransportProbe;

    await probe.request({token: 'opaque-token', 'api-url': 'https://example.test'});
    expect(fetch.mock.calls[0][1].headers).toMatchObject({'X-Workspace-Id': 'workspace-saved'});

    await probe.request({token: 'opaque-token', 'api-url': 'https://example.test', workspace: null});
    expect(fetch.mock.calls[1][1].headers).not.toHaveProperty('X-Workspace-Id');
  });

  it('rejects path-shaped tenant IDs before any network request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const probe = Object.create(ContextTransportProbe.prototype) as ContextTransportProbe;
    await expect(probe.request({
      token: 'opaque-token',
      'api-url': 'https://example.test',
      workspace: '/tmp/not-a-tenant',
    })).rejects.toThrow(/cannot be filesystem paths/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

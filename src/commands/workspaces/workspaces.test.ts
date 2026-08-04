import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import WorkspacesList from './list.js';
import WorkspacesCurrent from './current.js';
import WorkspacesUse from './use.js';
import {readSavedWorkspaceSelection} from '../../lib/workspace-context.js';

function command<T>(constructor: {prototype: T}): T {
  return Object.create(constructor.prototype) as T;
}

const originalConfigDir = process.env.SIFT_CONFIG_DIR;
const directories: string[] = [];

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.SIFT_CONFIG_DIR;
  else process.env.SIFT_CONFIG_DIR = originalConfigDir;
  delete process.env.SIFT_WORKSPACE_ID;
  delete process.env.EXF_WORKSPACE_ID;
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('workspace discovery commands', () => {
  const workspaces = [{id: 'workspace-1', name: 'Acme', role: 'owner', memberCount: 2}];

  it('lists available workspaces without scoping the discovery request', async () => {
    const instance = command(WorkspacesList);
    const apiRequest = vi.fn().mockResolvedValue({workspaces});
    (instance as any).parse = vi.fn().mockResolvedValue({flags: {workspace: 'workspace-1'}});
    (instance as any).apiRequest = apiRequest;
    (instance as any).jsonEnabled = () => true;
    const result = await instance.run() as any;
    expect(apiRequest).toHaveBeenCalledWith(
      expect.not.objectContaining({workspace: expect.anything()}),
      '/api/v1/workspaces',
    );
    expect(result.workspaces[0].selected).toBe(true);
  });

  it('persists an exact available ID and can return to Personal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sift-workspace-command-'));
    directories.push(directory);
    process.env.SIFT_CONFIG_DIR = directory;
    const use = command(WorkspacesUse);
    (use as any).parse = vi.fn().mockResolvedValue({args: {id: 'workspace-1'}, flags: {}});
    (use as any).apiRequest = vi.fn().mockResolvedValue({workspaces});
    (use as any).jsonEnabled = () => true;
    await use.run();
    expect(readSavedWorkspaceSelection()?.workspaceName).toBe('Acme');

    const current = command(WorkspacesCurrent);
    (current as any).parse = vi.fn().mockResolvedValue({flags: {}});
    (current as any).apiRequest = vi.fn().mockResolvedValue({workspaces});
    (current as any).jsonEnabled = () => true;
    const currentResult = await current.run() as any;
    expect(currentResult.owner).toMatchObject({kind: 'workspace', workspaceId: 'workspace-1'});

    (use as any).parse = vi.fn().mockResolvedValue({args: {id: 'personal'}, flags: {}});
    await use.run();
    expect(readSavedWorkspaceSelection()).toBeNull();
  });
});

import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import ContextCurrent from './current.js';

function command<T>(constructor: {prototype: T}): T {
  return Object.create(constructor.prototype) as T;
}

const originalConfigDir = process.env.SIFT_CONFIG_DIR;
const directories: string[] = [];

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.SIFT_CONFIG_DIR;
  else process.env.SIFT_CONFIG_DIR = originalConfigDir;
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('context current', () => {
  it('declares all context axes and reports an opaque pasted PAT truthfully', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sift-context-current-'));
    directories.push(directory);
    process.env.SIFT_CONFIG_DIR = directory;
    const instance = command(ContextCurrent);
    (instance as any).parse = vi.fn().mockResolvedValue({flags: {'workspace-root': '/workspace'}});
    (instance as any).apiRequest = vi.fn()
      .mockResolvedValueOnce({id: 'user-1', email: 'user@example.com'})
      .mockResolvedValueOnce({workspaces: []});
    (instance as any).client = vi.fn().mockResolvedValue({
      listCodeRepositories: vi.fn().mockResolvedValue({
        statusCode: 200,
        data: {repositories: [{id: 'repo-1', name: 'Repo', rootPath: '/workspace', projectId: 'project-1'}]},
      }),
    });
    (instance as any).handleApiError = vi.fn();
    (instance as any).jsonEnabled = () => true;
    const result = await instance.run() as any;
    expect(result).toMatchObject({
      principal: {type: 'pat_unknown', surface: 'cli', authority: 'client_unresolved'},
      owner: {kind: 'user', userId: 'user-1'},
      queryContext: {projectId: 'project-1', selectedWorkspaceContextId: null},
      checkout: {root: '/workspace'},
      sources: {checkout: 'workspace_root_flag', project: 'registered_repository_match'},
    });
  });
});

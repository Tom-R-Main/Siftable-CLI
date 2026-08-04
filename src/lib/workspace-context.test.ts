import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  clearSavedWorkspaceSelection,
  getWorkspaceSelectionFile,
  inferPrincipalDeclaration,
  looksLikeLocalPath,
  readSavedWorkspaceSelection,
  resolveContextSelection,
  writeSavedWorkspaceSelection,
} from './workspace-context.js';

const originalConfigDir = process.env.SIFT_CONFIG_DIR;
const originalWorkspaceId = process.env.SIFT_WORKSPACE_ID;
const temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.SIFT_CONFIG_DIR;
  else process.env.SIFT_CONFIG_DIR = originalConfigDir;
  if (originalWorkspaceId === undefined) delete process.env.SIFT_WORKSPACE_ID;
  else process.env.SIFT_WORKSPACE_ID = originalWorkspaceId;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('workspace context selection', () => {
  it('persists a non-secret selection separately from auth and resolves precedence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sift-workspace-context-'));
    temporaryDirectories.push(directory);
    process.env.SIFT_CONFIG_DIR = directory;
    delete process.env.SIFT_WORKSPACE_ID;
    writeSavedWorkspaceSelection({
      workspaceId: 'workspace-saved',
      workspaceName: 'Saved workspace',
      selectedAt: '2026-08-04T00:00:00.000Z',
    });
    expect(readSavedWorkspaceSelection()?.workspaceId).toBe('workspace-saved');
    expect(resolveContextSelection().selectionSource).toBe('saved_selection');
    process.env.SIFT_WORKSPACE_ID = 'workspace-env';
    expect(resolveContextSelection().selectedWorkspaceId).toBe('workspace-env');
    expect(resolveContextSelection({workspaceFlag: 'workspace-flag'}).selectedWorkspaceId).toBe('workspace-flag');
    expect(JSON.parse(readFileSync(getWorkspaceSelectionFile(), 'utf8'))).not.toHaveProperty('token');
    clearSavedWorkspaceSelection();
    expect(readSavedWorkspaceSelection()).toBeNull();
  });

  it('rejects path-shaped tenant values and never guesses an opaque PAT subtype', () => {
    expect(looksLikeLocalPath('/tmp/worktree')).toBe(true);
    expect(looksLikeLocalPath('../worktree')).toBe(true);
    expect(looksLikeLocalPath('projects/worktree')).toBe(true);
    expect(looksLikeLocalPath('workspace-123')).toBe(false);
    expect(() => resolveContextSelection({workspaceFlag: 'projects/worktree'})).toThrow(/cannot be filesystem paths/);
    expect(inferPrincipalDeclaration({userId: 'user-1'})).toMatchObject({
      type: 'pat_unknown',
      authority: 'client_unresolved',
    });
    expect(inferPrincipalDeclaration({userId: 'user-1', configuredType: 'personal_pat'})).toMatchObject({
      type: 'personal_pat',
      authority: 'saved_login',
    });
  });
});

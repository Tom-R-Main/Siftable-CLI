import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {getConfigDir} from './config.js';
import type {SiftCliContextSelection, SiftCliPrincipalDeclaration} from '../types/siftContext.js';

export interface SavedWorkspaceSelection {
  workspaceId: string;
  workspaceName: string;
  selectedAt: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  domain?: string | null;
  industry?: string | null;
  role?: string;
  memberCount?: number;
}

export interface RepositorySummary {
  id?: string;
  name?: string;
  rootPath?: string;
  projectId?: string;
}

const WORKSPACE_SELECTION_FILE = 'workspace-context.json';

export function getWorkspaceSelectionFile(): string {
  return join(getConfigDir(), WORKSPACE_SELECTION_FILE);
}

export function readSavedWorkspaceSelection(): SavedWorkspaceSelection | null {
  try {
    const parsed = JSON.parse(readFileSync(getWorkspaceSelectionFile(), 'utf8')) as Partial<SavedWorkspaceSelection>;
    if (
      typeof parsed.workspaceId !== 'string'
      || parsed.workspaceId.trim() === ''
      || typeof parsed.workspaceName !== 'string'
      || typeof parsed.selectedAt !== 'string'
    ) {
      return null;
    }
    return {
      workspaceId: parsed.workspaceId,
      workspaceName: parsed.workspaceName,
      selectedAt: parsed.selectedAt,
    };
  } catch {
    return null;
  }
}

export function writeSavedWorkspaceSelection(selection: SavedWorkspaceSelection): void {
  const target = getWorkspaceSelectionFile();
  mkdirSync(dirname(target), {recursive: true, mode: 0o700});
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(selection, null, 2)}\n`, {mode: 0o600});
  renameSync(temporary, target);
}

export function clearSavedWorkspaceSelection(): void {
  try {
    unlinkSync(getWorkspaceSelectionFile());
  } catch {
    // Already absent.
  }
}

export function looksLikeLocalPath(value: string): boolean {
  return value === '.'
    || value === '..'
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('~/')
    || isAbsolute(value)
    || value.includes('/')
    || value.includes('\\');
}

export function resolveContextSelection(options: {
  workspaceFlag?: string;
  checkoutRoot?: string | null;
} = {}): SiftCliContextSelection {
  const environment = process.env.SIFT_WORKSPACE_ID || process.env.EXF_WORKSPACE_ID;
  const saved = readSavedWorkspaceSelection();
  const selectedWorkspaceId = options.workspaceFlag || environment || saved?.workspaceId || null;
  if (selectedWorkspaceId && looksLikeLocalPath(selectedWorkspaceId)) {
    throw new Error('Workspace tenant IDs cannot be filesystem paths. Use --workspace-root for a local checkout path.');
  }
  const selectionSource = options.workspaceFlag
    ? 'workspace_flag'
    : environment
      ? 'environment'
      : saved
        ? 'saved_selection'
        : 'none';
  return {
    selectedWorkspaceId,
    selectionSource,
    checkoutRoot: options.checkoutRoot ?? findCheckoutRoot(),
  };
}

export function inferPrincipalDeclaration(options: {
  userId?: string | null;
  selectedWorkspaceId?: string | null;
  configuredType?: 'personal_pat' | 'workspace_service_pat';
}): SiftCliPrincipalDeclaration {
  if (options.configuredType === 'personal_pat' || options.configuredType === 'workspace_service_pat') {
    return {
      type: options.configuredType,
      principalId: options.userId ?? null,
      authority: options.configuredType === 'personal_pat' ? 'saved_login' : 'workspace_binding',
    };
  }
  return {
    type: 'pat_unknown',
    principalId: options.userId ?? null,
    authority: 'client_unresolved',
  };
}

export function findCheckoutRoot(cwd = process.cwd()): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim() || null;
  } catch {
    return null;
  }
}

export function findRepositoryForCheckout(
  repositories: RepositorySummary[],
  checkoutRoot: string | null,
): RepositorySummary | undefined {
  if (!checkoutRoot) return undefined;
  return repositories
    .filter((repository) => {
      if (!repository.id || !repository.rootPath || repository.rootPath.startsWith('git://')) return false;
      const candidate = relative(resolve(repository.rootPath), resolve(checkoutRoot));
      return candidate === '' || (!!candidate && !candidate.startsWith('..') && !isAbsolute(candidate));
    })
    .sort((left, right) => resolve(right.rootPath!).length - resolve(left.rootPath!).length)[0];
}

export function selectionFileExists(): boolean {
  return existsSync(getWorkspaceSelectionFile());
}

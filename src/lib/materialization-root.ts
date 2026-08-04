import {isAbsolute} from 'node:path';
import {looksLikeLocalPath} from './workspace-context.js';

export interface MaterializationRootResolution {
  workspaceRoot: string;
  usedLegacyAlias: boolean;
}

export function resolveMaterializationRoot(flags: {
  workspace?: string;
  'workspace-root'?: string;
}): MaterializationRootResolution {
  const explicitRoot = flags['workspace-root'];
  const legacyValue = flags.workspace;
  if (explicitRoot) {
    if (!isAbsolute(explicitRoot)) {
      throw new Error('--workspace-root must be an absolute local filesystem path.');
    }
    if (legacyValue && looksLikeLocalPath(legacyValue)) {
      throw new Error('Do not provide both --workspace-root and a path-like --workspace value. Use --workspace-root for the local path.');
    }
    return {workspaceRoot: explicitRoot, usedLegacyAlias: false};
  }
  if (legacyValue && isAbsolute(legacyValue)) {
    return {workspaceRoot: legacyValue, usedLegacyAlias: true};
  }
  if (legacyValue && looksLikeLocalPath(legacyValue)) {
    throw new Error('Legacy --workspace materialization paths must be absolute. Use --workspace-root /absolute/path.');
  }
  throw new Error('Missing --workspace-root. Use --workspace-root /absolute/path; --workspace now identifies a collaborative tenant.');
}

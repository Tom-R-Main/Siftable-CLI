import type {DotenvDuplicateClass, ValueFreeDotenvImportEntry} from './dotenvImport.js';

export type DotenvImportAction = 'create' | 'keep_existing' | 'overwrite' | 'rename' | 'skip';
export type DotenvImportConflictClass = 'none' | 'existing_slug' | 'source_duplicate';

export interface DotenvImportDecision {
  sourceIndex: number;
  action: Exclude<DotenvImportAction, 'create'>;
  renameTo?: string;
}

export interface DotenvImportPlanItem extends ValueFreeDotenvImportEntry {
  duplicateClass: DotenvDuplicateClass;
  conflictClass: DotenvImportConflictClass;
  proposedAction: DotenvImportAction;
  targetName: string;
  targetSlug: string;
  existingEntryId: string | null;
  existingEntryType: string | null;
  existingValueRevision: string | null;
}

export interface DotenvImportPlanResponse {
  plan: {
    id: string;
    dialect: 'sift-dotenv-v1';
    ownerType: 'user' | 'workspace';
    ownerId: string;
    projectId: string | null;
    sourceNonce: string;
    sourceDigest: string;
    planDigest: string;
    items: DotenvImportPlanItem[];
    status: 'active';
    expiresAt: string;
  };
}

export interface DotenvImportApplyResponse {
  receipt: {
    planId: string;
    planDigest: string;
    importId: string;
    ownerType: 'user' | 'workspace';
    ownerId: string;
    projectId: string | null;
    createdCount: number;
    updatedCount: number;
    keptCount: number;
    skippedCount: number;
    entries: Array<{
      sourceIndex: number;
      key: string;
      action: DotenvImportAction;
      slug: string;
      entryId: string | null;
      field: 'value';
    }>;
  };
}

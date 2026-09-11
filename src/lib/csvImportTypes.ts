import type {CsvDuplicateClass, CsvRowClass, ValueFreeCsvImportEntry} from './csvImport.js';

export type CsvImportAction = 'create' | 'keep_existing' | 'overwrite' | 'rename' | 'skip';
export type CsvImportConflictClass = 'none' | 'existing_slug' | 'source_duplicate';

export interface CsvColumnRef {
  index: number;
  header: string;
}

export interface CsvSourceProfile {
  headerRowNumber: number;
  delimiter: string;
  columnCount: number;
  dataRowCount: number;
  mapping: {
    nameColumn: CsvColumnRef;
    valueColumn: CsvColumnRef;
    ownerColumn?: CsvColumnRef;
    descriptionColumn?: CsvColumnRef;
    tagsColumn?: CsvColumnRef;
  };
}

export interface CsvImportDecision {
  sourceIndex: number;
  action: Exclude<CsvImportAction, 'create'>;
  renameTo?: string;
}

export interface CsvImportPlanItem extends ValueFreeCsvImportEntry {
  duplicateClass: CsvDuplicateClass;
  rowClass: CsvRowClass;
  conflictClass: CsvImportConflictClass;
  proposedAction: CsvImportAction;
  targetName: string;
  targetSlug: string;
  existingEntryId: string | null;
  existingEntryType: string | null;
  existingValueRevision: string | null;
}

export interface CsvImportPlanResponse {
  plan: {
    id: string;
    dialect: 'sift-csv-v1';
    ownerType: 'user' | 'workspace';
    ownerId: string;
    projectId: string | null;
    sourceNonce: string;
    sourceDigest: string;
    sourceProfile: CsvSourceProfile;
    planDigest: string;
    items: CsvImportPlanItem[];
    status: 'active';
    expiresAt: string;
  };
}

export interface CsvImportApplyResponse {
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
      action: CsvImportAction;
      slug: string;
      entryId: string | null;
      field: 'value';
    }>;
  };
}

export interface ImportReceiptArtifact {
  schemaVersion: 1;
  kind: 'sift.vault.import-receipt';
  dialect: 'sift-dotenv-v1' | 'sift-csv-v1';
  sourcePath: string;
  sourceNonce: string;
  sourceDigest: string;
  planId: string;
  planDigest: string;
  importId: string;
  ownerType: 'user' | 'workspace';
  ownerId: string;
  projectId: string | null;
  counts: {
    created: number;
    updated: number;
    kept: number;
    skipped: number;
  };
  completedAt: string;
}

export interface VaultImportPlanBinding {
  planId: string;
  dialect: 'sift-dotenv-v1' | 'sift-csv-v1';
  sourceNonce: string;
  sourceDigest: string;
  planDigest: string;
  status: 'applied';
  appliedAt: string | null;
}

export interface VaultImportDetailsResponse {
  import: {
    id: string;
    status: string;
    sourceFormat: string;
    totalRows: number;
    importedCount: number;
    skippedCount: number;
    /** Server-held value-free binding of this import to its applied plan; null when none exists. */
    planBinding?: VaultImportPlanBinding | null;
  };
}

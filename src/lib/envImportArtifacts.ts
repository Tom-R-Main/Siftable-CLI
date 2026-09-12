import {constants} from 'node:fs';
import {lstat, open, realpath} from 'node:fs/promises';
import path from 'node:path';
import type {CsvImportPlanItem, CsvSourceProfile, ImportReceiptArtifact} from './csvImportTypes.js';

export const MAX_IMPORT_PLAN_ARTIFACT_BYTES = 512 * 1024;
export const MAX_IMPORT_RECEIPT_ARTIFACT_BYTES = 512 * 1024;

export interface ImportSourceSnapshot {
  path: string;
  raw: Buffer;
  device: number;
  inode: number;
}

export interface CsvImportPlanArtifact {
  schemaVersion: 1;
  kind: 'sift.vault.csv-import-plan';
  applyIdempotencyKey: string;
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

export async function readExplicitImportSource(
  sourcePath: string,
  maxBytes: number,
  label: string,
): Promise<ImportSourceSnapshot> {
  const unresolved = path.resolve(sourcePath);
  const unresolvedStat = await lstat(unresolved);
  if (unresolvedStat.isSymbolicLink() || !unresolvedStat.isFile()) {
    throw new Error(`${label} import source must be an explicitly named regular non-symlink file.`);
  }
  const requested = await realpath(unresolved);
  const handle = await open(requested, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    const pathStat = await lstat(requested);
    if (!openedStat.isFile() || pathStat.isSymbolicLink() || !pathStat.isFile()
      || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error(`${label} import source must be an explicitly named stable regular non-symlink file.`);
    }
    if (openedStat.size > maxBytes) {
      throw new Error(`${label} import source exceeds the byte limit.`);
    }
    const bounded = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const {bytesRead} = await handle.read(bounded, offset, bounded.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new Error(`${label} import source exceeds the byte limit.`);
    }
    const finalPathStat = await lstat(requested);
    if (finalPathStat.isSymbolicLink() || !finalPathStat.isFile()
      || finalPathStat.dev !== openedStat.dev || finalPathStat.ino !== openedStat.ino) {
      throw new Error(`${label} import source changed while it was being read.`);
    }
    return {
      path: requested,
      raw: bounded.subarray(0, offset),
      device: openedStat.dev,
      inode: openedStat.ino,
    };
  } finally {
    await handle.close();
  }
}

export async function writeImportPlanArtifact(filename: string, artifact: CsvImportPlanArtifact): Promise<void> {
  const handle = await open(
    path.resolve(filename),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readCsvImportPlanArtifact(filename: string): Promise<CsvImportPlanArtifact> {
  const requested = path.resolve(filename);
  const handle = await open(requested, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const openedStat = await handle.stat();
    const pathStat = await lstat(requested);
    if (!openedStat.isFile() || pathStat.isSymbolicLink() || !pathStat.isFile()
      || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error('CSV import plan must be a stable regular non-symlink file.');
    }
    if (openedStat.size > MAX_IMPORT_PLAN_ARTIFACT_BYTES) {
      throw new Error('CSV import plan exceeds the 512 KiB artifact limit.');
    }
    const bounded = Buffer.allocUnsafe(MAX_IMPORT_PLAN_ARTIFACT_BYTES + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const {bytesRead} = await handle.read(bounded, offset, bounded.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_IMPORT_PLAN_ARTIFACT_BYTES) {
      throw new Error('CSV import plan exceeds the 512 KiB artifact limit.');
    }
    raw = bounded.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
  const parsed = JSON.parse(raw) as CsvImportPlanArtifact;
  if (parsed?.schemaVersion !== 1 || parsed.kind !== 'sift.vault.csv-import-plan'
    || !/^[A-Za-z0-9_.:-]{8,128}$/.test(parsed.applyIdempotencyKey)
    || parsed.plan?.dialect !== 'sift-csv-v1' || parsed.plan.status !== 'active'
    || !Array.isArray(parsed.plan.items) || typeof parsed.plan.sourceProfile !== 'object') {
    throw new Error('CSV import plan artifact is invalid or unsupported.');
  }
  return parsed;
}

export async function writeImportReceiptArtifact(filename: string, artifact: ImportReceiptArtifact): Promise<void> {
  const handle = await open(
    path.resolve(filename),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readImportReceiptArtifact(filename: string): Promise<ImportReceiptArtifact> {
  const requested = path.resolve(filename);
  const handle = await open(requested, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const openedStat = await handle.stat();
    const pathStat = await lstat(requested);
    if (!openedStat.isFile() || pathStat.isSymbolicLink() || !pathStat.isFile()
      || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error('Import receipt must be a stable regular non-symlink file.');
    }
    if (openedStat.size > MAX_IMPORT_RECEIPT_ARTIFACT_BYTES) {
      throw new Error('Import receipt exceeds the 512 KiB artifact limit.');
    }
    const bounded = Buffer.allocUnsafe(MAX_IMPORT_RECEIPT_ARTIFACT_BYTES + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const {bytesRead} = await handle.read(bounded, offset, bounded.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_IMPORT_RECEIPT_ARTIFACT_BYTES) {
      throw new Error('Import receipt exceeds the 512 KiB artifact limit.');
    }
    raw = bounded.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
  const parsed = JSON.parse(raw) as ImportReceiptArtifact;
  if (parsed?.schemaVersion !== 1 || parsed.kind !== 'sift.vault.import-receipt'
    || (parsed.dialect !== 'sift-dotenv-v1' && parsed.dialect !== 'sift-csv-v1')
    || typeof parsed.sourcePath !== 'string' || typeof parsed.sourceNonce !== 'string'
    || typeof parsed.sourceDigest !== 'string' || typeof parsed.planId !== 'string'
    || typeof parsed.planDigest !== 'string' || typeof parsed.importId !== 'string'
    || (parsed.ownerType !== 'user' && parsed.ownerType !== 'workspace')
    || typeof parsed.ownerId !== 'string') {
    throw new Error('Import receipt artifact is invalid or unsupported.');
  }
  return parsed;
}


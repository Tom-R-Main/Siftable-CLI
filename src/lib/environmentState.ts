import {createHash, randomUUID} from 'node:crypto';
import {lstat, mkdir, open, readFile, rename, rm} from 'node:fs/promises';
import path from 'node:path';

export type EnvironmentMemberState =
  | 'absent'
  | 'managed_current'
  | 'managed_stale'
  | 'modified_locally'
  | 'unmanaged'
  | 'managed_unknown_freshness';

export interface EnvironmentStatSnapshot {
  device: number;
  inode: number;
  mode: number;
  mtime_ms: number;
  ctime_ms: number;
}

export type EnvironmentDestinationStat =
  | {exists: false}
  | ({exists: true} & EnvironmentStatSnapshot);

export interface EnvironmentReceipt {
  name: string;
  destination: string;
  mode: '0400' | '0600';
  manifest_fingerprint?: string;
  materialized_at: string;
  stat: EnvironmentStatSnapshot;
}

export interface EnvironmentReceiptLedger {
  schema_version: 1;
  receipts: EnvironmentReceipt[];
}

export function manifestFingerprint(rawManifest: string): string {
  return createHash('sha256').update(rawManifest, 'utf8').digest('hex');
}

export function classifyEnvironmentMember(
  receipt: EnvironmentReceipt | undefined,
  destination: EnvironmentDestinationStat,
  currentManifestFingerprint: string,
): EnvironmentMemberState {
  if (!destination.exists) return 'absent';
  if (!receipt) return 'unmanaged';
  if (!receipt.manifest_fingerprint) return 'managed_unknown_freshness';
  if (receipt.manifest_fingerprint !== currentManifestFingerprint) return 'managed_stale';
  const changed = receipt.stat.device !== destination.device
    || receipt.stat.inode !== destination.inode
    || receipt.stat.mode !== destination.mode
    || receipt.stat.mtime_ms !== destination.mtime_ms
    || receipt.stat.ctime_ms !== destination.ctime_ms;
  return changed ? 'modified_locally' : 'managed_current';
}

export async function statEnvironmentDestination(destinationPath: string): Promise<EnvironmentDestinationStat> {
  try {
    const {lstat} = await import('node:fs/promises');
    const info = await lstat(destinationPath);
    return {
      exists: true,
      device: info.dev,
      inode: info.ino,
      mode: info.mode & 0o777,
      mtime_ms: info.mtimeMs,
      ctime_ms: info.ctimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {exists: false};
    throw error;
  }
}

function isReceipt(value: unknown): value is EnvironmentReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = ['name', 'destination', 'mode', 'manifest_fingerprint', 'materialized_at', 'stat'];
  if (Object.keys(record).some(key => !allowed.includes(key))) return false;
  if (typeof record.name !== 'string' || typeof record.destination !== 'string'
    || (record.mode !== '0400' && record.mode !== '0600')
    || (record.manifest_fingerprint !== undefined && typeof record.manifest_fingerprint !== 'string')
    || typeof record.materialized_at !== 'string'
    || typeof record.stat !== 'object' || record.stat === null || Array.isArray(record.stat)) return false;
  const stat = record.stat as Record<string, unknown>;
  if (Object.keys(stat).sort().join(',') !== 'ctime_ms,device,inode,mode,mtime_ms') return false;
  return Object.values(stat).every(item => typeof item === 'number' && Number.isFinite(item));
}

function isReceiptLedger(value: unknown): value is EnvironmentReceiptLedger {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(',') === 'receipts,schema_version'
    && record.schema_version === 1
    && Array.isArray(record.receipts)
    && record.receipts.every(isReceipt);
}

export async function readEnvironmentReceiptLedger(checkoutRoot: string): Promise<EnvironmentReceiptLedger | null> {
  const ledgerPath = path.join(checkoutRoot, '.sift', 'environment-state.json');
  let text: string;
  try {
    text = await readFile(ledgerPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isReceiptLedger(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeEnvironmentReceiptLedger(
  checkoutRoot: string,
  ledger: EnvironmentReceiptLedger,
): Promise<void> {
  if (!isReceiptLedger(ledger)) throw new TypeError('Environment receipt ledger must be value-free and schema-valid.');
  const stateDirectory = path.join(checkoutRoot, '.sift');
  const ledgerPath = path.join(stateDirectory, 'environment-state.json');
  await mkdir(stateDirectory, {recursive: true, mode: 0o700});
  const directoryStat = await lstat(stateDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('.sift must be a real directory before writing environment receipts.');
  }

  const temporaryPath = path.join(
    stateDirectory,
    `.environment-state.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, ledgerPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, {force: true});
  }
}

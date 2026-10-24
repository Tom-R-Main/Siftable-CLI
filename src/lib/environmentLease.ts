import {createHash, randomUUID} from 'node:crypto';
import {accessSync, constants as fsConstants, lstatSync, realpathSync, type BigIntStats} from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  environmentBundleMemberSetDigest,
  type EnvironmentBundleContract,
} from './environmentBundle.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/;
const BIRTHTIME_NS_PATTERN = /^-?[0-9]{1,30}$/;
const SAFE_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

export type EnvironmentLeaseArtifactPathClass =
  | 'xdg_runtime'
  | 'tmpfs'
  | 'platform_runtime';

export type EnvironmentLeaseCleanupState =
  | 'pending'
  | 'confirmed'
  | 'not_required'
  | 'failed'
  | 'unknowable';

export type EnvironmentLeaseCleanupReason =
  | 'normal_exit'
  | 'signal'
  | 'cancellation'
  | 'timeout'
  | 'revoke'
  | 'startup_sweep'
  | 'crash_recovery';

export interface EnvironmentLeaseRecord {
  schemaVersion: 1;
  leaseId: string;
  owner: string;
  bundleDigest: string;
  memberNames: string[];
  consumer: string;
  holder: string;
  purposeDigest: string;
  authorizationId: string;
  authorizationExpiresAt: string;
  expiresAt: string;
  runnerFingerprint: string;
  materializerDigest: string;
  artifactPath: string;
  artifactPathClass: EnvironmentLeaseArtifactPathClass;
  artifactDevice: number;
  artifactInode: number;
  // Records written before birth-time identity omit this; cleanup never deletes their artifact.
  artifactBirthtimeNs?: string;
  artifactMode: number;
  artifactState: 'preparing' | 'ready';
  managerPid: number;
  consumerPid: number | null;
  createdAt: string;
  cleanupContractVersion: 1;
  cleanupState: EnvironmentLeaseCleanupState;
  cleanupReason: EnvironmentLeaseCleanupReason | null;
  cleanupAttemptId: string | null;
  cleanupAttemptedAt: string | null;
  cleanupCompletedAt: string | null;
  cleanupErrorCode: string | null;
}

export interface EnvironmentLeaseRuntimeRoot {
  root: string;
  pathClass: EnvironmentLeaseArtifactPathClass;
}

export interface EnvironmentLeaseMaterializationResult {
  record: EnvironmentLeaseRecord;
  artifactPath: string;
}

function platformRuntimeRoot(uid: number, temporaryDirectory: string): EnvironmentLeaseRuntimeRoot {
  let runtimeBase = temporaryDirectory;
  try {
    runtimeBase = realpathSync(temporaryDirectory);
  } catch {
    // Preparation performs the authoritative no-symlink and ownership checks.
  }
  if (!path.isAbsolute(runtimeBase)) throw new Error('Platform runtime directory must be absolute');
  return {
    root: path.join(runtimeBase, `siftable-vault-leases-${uid}`),
    pathClass: 'platform_runtime',
  };
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isOwnedByCurrentUser(info: {uid: number}): boolean {
  const uid = process.getuid?.();
  return uid === undefined || info.uid === uid;
}

function canonicalOwner(contract: EnvironmentBundleContract): string {
  return contract.owner.owner_type === 'personal'
    ? 'personal'
    : `workspace:${contract.owner.owner_id}`;
}

function assertSafeLabel(value: string, label: string): string {
  const normalized = value.trim();
  if (!SAFE_LABEL_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a bounded non-secret identifier`);
  }
  return normalized;
}

function assertIsoTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO 8601 timestamp`);
  }
  return timestamp;
}

function leaseDirectories(root: string): {artifacts: string; records: string} {
  return {
    artifacts: path.join(root, 'artifacts'),
    records: path.join(root, 'records'),
  };
}

export function environmentLeaseArtifactPath(runtimeRoot: string, leaseId: string): string {
  if (!UUID_PATTERN.test(leaseId)) throw new Error('Lease ID is invalid');
  return path.join(leaseDirectories(runtimeRoot).artifacts, `${leaseId}.env`);
}

async function assertNoSymlinkComponents(targetPath: string): Promise<void> {
  const parsed = path.parse(targetPath);
  const segments = targetPath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Lease path contains a symlink component: ${current}`);
      if (!info.isDirectory() && current !== targetPath) {
        throw new Error(`Lease path parent is not a directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function assertOutsideGitWorktree(targetPath: string): Promise<void> {
  let current = targetPath;
  while (true) {
    try {
      const marker = await lstat(path.join(current, '.git'));
      if (marker.isDirectory() || marker.isFile()) {
        throw new Error('Lease runtime root must be outside every Git worktree');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function resolveEnvironmentLeaseRuntimeRoot(input: {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  uid?: number;
  temporaryDirectory?: string;
  linuxRuntimeAvailable?: boolean;
} = {}): EnvironmentLeaseRuntimeRoot {
  const environment = input.environment ?? process.env;
  const platform = input.platform ?? process.platform;
  const uid = input.uid ?? process.getuid?.() ?? 0;
  const xdgRuntime = environment.XDG_RUNTIME_DIR;
  if (xdgRuntime && path.isAbsolute(xdgRuntime) && path.normalize(xdgRuntime) === xdgRuntime) {
    return {root: path.join(xdgRuntime, 'siftable', 'vault-leases'), pathClass: 'xdg_runtime'};
  }
  if (platform === 'linux') {
    const userRuntime = path.join('/run/user', String(uid));
    let available = input.linuxRuntimeAvailable;
    if (available === undefined) {
      try {
        const info = lstatSync(userRuntime);
        accessSync(userRuntime, fsConstants.W_OK | fsConstants.X_OK);
        available = info.isDirectory() && !info.isSymbolicLink() && isOwnedByCurrentUser(info);
      } catch {
        available = false;
      }
    }
    if (available) {
      return {root: path.join(userRuntime, 'siftable', 'vault-leases'), pathClass: 'tmpfs'};
    }
  }
  return platformRuntimeRoot(uid, input.temporaryDirectory ?? tmpdir());
}

export async function prepareEnvironmentLeaseRuntime(input: {
  workspaceRoot: string;
  runtime?: EnvironmentLeaseRuntimeRoot;
}): Promise<EnvironmentLeaseRuntimeRoot> {
  const workspaceRoot = await realpath(input.workspaceRoot);
  const runtime = input.runtime ?? resolveEnvironmentLeaseRuntimeRoot();
  if (!path.isAbsolute(runtime.root) || path.normalize(runtime.root) !== runtime.root) {
    throw new Error('Lease runtime root must be absolute and normalized');
  }
  if (isInside(workspaceRoot, runtime.root) || isInside(runtime.root, workspaceRoot)) {
    throw new Error('Lease runtime root must be outside every Git worktree');
  }
  await assertNoSymlinkComponents(runtime.root);
  await assertOutsideGitWorktree(runtime.root);
  const directories = leaseDirectories(runtime.root);
  await mkdir(directories.artifacts, {recursive: true, mode: 0o700});
  await mkdir(directories.records, {recursive: true, mode: 0o700});
  await assertNoSymlinkComponents(runtime.root);
  for (const directory of [runtime.root, directories.artifacts, directories.records]) {
    await chmod(directory, 0o700);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !isOwnedByCurrentUser(info)) {
      throw new Error('Lease runtime directory ownership or type is unsafe');
    }
  }
  return runtime;
}

function renderEnvironmentLease(
  contract: EnvironmentBundleContract,
  values: readonly Buffer[],
): Buffer {
  if (values.length !== contract.members.length) {
    throw new Error('Every exact environment bundle member must resolve before lease creation');
  }
  const chunks: Buffer[] = [Buffer.from(
    '# Sift ephemeral environment lease. Do not copy or persist.\n'
    + `# Bundle: ${contract.memberSetDigest}\n`,
    'utf8',
  )];
  try {
    for (let index = 0; index < contract.members.length; index += 1) {
      const value = values[index];
      if (!value || value.length === 0 || value.includes(0)) {
        throw new Error('Environment lease member is empty or malformed');
      }
      chunks.push(Buffer.from(
        `${contract.members[index]!.name}=${JSON.stringify(value.toString('utf8'))}\n`,
        'utf8',
      ));
    }
    return Buffer.concat(chunks);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function recordPath(runtimeRoot: string, leaseId: string): string {
  if (!UUID_PATTERN.test(leaseId)) throw new Error('Lease ID is invalid');
  return path.join(leaseDirectories(runtimeRoot).records, `${leaseId}.json`);
}

async function writeLeaseRecord(runtimeRoot: string, record: EnvironmentLeaseRecord): Promise<void> {
  const destination = recordPath(runtimeRoot, record.leaseId);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    await syncDirectory(path.dirname(destination));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, {force: true});
  }
}

function parseLeaseRecord(value: unknown): EnvironmentLeaseRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Partial<EnvironmentLeaseRecord>;
  const cleanupStates: EnvironmentLeaseCleanupState[] = ['pending', 'confirmed', 'not_required', 'failed', 'unknowable'];
  const cleanupReasons: EnvironmentLeaseCleanupReason[] = [
    'normal_exit', 'signal', 'cancellation', 'timeout', 'revoke',
    'startup_sweep', 'crash_recovery',
  ];
  const pathClasses: EnvironmentLeaseArtifactPathClass[] = ['xdg_runtime', 'tmpfs', 'platform_runtime'];
  if (item.schemaVersion !== 1 || typeof item.leaseId !== 'string' || !UUID_PATTERN.test(item.leaseId)
    || typeof item.owner !== 'string' || typeof item.bundleDigest !== 'string' || !SHA256_PATTERN.test(item.bundleDigest)
    || !Array.isArray(item.memberNames) || item.memberNames.some(name => typeof name !== 'string')
    || typeof item.consumer !== 'string' || typeof item.holder !== 'string'
    || typeof item.purposeDigest !== 'string' || !SHA256_PATTERN.test(item.purposeDigest)
    || typeof item.authorizationId !== 'string' || !UUID_PATTERN.test(item.authorizationId)
    || typeof item.authorizationExpiresAt !== 'string' || !Number.isFinite(Date.parse(item.authorizationExpiresAt))
    || typeof item.expiresAt !== 'string' || !Number.isFinite(Date.parse(item.expiresAt))
    || typeof item.runnerFingerprint !== 'string' || !SHA256_PATTERN.test(item.runnerFingerprint)
    || typeof item.materializerDigest !== 'string' || !SHA256_PATTERN.test(item.materializerDigest)
    || typeof item.artifactPath !== 'string' || !path.isAbsolute(item.artifactPath)
    || !pathClasses.includes(item.artifactPathClass as EnvironmentLeaseArtifactPathClass)
    || !Number.isFinite(item.artifactDevice) || !Number.isFinite(item.artifactInode)
    || (item.artifactBirthtimeNs !== undefined
      && (typeof item.artifactBirthtimeNs !== 'string' || !BIRTHTIME_NS_PATTERN.test(item.artifactBirthtimeNs)))
    || !Number.isFinite(item.artifactMode)
    || !['preparing', 'ready'].includes(item.artifactState ?? '')
    || !Number.isSafeInteger(item.managerPid) || Number(item.managerPid) <= 0
    || (item.consumerPid !== null && (!Number.isSafeInteger(item.consumerPid) || Number(item.consumerPid) <= 0))
    || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))
    || item.cleanupContractVersion !== 1
    || !cleanupStates.includes(item.cleanupState as EnvironmentLeaseCleanupState)
    || (item.cleanupReason !== null
      && !cleanupReasons.includes(item.cleanupReason as EnvironmentLeaseCleanupReason))
    || (item.cleanupAttemptId !== null
      && (typeof item.cleanupAttemptId !== 'string' || !UUID_PATTERN.test(item.cleanupAttemptId)))
    || (item.cleanupAttemptedAt !== null && typeof item.cleanupAttemptedAt !== 'string')
    || (item.cleanupCompletedAt !== null && typeof item.cleanupCompletedAt !== 'string')
    || (item.cleanupErrorCode !== null && typeof item.cleanupErrorCode !== 'string')) return undefined;
  return item as EnvironmentLeaseRecord;
}

export async function readEnvironmentLeaseRecord(
  runtimeRoot: string,
  leaseId: string,
): Promise<EnvironmentLeaseRecord | undefined> {
  try {
    const handle = await open(recordPath(runtimeRoot, leaseId), SAFE_READ_FLAGS);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.isSymbolicLink() || !isOwnedByCurrentUser(info) || info.size > 64 * 1024) {
        return undefined;
      }
      return parseLeaseRecord(JSON.parse(await handle.readFile('utf8')) as unknown);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function materializeEnvironmentLeaseArtifact(input: {
  contract: EnvironmentBundleContract;
  values: readonly Buffer[];
  leaseId: string;
  consumer: string;
  holder: string;
  purpose: string;
  authorizationId: string;
  authorizationExpiresAt: string;
  expiresAt: string;
  runnerFingerprint: string;
  materializerDigest: string;
  consumerPid?: number;
  runtime?: EnvironmentLeaseRuntimeRoot;
  onPrepared?: (record: EnvironmentLeaseRecord) => Promise<void>;
}): Promise<EnvironmentLeaseMaterializationResult> {
  if (environmentBundleMemberSetDigest(input.contract.members) !== input.contract.memberSetDigest) {
    throw new Error('Environment lease bundle changed after authorization');
  }
  const authorizationExpiry = assertIsoTimestamp(input.authorizationExpiresAt, 'authorizationExpiresAt');
  const leaseExpiry = assertIsoTimestamp(input.expiresAt, 'expiresAt');
  if (leaseExpiry <= Date.now() || leaseExpiry >= authorizationExpiry) {
    throw new Error('Lease expiry must be in the future and strictly earlier than its authorization');
  }
  if (!UUID_PATTERN.test(input.leaseId) || !UUID_PATTERN.test(input.authorizationId)) {
    throw new Error('Lease and authorization IDs must be UUIDs');
  }
  if (!SHA256_PATTERN.test(input.runnerFingerprint) || !SHA256_PATTERN.test(input.materializerDigest)) {
    throw new Error('Lease runner and materializer identities must be SHA-256 digests');
  }
  if (input.consumerPid !== undefined && (!Number.isSafeInteger(input.consumerPid) || input.consumerPid <= 0)) {
    throw new Error('Lease consumer PID must be a positive integer');
  }
  const consumer = assertSafeLabel(input.consumer, 'consumer');
  const holder = assertSafeLabel(input.holder, 'holder');
  const runtime = await prepareEnvironmentLeaseRuntime({
    workspaceRoot: input.contract.checkoutRoot,
    runtime: input.runtime,
  });
  const artifactPath = environmentLeaseArtifactPath(runtime.root, input.leaseId);
  if (isInside(input.contract.checkoutRoot, artifactPath)) {
    throw new Error('Lease artifact must be outside every Git worktree');
  }
  let rendered: Buffer | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let recordWritten = false;
  try {
    rendered = renderEnvironmentLease(input.contract, input.values);
    const requestedMode = input.contract.mode === '0400' ? 0o400 : 0o600;
    handle = await open(artifactPath, 'wx', requestedMode);
    await handle.chmod(requestedMode);
    const info = await handle.stat({bigint: true});
    if (!info.isFile() || info.isSymbolicLink() || !isOwnedByCurrentUser({uid: Number(info.uid)})
      || Number(info.mode & 0o777n) !== requestedMode) {
      throw new Error('Lease artifact type, ownership, or mode is unsafe');
    }
    await syncDirectory(path.dirname(artifactPath));
    let record: EnvironmentLeaseRecord = {
      schemaVersion: 1,
      leaseId: input.leaseId,
      owner: canonicalOwner(input.contract),
      bundleDigest: input.contract.memberSetDigest,
      memberNames: input.contract.members.map(member => member.name),
      consumer,
      holder,
      purposeDigest: createHash('sha256').update(input.purpose).digest('hex'),
      authorizationId: input.authorizationId,
      authorizationExpiresAt: input.authorizationExpiresAt,
      expiresAt: input.expiresAt,
      runnerFingerprint: input.runnerFingerprint,
      materializerDigest: input.materializerDigest,
      artifactPath,
      artifactPathClass: runtime.pathClass,
      artifactDevice: Number(info.dev),
      artifactInode: Number(info.ino),
      artifactBirthtimeNs: info.birthtimeNs.toString(),
      artifactMode: Number(info.mode & 0o777n),
      artifactState: 'preparing',
      managerPid: process.pid,
      consumerPid: input.consumerPid ?? null,
      createdAt: new Date().toISOString(),
      cleanupContractVersion: 1,
      cleanupState: 'pending',
      cleanupReason: null,
      cleanupAttemptId: null,
      cleanupAttemptedAt: null,
      cleanupCompletedAt: null,
      cleanupErrorCode: null,
    };
    await writeLeaseRecord(runtime.root, record);
    recordWritten = true;
    await input.onPrepared?.(record);
    await handle.writeFile(rendered);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(path.dirname(artifactPath));
    const releaseReadyLock = await acquireLeaseCleanupLock(runtime.root, input.leaseId);
    try {
      const current = await readEnvironmentLeaseRecord(runtime.root, input.leaseId);
      const currentArtifact = await lstat(artifactPath, {bigint: true}).catch(() => null);
      // Exact equality, zero included, keeps leases usable without btime; cleanup still refuses to delete those.
      if (!current || current.cleanupState !== 'pending'
        || !currentArtifact || !currentArtifact.isFile() || currentArtifact.isSymbolicLink()
        || Number(currentArtifact.dev) !== record.artifactDevice
        || Number(currentArtifact.ino) !== record.artifactInode
        || currentArtifact.birthtimeNs.toString() !== record.artifactBirthtimeNs) {
        throw new Error('Lease cleanup won the prepare-to-ready race');
      }
      record = {...current, artifactState: 'ready'};
      await writeLeaseRecord(runtime.root, record);
    } finally {
      await releaseReadyLock();
    }
    return {record, artifactPath};
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (recordWritten) {
      await cleanupEnvironmentLeaseArtifact({
        runtimeRoot: runtime.root,
        leaseId: input.leaseId,
        reason: 'cancellation',
      }).catch(() => undefined);
    } else {
      await rm(artifactPath, {force: true}).catch(() => undefined);
    }
    throw error;
  } finally {
    rendered?.fill(0);
    for (const value of input.values) value.fill(0);
  }
}

// ext4 hands a freed inode straight back, so dev and ino alone cannot tell a replacement apart.
// A zero or missing birth time cannot either, so it never authorizes deletion.
function artifactBirthtimeKnown(record: EnvironmentLeaseRecord, info: BigIntStats): boolean {
  return record.artifactBirthtimeNs !== undefined && record.artifactBirthtimeNs !== '0' && info.birthtimeNs !== 0n;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function cleanupEnvironmentLeaseArtifactUnlocked(input: {
  runtimeRoot: string;
  leaseId: string;
  reason: EnvironmentLeaseCleanupReason;
  attemptId?: string;
}): Promise<EnvironmentLeaseRecord> {
  const record = await readEnvironmentLeaseRecord(input.runtimeRoot, input.leaseId);
  if (!record) throw new Error('Environment lease record is missing or invalid');
  if (record.cleanupState === 'confirmed') return record;
  const expectedPath = environmentLeaseArtifactPath(input.runtimeRoot, input.leaseId);
  if (record.artifactPath !== expectedPath || !isInside(leaseDirectories(input.runtimeRoot).artifacts, record.artifactPath)) {
    const unknowable: EnvironmentLeaseRecord = {
      ...record,
      cleanupState: 'unknowable',
      cleanupReason: input.reason,
      cleanupAttemptId: input.attemptId ?? randomUUID(),
      cleanupAttemptedAt: new Date().toISOString(),
      cleanupErrorCode: 'artifact_path_mismatch',
    };
    await writeLeaseRecord(input.runtimeRoot, unknowable);
    return unknowable;
  }
  const attemptId = input.attemptId ?? randomUUID();
  const attemptedAt = new Date().toISOString();
  const quarantinePath = path.join(
    path.dirname(record.artifactPath),
    `.cleanup-${record.leaseId}-${attemptId}`,
  );
  try {
    await rename(record.artifactPath, quarantinePath);
    const info = await lstat(quarantinePath, {bigint: true});
    const sameInode = !info.isSymbolicLink() && info.isFile()
      && Number(info.dev) === record.artifactDevice && Number(info.ino) === record.artifactInode;
    const birthtimeKnown = artifactBirthtimeKnown(record, info);
    if (!sameInode || !birthtimeKnown || info.birthtimeNs.toString() !== record.artifactBirthtimeNs) {
      await link(quarantinePath, record.artifactPath)
        .then(() => rm(quarantinePath))
        .catch(() => undefined);
      const unknowable: EnvironmentLeaseRecord = {
        ...record,
        cleanupState: 'unknowable',
        cleanupReason: input.reason,
        cleanupAttemptId: attemptId,
        cleanupAttemptedAt: attemptedAt,
        cleanupErrorCode: sameInode && !birthtimeKnown
          ? 'artifact_identity_unverifiable'
          : 'artifact_identity_changed',
      };
      await writeLeaseRecord(input.runtimeRoot, unknowable);
      return unknowable;
    }
    await rm(quarantinePath);
    await syncDirectory(path.dirname(record.artifactPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const unknowable: EnvironmentLeaseRecord = {
        ...record,
        cleanupState: 'unknowable',
        cleanupReason: input.reason,
        cleanupAttemptId: attemptId,
        cleanupAttemptedAt: attemptedAt,
        cleanupErrorCode: 'artifact_missing_before_identity_preserving_delete',
      };
      await writeLeaseRecord(input.runtimeRoot, unknowable);
      return unknowable;
    } else {
      const failed: EnvironmentLeaseRecord = {
        ...record,
        cleanupState: 'failed',
        cleanupReason: input.reason,
        cleanupAttemptId: attemptId,
        cleanupAttemptedAt: attemptedAt,
        cleanupErrorCode: (error as NodeJS.ErrnoException).code ?? 'cleanup_failed',
      };
      await writeLeaseRecord(input.runtimeRoot, failed);
      return failed;
    }
  }
  const confirmed: EnvironmentLeaseRecord = {
    ...record,
    cleanupState: 'confirmed',
    cleanupReason: input.reason,
    cleanupAttemptId: attemptId,
    cleanupAttemptedAt: attemptedAt,
    cleanupCompletedAt: new Date().toISOString(),
    cleanupErrorCode: null,
  };
  await writeLeaseRecord(input.runtimeRoot, confirmed);
  return confirmed;
}

async function acquireLeaseCleanupLock(runtimeRoot: string, leaseId: string): Promise<() => Promise<void>> {
  const lockPath = path.join(leaseDirectories(runtimeRoot).records, `${leaseId}.cleanup.lock`);
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      await syncDirectory(path.dirname(lockPath));
      return async () => {
        await rm(lockPath, {force: true});
        await syncDirectory(path.dirname(lockPath));
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await lstat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 10_000) {
        await rm(lockPath, {force: true});
        continue;
      }
      if (Date.now() - startedAt > 15_000) throw new Error('Environment lease cleanup lock timed out');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

export async function adoptEnvironmentLeaseManager(input: {
  runtimeRoot: string;
  leaseId: string;
  managerPid: number;
}): Promise<EnvironmentLeaseRecord> {
  if (!Number.isSafeInteger(input.managerPid) || input.managerPid <= 0) {
    throw new Error('Environment lease manager PID is invalid');
  }
  const release = await acquireLeaseCleanupLock(input.runtimeRoot, input.leaseId);
  try {
    const record = await readEnvironmentLeaseRecord(input.runtimeRoot, input.leaseId);
    if (!record || record.cleanupState !== 'pending') {
      throw new Error('Environment lease cannot transfer manager ownership');
    }
    const adopted = {...record, managerPid: input.managerPid};
    await writeLeaseRecord(input.runtimeRoot, adopted);
    return adopted;
  } finally {
    await release();
  }
}

export async function cleanupEnvironmentLeaseArtifact(input: {
  runtimeRoot: string;
  leaseId: string;
  reason: EnvironmentLeaseCleanupReason;
  attemptId?: string;
}): Promise<EnvironmentLeaseRecord> {
  const release = await acquireLeaseCleanupLock(input.runtimeRoot, input.leaseId);
  try {
    return await cleanupEnvironmentLeaseArtifactUnlocked(input);
  } finally {
    await release();
  }
}

export async function listEnvironmentLeaseRecords(
  runtimeRoot: string,
): Promise<EnvironmentLeaseRecord[]> {
  const recordsDirectory = leaseDirectories(runtimeRoot).records;
  const {readdir} = await import('node:fs/promises');
  const names = await readdir(recordsDirectory).catch(() => [] as string[]);
  const records = await Promise.all(names
    .filter(name => UUID_PATTERN.test(name.slice(0, -5)) && name.endsWith('.json'))
    .map(name => readEnvironmentLeaseRecord(runtimeRoot, name.slice(0, -5))));
  return records.filter((record): record is EnvironmentLeaseRecord => Boolean(record));
}

export async function removeEnvironmentLeaseRecord(
  runtimeRoot: string,
  leaseId: string,
): Promise<void> {
  const recordsDirectory = leaseDirectories(runtimeRoot).records;
  await rm(recordPath(runtimeRoot, leaseId), {force: true});
  await syncDirectory(recordsDirectory);
}

export async function sweepEnvironmentLeases(input: {
  runtimeRoot: string;
  now?: number;
}): Promise<EnvironmentLeaseRecord[]> {
  const now = input.now ?? Date.now();
  const records = await listEnvironmentLeaseRecords(input.runtimeRoot);
  const cleaned: EnvironmentLeaseRecord[] = [];
  for (const record of records) {
    if (record.cleanupState === 'confirmed') {
      if (record.cleanupAttemptId && record.cleanupReason) cleaned.push(record);
      continue;
    }
    const managerExited = !processIsAlive(record.managerPid);
    const consumerExited = record.consumerPid !== null && !processIsAlive(record.consumerPid);
    if (Date.parse(record.expiresAt) <= now || managerExited || consumerExited) {
      cleaned.push(await cleanupEnvironmentLeaseArtifact({
        runtimeRoot: input.runtimeRoot,
        leaseId: record.leaseId,
        reason: managerExited || consumerExited ? 'crash_recovery' : 'startup_sweep',
      }));
    }
  }
  return cleaned;
}

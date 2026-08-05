import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {execFile} from 'node:child_process';
import {constants as fsConstants} from 'node:fs';
import {lstat, mkdir, open, readFile, rename, rm} from 'node:fs/promises';
import {hostname} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {materializeApprovedPlaintext, validateMaterializationPath} from './localMaterializer.js';
import {
  manifestFingerprint,
  readEnvironmentReceiptLedger,
  writeEnvironmentReceiptLedger,
} from './environmentState.js';
import type {
  EnvironmentFileMode,
  EnvironmentManifest,
  EnvironmentOwner,
  VaultFieldEnvironmentMember,
} from './environmentManifest.js';

const SAFE_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const execFileAsync = promisify(execFile);
const LOCK_STALE_AFTER_MILLISECONDS = 10 * 60 * 1000;

export interface EnvironmentBundleMember {
  name: string;
  entryId: string;
  field: string;
}

export interface EnvironmentBundleContract {
  owner: EnvironmentOwner;
  ownerAlias: string;
  checkoutRoot: string;
  destinationPath: string;
  relativeDestination: string;
  mode: EnvironmentFileMode;
  members: EnvironmentBundleMember[];
  memberSetDigest: string;
}

export interface ManagedEnvironmentBundleReceipt {
  schemaVersion: 1;
  destination: string;
  mode: EnvironmentFileMode;
  memberSetDigest: string;
  writtenAt: string;
  stat: {device: number; inode: number; mode: number; mtimeMs: number; ctimeMs: number};
}

export interface ManagedEnvironmentObservedState {
  device: number;
  inode: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
}

const PRIVATE_OBSERVED_DIGEST = Symbol('sift.environment.privateObservedDigest');
type PrivateObservedDigest = {[PRIVATE_OBSERVED_DIGEST]: string};

export type ManagedEnvironmentBundleInspection =
  | {state: 'absent'; observedState?: undefined}
  | ({state: 'managed_current'; observedState: ManagedEnvironmentObservedState} & PrivateObservedDigest)
  | ({state: 'modified_locally'; observedState: ManagedEnvironmentObservedState} & PrivateObservedDigest)
  | ({state: 'managed_stale'; observedState: ManagedEnvironmentObservedState} & PrivateObservedDigest);

export function privateObservedEnvironmentDigest(
  inspection: ManagedEnvironmentBundleInspection,
): string | undefined {
  return inspection.state === 'absent' ? undefined : inspection[PRIVATE_OBSERVED_DIGEST];
}

interface ManagedEnvironmentBundleLedger {
  schemaVersion: 1;
  receipts: ManagedEnvironmentBundleReceipt[];
}

function isReceipt(value: unknown): value is ManagedEnvironmentBundleReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const allowed = ['schemaVersion', 'destination', 'mode', 'memberSetDigest', 'writtenAt', 'stat'];
  if (Object.keys(receipt).some(key => !allowed.includes(key))) return false;
  const stat = receipt.stat as Record<string, unknown> | undefined;
  return receipt.schemaVersion === 1
    && typeof receipt.destination === 'string'
    && (receipt.mode === '0400' || receipt.mode === '0600')
    && typeof receipt.memberSetDigest === 'string' && DIGEST_PATTERN.test(receipt.memberSetDigest)
    && typeof receipt.writtenAt === 'string'
    && typeof stat === 'object' && stat !== null
    && Object.keys(stat).sort().join(',') === 'ctimeMs,device,inode,mode,mtimeMs'
    && Object.values(stat).every(item => typeof item === 'number' && Number.isFinite(item));
}

export async function readManagedEnvironmentBundleReceipt(
  contract: EnvironmentBundleContract,
): Promise<ManagedEnvironmentBundleReceipt | undefined> {
  try {
    const parsed = JSON.parse(await readFile(
      path.join(contract.checkoutRoot, '.sift', 'environment-bundle-state.json'),
      'utf8',
    )) as Partial<ManagedEnvironmentBundleLedger>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.receipts)) return undefined;
    return parsed.receipts.find(receipt => isReceipt(receipt)
      && receipt.destination === contract.relativeDestination
      && receipt.memberSetDigest === contract.memberSetDigest);
  } catch {
    return undefined;
  }
}

export async function writeManagedEnvironmentBundleReceipt(
  contract: EnvironmentBundleContract,
  receipt: ManagedEnvironmentBundleReceipt,
): Promise<void> {
  if (!isReceipt(receipt) || receipt.destination !== contract.relativeDestination
    || receipt.memberSetDigest !== contract.memberSetDigest) {
    throw new Error('Managed environment bundle receipt is invalid');
  }
  const directory = path.join(contract.checkoutRoot, '.sift');
  await mkdir(directory, {recursive: true, mode: 0o700});
  const existingText = await readFile(path.join(directory, 'environment-bundle-state.json'), 'utf8').catch(() => '');
  let receipts: ManagedEnvironmentBundleReceipt[] = [];
  try {
    const parsed = JSON.parse(existingText) as Partial<ManagedEnvironmentBundleLedger>;
    if (parsed.schemaVersion === 1 && Array.isArray(parsed.receipts)) {
      receipts = parsed.receipts.filter(isReceipt);
    }
  } catch {
    receipts = [];
  }
  receipts = receipts.filter(item => item.destination !== receipt.destination);
  receipts.push(receipt);
  const temporaryPath = path.join(directory, `.environment-bundle-state.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({schemaVersion: 1, receipts}, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path.join(directory, 'environment-bundle-state.json'));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, {force: true});
  }

  const rawManifest = await readFile(path.join(contract.checkoutRoot, '.sift', 'environment.yaml'), 'utf8');
  const legacyLedger = await readEnvironmentReceiptLedger(contract.checkoutRoot);
  const selectedKeys = new Set(contract.members.map(member => (
    `${member.name}\u0000${contract.relativeDestination}`
  )));
  await writeEnvironmentReceiptLedger(contract.checkoutRoot, {
    schema_version: 1,
    receipts: [
      ...(legacyLedger?.receipts ?? []).filter(item => (
        !selectedKeys.has(`${item.name}\u0000${item.destination}`)
      )),
      ...contract.members.map(member => ({
        name: member.name,
        destination: contract.relativeDestination,
        mode: contract.mode,
        manifest_fingerprint: manifestFingerprint(rawManifest),
        materialized_at: receipt.writtenAt,
        stat: {
          device: receipt.stat.device,
          inode: receipt.stat.inode,
          mode: receipt.stat.mode,
          mtime_ms: receipt.stat.mtimeMs,
          ctime_ms: receipt.stat.ctimeMs,
        },
      })),
    ],
  });
}

function canonicalMemberSet(members: readonly EnvironmentBundleMember[]): string {
  return JSON.stringify(members.map(member => ({
    name: member.name,
    vaultEntryId: member.entryId,
    credentialField: member.field,
  })));
}

export function environmentBundleMemberSetDigest(
  members: readonly EnvironmentBundleMember[],
): string {
  if (members.length === 0 || members.length > 64) {
    throw new Error('Environment bundle must contain between 1 and 64 exact members');
  }
  return createHash('sha256').update(canonicalMemberSet(members), 'utf8').digest('hex');
}

export function buildEnvironmentBundleContract(
  manifest: EnvironmentManifest,
  checkoutRoot: string,
  relativeDestination: string,
): EnvironmentBundleContract {
  if (!path.isAbsolute(checkoutRoot) || path.normalize(checkoutRoot) !== checkoutRoot) {
    throw new Error('Environment checkout root must be absolute and normalized');
  }
  const selected = manifest.members.filter((member): member is VaultFieldEnvironmentMember => (
    member.kind === 'vault_field' && member.destination.path === relativeDestination
  ));
  if (selected.length === 0) throw new Error('Environment bundle has no Vault members');
  const ownerAlias = selected[0].owner;
  const mode = selected[0].destination.mode;
  if (selected.some(member => member.owner !== ownerAlias
    || member.destination.mode !== mode
    || member.destination.path !== relativeDestination)) {
    throw new Error('Environment bundle members must share one owner, destination, and mode');
  }
  const owner = manifest.owners[ownerAlias];
  if (!owner) throw new Error('Environment bundle owner is not declared');
  const destinationPath = path.resolve(checkoutRoot, relativeDestination);
  const relative = path.relative(checkoutRoot, destinationPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Environment bundle destination must be inside the checkout root');
  }
  const members = selected.map(member => ({
    name: member.name,
    entryId: member.entry_id,
    field: member.field,
  }));
  if (new Set(members.map(member => member.name)).size !== members.length) {
    throw new Error('Environment bundle member names must be unique');
  }
  return {
    owner,
    ownerAlias,
    checkoutRoot,
    destinationPath,
    relativeDestination,
    mode,
    members,
    memberSetDigest: environmentBundleMemberSetDigest(members),
  };
}

export async function assertManagedEnvironmentBundleGitSafety(
  contract: EnvironmentBundleContract,
): Promise<void> {
  const options = {
    cwd: contract.checkoutRoot,
    encoding: 'utf8' as const,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    },
  };
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], options);
  } catch {
    throw new Error('Managed environment pull requires a Git checkout');
  }
  try {
    await execFileAsync(
      'git',
      ['ls-files', '--error-unmatch', '--', contract.relativeDestination],
      options,
    );
    throw new Error('Managed environment destination is tracked by Git');
  } catch (error) {
    if (error instanceof Error && error.message === 'Managed environment destination is tracked by Git') throw error;
  }
  try {
    for (const ignoredPath of [
      contract.relativeDestination,
      `${contract.relativeDestination}.sift-lock`,
    ]) {
      await execFileAsync(
        'git',
        ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '-q', '--', ignoredPath],
        options,
      );
    }
  } catch {
    throw new Error('Managed environment destination and lock sidecar must be ignored by repository policy');
  }
}

async function inspectDestinationState(destinationPath: string): Promise<ManagedEnvironmentObservedState | undefined> {
  try {
    const handle = await open(destinationPath, SAFE_READ_FLAGS);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Managed destination is unsafe');
      return {
        device: info.dev,
        inode: info.ino,
        mode: info.mode & 0o777,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function inspectManagedEnvironmentBundle(
  contract: EnvironmentBundleContract,
  receipt?: ManagedEnvironmentBundleReceipt,
): Promise<ManagedEnvironmentBundleInspection> {
  const observedState = await inspectDestinationState(contract.destinationPath);
  if (!observedState) return {state: 'absent'};
  const privateObservedDigest = await privateDestinationDigest(contract.destinationPath);
  if (!privateObservedDigest) throw new Error('Managed destination changed during inspection');
  if (!receipt || receipt.destination !== contract.relativeDestination
    || receipt.memberSetDigest !== contract.memberSetDigest || receipt.mode !== contract.mode) {
    return {state: 'managed_stale', observedState, [PRIVATE_OBSERVED_DIGEST]: privateObservedDigest};
  }
  const info = await lstat(contract.destinationPath);
  const unchanged = receipt.stat.device === info.dev
    && receipt.stat.inode === info.ino
    && receipt.stat.mode === (info.mode & 0o777)
    && receipt.stat.mtimeMs === info.mtimeMs
    && receipt.stat.ctimeMs === info.ctimeMs;
  return unchanged
    ? {state: 'managed_current', observedState, [PRIVATE_OBSERVED_DIGEST]: privateObservedDigest}
    : {state: 'modified_locally', observedState, [PRIVATE_OBSERVED_DIGEST]: privateObservedDigest};
}

function sameObservedState(
  left: ManagedEnvironmentObservedState | undefined,
  right: ManagedEnvironmentObservedState | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function privateDestinationDigest(destinationPath: string): Promise<string | undefined> {
  try {
    const handle = await open(destinationPath, SAFE_READ_FLAGS);
    try {
      return createHash('sha256').update(await handle.readFile()).digest('hex');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function privateDigestEquals(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right || !DIGEST_PATTERN.test(left) || !DIGEST_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

interface EnvironmentLockMetadata {
  schemaVersion: 1;
  lockId: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

function isLockMetadata(value: unknown): value is EnvironmentLockMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === 1
    && typeof item.lockId === 'string' && /^[0-9a-f-]{36}$/i.test(item.lockId)
    && Number.isSafeInteger(item.pid) && Number(item.pid) > 0
    && typeof item.hostname === 'string' && item.hostname.length > 0 && item.hostname.length <= 255
    && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt));
}

function processIsPlausiblyLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readEnvironmentLock(lockPath: string): Promise<{
  metadata: EnvironmentLockMetadata;
  device: number;
  inode: number;
} | undefined> {
  try {
    const handle = await open(lockPath, SAFE_READ_FLAGS);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.size > 4096) {
        return undefined;
      }
      const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
      return isLockMetadata(parsed) ? {metadata: parsed, device: info.dev, inode: info.ino} : undefined;
    } catch {
      return undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function acquireEnvironmentLock(lockPath: string): Promise<{
  handle: Awaited<ReturnType<typeof open>>;
  metadata: EnvironmentLockMetadata;
}> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const metadata: EnvironmentLockMetadata = {
      schemaVersion: 1,
      lockId: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    };
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
        await handle.sync();
        return {handle, metadata};
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, {force: true});
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw error;
      const existing = await readEnvironmentLock(lockPath);
      if (!existing) throw new Error('Another environment materialization holds the destination lock');
      const age = Date.now() - Date.parse(existing.metadata.createdAt);
      const localLive = existing.metadata.hostname === hostname()
        && processIsPlausiblyLive(existing.metadata.pid);
      if (localLive || age < LOCK_STALE_AFTER_MILLISECONDS) {
        throw new Error('Another environment materialization holds the destination lock');
      }
      const current = await lstat(lockPath).catch(() => undefined);
      if (!current || current.isSymbolicLink() || !current.isFile()
        || current.dev !== existing.device || current.ino !== existing.inode) {
        throw new Error('Another environment materialization holds the destination lock');
      }
      await rm(lockPath);
    }
  }
  throw new Error('Another environment materialization holds the destination lock');
}

async function releaseEnvironmentLock(
  lockPath: string,
  lock: {handle: Awaited<ReturnType<typeof open>>; metadata: EnvironmentLockMetadata},
): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  const current = await readEnvironmentLock(lockPath);
  if (current?.metadata.lockId === lock.metadata.lockId) await rm(lockPath, {force: true});
}

function renderManagedBundle(
  contract: EnvironmentBundleContract,
  values: readonly Buffer[],
): Buffer {
  if (values.length !== contract.members.length) {
    throw new Error('Every approved environment bundle member must resolve before commit');
  }
  const chunks: Buffer[] = [Buffer.from(
    '# Sift-managed environment bundle. Do not edit.\n'
    + `# Contract: ${contract.memberSetDigest}\n`
    + '# Local overrides: use .env.local or the framework-equivalent override file.\n',
    'utf8',
  )];
  try {
    for (let index = 0; index < contract.members.length; index += 1) {
      const value = values[index];
      if (!value || value.includes(0)) throw new Error('Environment bundle member is missing or malformed');
      const escaped = JSON.stringify(value.toString('utf8'));
      chunks.push(Buffer.from(`${contract.members[index].name}=${escaped}\n`, 'utf8'));
    }
    return Buffer.concat(chunks);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

export async function materializeManagedEnvironmentBundle(input: {
  contract: EnvironmentBundleContract;
  values: readonly Buffer[];
  expectedAbsence: boolean;
  expectedDestinationState?: ManagedEnvironmentObservedState;
  expectedDestinationDigest?: string;
  replacementConsentState?: ManagedEnvironmentObservedState;
  beforeCommit?: () => Promise<void>;
  onCommitted?: () => void;
  onCleanup?: (succeeded: boolean) => void;
}): Promise<ManagedEnvironmentBundleReceipt> {
  const lockPath = `${input.contract.destinationPath}.sift-lock`;
  let lock: Awaited<ReturnType<typeof acquireEnvironmentLock>> | undefined;
  let rendered: Buffer | undefined;
  try {
    if (environmentBundleMemberSetDigest(input.contract.members) !== input.contract.memberSetDigest) {
      throw new Error('Environment bundle member set changed after approval');
    }
    if (!input.expectedAbsence && (!input.expectedDestinationState
      || !DIGEST_PATTERN.test(input.expectedDestinationDigest ?? '')
      || !sameObservedState(input.replacementConsentState, input.expectedDestinationState))) {
      throw new Error('Modified managed files require replacement consent bound to the exact observation');
    }
    rendered = renderManagedBundle(input.contract, input.values);
    await validateMaterializationPath({
      destinationPath: input.contract.destinationPath,
      workspaceRoot: input.contract.checkoutRoot,
    });
    lock = await acquireEnvironmentLock(lockPath);
    const lockedState = await inspectDestinationState(input.contract.destinationPath);
    if (input.expectedAbsence ? lockedState !== undefined : !sameObservedState(lockedState, input.expectedDestinationState)) {
      throw new Error('Managed destination state changed after approval');
    }
    const privatePreconditionDigest = input.expectedAbsence
      ? undefined
      : await privateDestinationDigest(input.contract.destinationPath);
    if (!input.expectedAbsence
      && !privateDigestEquals(privatePreconditionDigest, input.expectedDestinationDigest)) {
      throw new Error('Managed destination contents changed after approval');
    }
    await materializeApprovedPlaintext({
      plaintext: rendered,
      destinationPath: input.contract.destinationPath,
      workspaceRoot: input.contract.checkoutRoot,
      mode: input.contract.mode,
      expectedAbsence: input.expectedAbsence,
      expectedDestinationDigest: privatePreconditionDigest,
      trackedFileException: false,
      policyAllowsTrackedException: false,
      riskPolicyAcknowledged: true,
      onCommitted: input.onCommitted,
      onCleanup: input.onCleanup,
      beforeCommit: async () => {
        await input.beforeCommit?.();
        await assertManagedEnvironmentBundleGitSafety(input.contract);
        const currentState = await inspectDestinationState(input.contract.destinationPath);
        if (input.expectedAbsence ? currentState !== undefined : !sameObservedState(currentState, input.expectedDestinationState)) {
          throw new Error('Managed destination state changed before commit');
        }
        if (!input.expectedAbsence) {
          const currentDigest = await privateDestinationDigest(input.contract.destinationPath);
          if (!privateDigestEquals(currentDigest, input.expectedDestinationDigest)) {
            throw new Error('Managed destination contents changed before commit');
          }
        }
      },
    });
    const info = await lstat(input.contract.destinationPath);
    return {
      schemaVersion: 1,
      destination: input.contract.relativeDestination,
      mode: input.contract.mode,
      memberSetDigest: input.contract.memberSetDigest,
      writtenAt: new Date().toISOString(),
      stat: {
        device: info.dev,
        inode: info.ino,
        mode: info.mode & 0o777,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
      },
    };
  } finally {
    rendered?.fill(0);
    for (const value of input.values) value.fill(0);
    if (lock) await releaseEnvironmentLock(lockPath, lock);
  }
}

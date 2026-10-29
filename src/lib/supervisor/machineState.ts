/**
 * The machine supervisor's state directory (first-run U2c), owned by the
 * siftable-supervisor account, never a user's HOME.
 *
 *   enrollment-key.pem   Ed25519 private key, PKCS#8, 0600
 *   pending.json         journal of an enrollment in progress, written before any network call
 *   credential.json      the supervisor PAT, 0600
 *   machine.json         the commit marker, written last
 *   retired/<time>/      earlier enrollments; their keys still sign historical cleanup (U2d)
 *
 * Every write is to a temp file that is fsynced, then renamed and the
 * directory fsynced. Symlinks anywhere in the state are refused.
 */
import {randomBytes} from 'node:crypto';
import {constants, promises as fs} from 'node:fs';
import path from 'node:path';
import type {MachineScope} from './machineProtocol.js';

export const SUPERVISOR_STATE_DIR = '/var/lib/siftable-supervisor';
const FILES = {key: 'enrollment-key.pem', pending: 'pending.json', credential: 'credential.json', machine: 'machine.json'} as const;

export interface MachineStateOptions {
  root: string;
  /** Owner of every file; null leaves ownership to the process (tests). */
  owner: {uid: number; gid: number} | null;
}

export interface PendingEnrollment {
  version: 1;
  apiUrl: string;
  scope: MachineScope;
  runnerId: string;
  fingerprint: string;
  publicKey: string;
  setupId?: string;
  /** delivery_unknown: an approval may have delivered the one-time token, and the reply was lost. */
  state: 'requesting' | 'polling' | 'delivery_unknown';
  device?: {deviceCode: string; userCode: string; verificationUriComplete: string; expiresAt: string; interval: number};
  createdAt: string;
}

export interface MachineRecord {
  version: 1;
  apiUrl: string;
  enrollmentId: string;
  runnerId: string;
  fingerprint: string;
  scope: MachineScope;
  setupId?: string;
  enrolledAt: string;
}

export type MachineStateKind =
  | {kind: 'empty'}
  | {kind: 'pending'; pending: PendingEnrollment}
  | {kind: 'enrolled'; machine: MachineRecord}
  | {kind: 'partial'; present: string[]};

export class MachineStateError extends Error {}

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } catch (error) {
    // macOS refuses fsync on a directory handle; Linux, where the supervisor runs, supports it.
    if (!['EINVAL', 'EISDIR', 'EBADF', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally {
    await handle.close();
  }
}

/** Creates the directory 0700 for its owner, refusing a symlink or a non-directory. */
export async function ensureStateDirectory(options: MachineStateOptions, directory = options.root): Promise<void> {
  const existing = await lstatOrNull(directory);
  if (existing?.isSymbolicLink()) throw new MachineStateError(`${directory} is a symlink; refusing to use it`);
  if (existing && !existing.isDirectory()) throw new MachineStateError(`${directory} is not a directory`);
  if (!existing) await fs.mkdir(directory, {recursive: true, mode: 0o700});
  if (options.owner) await fs.chown(directory, options.owner.uid, options.owner.gid);
  await fs.chmod(directory, 0o700);
}

async function writeFileAtomic(options: MachineStateOptions, name: string, content: string): Promise<void> {
  const target = path.join(options.root, name);
  const existing = await lstatOrNull(target);
  if (existing && !existing.isFile()) throw new MachineStateError(`${target} is not a regular file; refusing to replace it`);
  const temp = path.join(options.root, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    if (options.owner) await handle.chown(options.owner.uid, options.owner.gid);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, target);
  await syncDirectory(options.root);
}

async function readRegularFile(options: MachineStateOptions, name: string): Promise<string | null> {
  const target = path.join(options.root, name);
  const existing = await lstatOrNull(target);
  if (!existing) return null;
  if (!existing.isFile()) throw new MachineStateError(`${target} is not a regular file`);
  if ((existing.mode & 0o077) !== 0) throw new MachineStateError(`${target} is readable by others (mode ${(existing.mode & 0o777).toString(8)})`);
  if (options.owner && existing.uid !== options.owner.uid) throw new MachineStateError(`${target} is not owned by the supervisor account`);
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export const writeKey = (options: MachineStateOptions, pem: string) => writeFileAtomic(options, FILES.key, pem);
export const readKey = (options: MachineStateOptions) => readRegularFile(options, FILES.key);
export const writePending = (options: MachineStateOptions, pending: PendingEnrollment) =>
  writeFileAtomic(options, FILES.pending, `${JSON.stringify(pending, null, 2)}\n`);
export const writeCredential = (options: MachineStateOptions, token: string) =>
  writeFileAtomic(options, FILES.credential, `${JSON.stringify({token})}\n`);

export async function readCredential(options: MachineStateOptions): Promise<string | null> {
  const raw = await readRegularFile(options, FILES.credential);
  if (raw === null) return null;
  const token = (JSON.parse(raw) as {token?: unknown}).token;
  if (typeof token !== 'string' || token.length === 0) throw new MachineStateError('credential.json has no token');
  return token;
}

/** Commits an enrollment: machine.json is written last, then the journal is removed. */
export async function commitMachine(options: MachineStateOptions, machine: MachineRecord): Promise<void> {
  await writeFileAtomic(options, FILES.machine, `${JSON.stringify(machine, null, 2)}\n`);
  await fs.rm(path.join(options.root, FILES.pending), {force: true});
  await syncDirectory(options.root);
}

/** What the directory holds. Anything that is not exactly empty, pending or enrolled is partial. */
export async function inspectMachineState(options: MachineStateOptions): Promise<MachineStateKind> {
  const present: string[] = [];
  for (const name of Object.values(FILES)) {
    const entry = await lstatOrNull(path.join(options.root, name));
    if (entry?.isSymbolicLink()) throw new MachineStateError(`${name} is a symlink; refusing to use it`);
    if (entry) present.push(name);
  }
  const has = (name: string) => present.includes(name);
  if (has(FILES.machine)) {
    if (!has(FILES.key) || !has(FILES.credential)) return {kind: 'partial', present};
    return {kind: 'enrolled', machine: JSON.parse((await readRegularFile(options, FILES.machine)) as string) as MachineRecord};
  }
  if (has(FILES.pending)) {
    if (!has(FILES.key) || has(FILES.credential)) return {kind: 'partial', present};
    return {kind: 'pending', pending: JSON.parse((await readRegularFile(options, FILES.pending)) as string) as PendingEnrollment};
  }
  return present.length === 0 ? {kind: 'empty'} : {kind: 'partial', present};
}

/**
 * One enrollment at a time per machine. The lock file holds the owner's pid;
 * a lock whose process is gone is taken over by renaming it aside, so of two
 * contenders only one wins.
 */
export async function acquireStateLock(options: MachineStateOptions, pid = process.pid): Promise<() => Promise<void>> {
  const lock = path.join(options.root, '.enroll.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(JSON.stringify({pid, startedAt: new Date().toISOString()}));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => { await fs.rm(lock, {force: true}); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = await lstatOrNull(lock);
    if (holder && !holder.isFile()) throw new MachineStateError(`${lock} is not a regular file`);
    let owner: number | undefined;
    try {
      owner = (JSON.parse(await fs.readFile(lock, 'utf8')) as {pid?: number}).pid;
    } catch {
      owner = undefined;
    }
    if (typeof owner === 'number' && processAlive(owner)) {
      throw new MachineStateError(`Another enrollment is running on this machine (pid ${owner}). Wait for it to finish.`);
    }
    try {
      await fs.rename(lock, `${lock}.stale-${randomBytes(4).toString('hex')}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new MachineStateError('Could not take the enrollment lock; run the command again.');
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Moves every state file into retired/<time>/; nothing is deleted. */
export async function retireMachineState(options: MachineStateOptions, now: Date): Promise<string> {
  const retiredRoot = path.join(options.root, 'retired');
  await ensureStateDirectory(options, retiredRoot);
  const destination = path.join(retiredRoot, now.toISOString().replace(/[:.]/g, '-'));
  await ensureStateDirectory(options, destination);
  for (const name of Object.values(FILES)) {
    const source = path.join(options.root, name);
    const entry = await lstatOrNull(source);
    if (!entry) continue;
    if (entry.isSymbolicLink()) throw new MachineStateError(`${name} is a symlink; refusing to move it`);
    await fs.rename(source, path.join(destination, name));
  }
  await syncDirectory(destination);
  await syncDirectory(options.root);
  return destination;
}

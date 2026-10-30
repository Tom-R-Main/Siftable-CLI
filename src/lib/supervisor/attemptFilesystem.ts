/**
 * Each attempt's own filesystem (first-run U5b-2c, checkout contract rev 5).
 * A preallocated ext4 image, loop-mounted by the root supervisor, holds every
 * byte the attempt's containers write: the fetched objects, the checkout, the
 * dependencies and the writer's changes. The kernel bounds bytes, fallocate
 * and inodes inside it, and the host pays exactly the image size.
 *
 * The reservation has to survive discard. mkfs.ext4 discards by default and
 * fstrim does later, either of which hands the image's blocks back to the
 * host. So mkfs runs with nodiscard, discard is disabled on the exact loop
 * device and read back before every mount, recovery included, and the
 * image's allocated blocks are checked after each step. The machine's global
 * fstrim is never touched.
 *
 * Every identity (image path, device and inode, loop device, filesystem
 * UUID) is journaled before it is relied on. A mount is used only when it is
 * the journaled loop device with the journaled UUID, and the image is
 * unlinked only after the mount and every loop device on it are shown gone.
 */
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {execSystemTool} from './systemAccount.js';

export const ATTEMPT_FS_BYTES = 10 * 1024 ** 3;
/** The host keeps at least this much free after the image is reserved. */
export const HOST_FREE_FLOOR_BYTES = 2 * 1024 ** 3;
export const ATTEMPT_FS_INODES = 400_000;
export const ATTEMPT_FS_DIRS = ['src', 'work', 'deps'] as const;
export const SANDBOX_UID = 10_001;

export interface AttemptFsRecord {
  image: string;
  mountPoint: string;
  /** The image file's identity, so recovery never attaches a replaced file. */
  imageDev?: number;
  imageIno?: number;
  loop?: string;
  uuid?: string;
  /** The filesystem's real inode count (statfs), whatever mkfs was asked for. */
  inodes?: number;
  state: 'reserving' | 'formatted' | 'mounted' | 'released';
}

export interface AttemptFsSystem {
  /** Runs a system tool by absolute path, without a shell. */
  run(file: string, args: string[]): Promise<{code: number; stdout: string; stderr: string}>;
  stat(file: string): Promise<{dev: number; ino: number; blocks: number} | null>;
  statfs(dir: string): Promise<{bavail: number; bsize: number; files: number}>;
  readFile(file: string): Promise<string>;
  writeFile(file: string, data: string): Promise<void>;
  mkdir(dir: string, mode: number): Promise<void>;
  chown(file: string, uid: number, gid: number): Promise<void>;
  unlink(file: string): Promise<void>;
  rmdir(dir: string): Promise<void>;
}

export class AttemptFsError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
  }
}

const tools = {
  fallocate: '/usr/bin/fallocate', mkfs: '/sbin/mkfs.ext4', losetup: '/sbin/losetup', mount: '/bin/mount',
  umount: '/bin/umount', findmnt: '/bin/findmnt', blkid: '/sbin/blkid',
};

async function must(sys: AttemptFsSystem, code: string, file: string, args: string[]): Promise<string> {
  const result = await sys.run(file, args);
  if (result.code !== 0) throw new AttemptFsError(code, `${path.basename(file)} exited ${result.code}: ${result.stderr.trim().slice(0, 300)}`);
  return result.stdout.trim();
}

/** The image still holds its whole reservation (st_blocks counts 512-byte units). */
async function checkReserved(sys: AttemptFsSystem, record: AttemptFsRecord, step: string): Promise<void> {
  const stat = await sys.stat(record.image);
  if (!stat) throw new AttemptFsError('attempt_fs_missing', `the image is gone (${step})`);
  if (record.imageDev !== undefined && (stat.dev !== record.imageDev || stat.ino !== record.imageIno)) {
    throw new AttemptFsError('attempt_fs_mismatch', `the image is not the journaled file (${step})`);
  }
  if (stat.blocks * 512 < ATTEMPT_FS_BYTES) {
    throw new AttemptFsError('attempt_fs_not_reserved', `the image holds ${stat.blocks * 512} of ${ATTEMPT_FS_BYTES} bytes (${step})`);
  }
}

/** The loop devices attached to the image, from `losetup -j`. */
async function loopsOf(sys: AttemptFsSystem, image: string): Promise<string[]> {
  const listed = await must(sys, 'attempt_fs_loop', tools.losetup, ['--list', '--noheadings', '--output', 'NAME', '--associated', image]);
  return listed.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** What is mounted at the mount point, or null when nothing is. */
async function mountedSource(sys: AttemptFsSystem, mountPoint: string): Promise<string | null> {
  const found = await sys.run(tools.findmnt, ['--noheadings', '--output', 'SOURCE', '--mountpoint', mountPoint]);
  // findmnt exits 1 when nothing is mounted there.
  if (found.code === 1 && !found.stdout.trim()) return null;
  if (found.code !== 0) throw new AttemptFsError('attempt_fs_mount', `findmnt exited ${found.code}`);
  return found.stdout.trim();
}

async function disableDiscard(sys: AttemptFsSystem, loop: string): Promise<void> {
  const knob = `/sys/block/${path.basename(loop)}/queue/discard_max_bytes`;
  await sys.writeFile(knob, '0');
  const readBack = (await sys.readFile(knob)).trim();
  if (readBack !== '0') throw new AttemptFsError('discard_not_disabled', `${knob} reads ${readBack}`);
}

/**
 * Attaches the journaled image to a loop device with discard off and mounts it,
 * or verifies a mount that survived (a supervisor restart without a reboot).
 * Shared by the start and by recovery.
 */
export async function mountAttemptFs(sys: AttemptFsSystem, record: AttemptFsRecord,
  persist: (record: AttemptFsRecord) => Promise<void>): Promise<AttemptFsRecord> {
  await checkReserved(sys, record, 'before attach');
  let current = record;
  const source = await mountedSource(sys, current.mountPoint);
  const loops = await loopsOf(sys, current.image);
  if (source !== null) {
    // Something is mounted there: it must be this image's own journaled loop device.
    if (!current.loop || source !== current.loop || !loops.includes(current.loop)) {
      throw new AttemptFsError('attempt_fs_mismatch', `${current.mountPoint} holds ${source}, not the journaled device`);
    }
    await disableDiscard(sys, current.loop);
  } else {
    if (loops.length > 1) throw new AttemptFsError('attempt_fs_mismatch', `the image is attached ${loops.length} times`);
    // A device left from before a crash is reused only if it is the journaled one; otherwise attach afresh.
    let loop = loops[0];
    if (loop && loop !== current.loop) throw new AttemptFsError('attempt_fs_mismatch', `the image is attached to ${loop}, not the journaled device`);
    if (!loop) {
      loop = await must(sys, 'attempt_fs_loop', tools.losetup, ['--find', '--show', '--nooverlap', current.image]);
      current = {...current, loop};
      await persist(current);
    }
    await disableDiscard(sys, loop);
    await sys.mkdir(current.mountPoint, 0o700);
    await must(sys, 'attempt_fs_mount', tools.mount, ['-t', 'ext4', '-o', 'nodev,nosuid,nodiscard', loop, current.mountPoint]);
  }
  const device = current.loop;
  if (!device) throw new AttemptFsError('attempt_fs_loop', 'no loop device was journaled');
  const uuid = await must(sys, 'attempt_fs_mount', tools.blkid, ['--match-tag', 'UUID', '--output', 'value', device]);
  if (current.uuid && uuid !== current.uuid) throw new AttemptFsError('attempt_fs_mismatch', 'the filesystem UUID changed');
  if (await mountedSource(sys, current.mountPoint) !== device) throw new AttemptFsError('attempt_fs_mount', 'the mount did not take');
  await checkReserved(sys, current, 'after mount');
  const inodes = (await sys.statfs(current.mountPoint)).files;
  current = {...current, uuid, inodes, state: 'mounted'};
  await persist(current);
  return current;
}

/**
 * Reserves, formats and mounts a new attempt filesystem under `root`, journaling
 * each identity before it is relied on. Refuses the start when the host cannot
 * spare the reservation.
 */
export async function createAttemptFs(sys: AttemptFsSystem, root: string, runId: string,
  persist: (record: AttemptFsRecord) => Promise<void>): Promise<AttemptFsRecord> {
  await sys.mkdir(root, 0o700);
  const free = await sys.statfs(root);
  if (free.bavail * free.bsize < ATTEMPT_FS_BYTES + HOST_FREE_FLOOR_BYTES) {
    throw new AttemptFsError('insufficient_disk', `${free.bavail * free.bsize} bytes free; an attempt needs ${ATTEMPT_FS_BYTES + HOST_FREE_FLOOR_BYTES}`);
  }
  let record: AttemptFsRecord = {image: path.join(root, `${runId}.img`), mountPoint: path.join(root, runId), state: 'reserving'};
  await persist(record);
  await must(sys, 'insufficient_disk', tools.fallocate, ['--length', String(ATTEMPT_FS_BYTES), record.image]);
  const stat = await sys.stat(record.image);
  if (!stat) throw new AttemptFsError('attempt_fs_missing', 'the image was not created');
  record = {...record, imageDev: stat.dev, imageIno: stat.ino};
  await persist(record);
  await checkReserved(sys, record, 'after fallocate');
  await must(sys, 'attempt_fs_format', tools.mkfs,
    ['-q', '-F', '-m', '0', '-N', String(ATTEMPT_FS_INODES), '-E', 'nodiscard,root_owner=0:0', record.image]);
  await checkReserved(sys, record, 'after mkfs');
  record = {...record, state: 'formatted'};
  await persist(record);
  record = await mountAttemptFs(sys, record, persist);
  for (const dir of ATTEMPT_FS_DIRS) {
    const target = path.join(record.mountPoint, dir);
    await sys.mkdir(target, 0o700);
    await sys.chown(target, SANDBOX_UID, SANDBOX_UID);
  }
  return record;
}

/**
 * Unmounts and detaches, then deletes the image. Every step is checked: the
 * image is unlinked only when nothing is mounted at the mount point and no
 * loop device is left on it. Returns what is still held; nothing is ever
 * unlinked while anything is.
 */
export async function releaseAttemptFs(sys: AttemptFsSystem, record: AttemptFsRecord): Promise<string[]> {
  const held: string[] = [];
  const source = await mountedSource(sys, record.mountPoint).catch(() => 'unknown');
  if (source !== null) {
    const unmounted = await sys.run(tools.umount, [record.mountPoint]);
    if (unmounted.code !== 0 || await mountedSource(sys, record.mountPoint).catch(() => 'unknown') !== null) held.push(`mount:${record.mountPoint}`);
  }
  if (held.length) return held;
  const loops = await loopsOf(sys, record.image).catch(() => null);
  if (loops === null) return [`loop:${record.image}`];
  for (const loop of loops) await sys.run(tools.losetup, ['--detach', loop]);
  const left = await loopsOf(sys, record.image).catch(() => null);
  if (left === null || left.length > 0) return [`loop:${record.image}`];
  await sys.unlink(record.image).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') held.push(`image:${record.image}`); });
  await sys.rmdir(record.mountPoint).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') held.push(`dir:${record.mountPoint}`); });
  return held;
}

/** A bind-backed named volume inside the attempt filesystem; created only after the mount is verified. */
export function attemptVolumeCreateArgs(record: AttemptFsRecord, runId: string, dir: typeof ATTEMPT_FS_DIRS[number],
  labels: Record<string, string>): string[] {
  if (record.state !== 'mounted') throw new AttemptFsError('attempt_fs_mount', 'volumes are created only on a verified mount');
  return ['volume', 'create', '--driver', 'local', '--opt', 'type=none', '--opt', 'o=bind',
    '--opt', `device=${path.join(record.mountPoint, dir)}`,
    ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]), attemptVolumeName(runId, dir)];
}

export const attemptVolumeName = (runId: string, dir: typeof ATTEMPT_FS_DIRS[number]) => `sift-a-${runId}-${dir}`;

/** The real host: system tools by absolute path, and the file system as root. */
export const hostAttemptFsSystem: AttemptFsSystem = {
  run: execSystemTool,
  async stat(file) {
    const found = await fs.lstat(file, {bigint: true}).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!found) return null;
    if (!found.isFile()) throw new AttemptFsError('attempt_fs_mismatch', `${file} is not a regular file`);
    return {dev: Number(found.dev), ino: Number(found.ino), blocks: Number(found.blocks)};
  },
  async statfs(dir) {
    const stats = await fs.statfs(dir);
    return {bavail: stats.bavail, bsize: stats.bsize, files: stats.files};
  },
  readFile: (file) => fs.readFile(file, 'utf8'),
  writeFile: (file, data) => fs.writeFile(file, data),
  /** Creates the directory, or accepts an existing real directory (a mount point left by a reboot); never a symlink. */
  async mkdir(dir, mode) {
    await fs.mkdir(dir, {mode}).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST' || !(await fs.lstat(dir)).isDirectory()) throw error;
    });
  },
  chown: (file, uid, gid) => fs.chown(file, uid, gid),
  unlink: (file) => fs.unlink(file),
  rmdir: (dir) => fs.rmdir(dir),
};

import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  ATTEMPT_FS_BYTES, type AttemptFsRecord, type AttemptFsSystem, attemptVolumeCreateArgs, attemptVolumeProblem, createAttemptFs, mountAttemptFs,
  releaseAttemptFs, SANDBOX_UID, ensureAttemptRoot,
} from './attemptFilesystem.js';

const ROOT = '/var/lib/siftable/attempts';
const FULL = ATTEMPT_FS_BYTES / 512;

/**
 * A host that behaves like the probe on Ubuntu 24.04 (#17267): mkfs without
 * nodiscard punches the image down to a few MiB, and so does a trim while the
 * loop device still accepts discard.
 */
function host(options: {freeBytes?: number; stuckDiscard?: boolean; umountFails?: boolean; detachFails?: boolean} = {}) {
  const files = new Map<string, {dev: number; ino: number; blocks: number}>();
  /** Each loop device backs the inode the path named when it was attached. */
  const loops = new Map<string, {image: string; ino: number}>();
  const discard = new Map<string, string>();
  const mounts = new Map<string, string>();
  const calls: string[] = [];
  const owners = new Map<string, number>();
  let nextIno = 100;
  let nextLoop = 0;
  const uuidOf = new Map<number, string>();
  const sys: AttemptFsSystem = {
    async createExclusive(file) {
      if (files.has(file)) throw Object.assign(new Error('file exists'), {code: 'EEXIST'});
      const entry = {dev: 7, ino: nextIno++, blocks: 0};
      files.set(file, entry);
      return {dev: entry.dev, ino: entry.ino};
    },
    async run(file, args) {
      const tool = file.split('/').at(-1)!;
      calls.push(`${tool} ${args.join(' ')}`);
      const ok = (stdout = '') => ({code: 0, stdout, stderr: ''});
      switch (tool) {
        case 'fallocate': files.get(args.at(-1)!)!.blocks = FULL; return ok();
        case 'mkfs.ext4': {
          const image = args.at(-1)!;
          uuidOf.set(files.get(image)!.ino, `uuid-${files.get(image)!.ino}`);
          if (!args.join(' ').includes('nodiscard')) files.get(image)!.blocks = 65 * 2048;
          return ok();
        }
        case 'losetup': {
          if (args[0] === '--find') {
            const loop = `/dev/loop${nextLoop++}`;
            loops.set(loop, {image: args.at(-1)!, ino: files.get(args.at(-1)!)!.ino});
            discard.set(loop, '4294966784');
            return ok(`${loop}\n`);
          }
          if (args[0] === '--detach') { if (!options.detachFails) loops.delete(args[1]); return ok(); }
          const image = args.at(-1)!;
          return ok([...loops].filter(([, target]) => target.image === image).map(([loop, target]) => `${loop} ${target.ino}`).join('\n'));
        }
        case 'mount': mounts.set(args.at(-1)!, args.at(-2)!); return ok();
        case 'umount': if (options.umountFails) return {code: 32, stdout: '', stderr: 'target is busy'}; mounts.delete(args[0]); return ok();
        case 'findmnt': { const source = mounts.get(args.at(-1)!); return source ? ok(`${source}\n`) : {code: 1, stdout: '', stderr: ''}; }
        case 'blkid': {
          const target = args.at(-1)!;
          const ino = loops.get(target)?.ino ?? files.get(target)?.ino;
          return ok(ino === undefined ? '' : uuidOf.get(ino) ?? '');
        }
        default: return {code: 127, stdout: '', stderr: 'unknown tool'};
      }
    },
    async stat(file) { const entry = files.get(file); return entry ? {...entry} : null; },
    async statfs(dir) { return dir === ROOT ? {bavail: (options.freeBytes ?? 40 * 1024 ** 3) / 4096, bsize: 4096, files: 0} : {bavail: 0, bsize: 4096, files: 399_872}; },
    async readFile(file) { return discard.get(file.split('/')[3] ? `/dev/${file.split('/')[3]}` : '') ?? ''; },
    async writeFile(file, data) { if (!options.stuckDiscard) discard.set(`/dev/${file.split('/')[3]}`, data); },
    async mkdir() {},
    async chown(file, uid) { owners.set(file, uid); },
    async unlink(file) { calls.push(`unlink ${file}`); files.delete(file); },
    async rmdir(dir) { calls.push(`rmdir ${dir}`); },
  };
  /** fstrim: frees an image's unused blocks unless its loop device refuses discard. */
  const trim = (image: string) => {
    const loop = [...loops].find(([, target]) => target.image === image)?.[0];
    if (!loop || discard.get(loop) !== '0') files.get(image)!.blocks = 72 * 2048;
  };
  const reboot = () => { loops.clear(); mounts.clear(); discard.clear(); };
  return {sys, calls, files, loops, mounts, owners, uuidOf, trim, reboot};
}

const journal = () => {
  const written: AttemptFsRecord[] = [];
  return {written, persist: async (record: AttemptFsRecord) => { written.push(record); }};
};

describe('attempt filesystem', () => {
  it('reserves, formats without discard, mounts on its own loop device and journals each identity first', async () => {
    const h = host();
    const j = journal();
    const record = await createAttemptFs(h.sys, ROOT, 'r1', async (r) => {
      h.calls.push(`persist ino=${r.imageIno ?? '-'} uuid=${r.uuid ?? '-'}`);
      await j.persist(r);
    });
    expect(record).toMatchObject({image: `${ROOT}/r1.img`, mountPoint: `${ROOT}/r1`, loop: '/dev/loop0', state: 'mounted', inodes: 399_872});
    expect(j.written.map((r) => r.state)).toEqual(['reserving', 'reserving', 'formatted', 'formatted', 'mounted']);
    // The identity is journaled before any space is allocated, and the UUID before the first mount.
    expect(j.written[1]).toMatchObject({imageDev: 7, imageIno: 100});
    const at = (prefix: string) => h.calls.findIndex((c) => c.startsWith(prefix));
    expect(at('persist ino=100')).toBeLessThan(at('fallocate'));
    expect(at('persist ino=100 uuid=uuid-100')).toBeLessThan(at('losetup --find'));
    expect(at('losetup --find')).toBeLessThan(at('mount'));
    expect(j.written[2]).toMatchObject({uuid: 'uuid-100', state: 'formatted'});
    expect(j.written[2].loop).toBeUndefined();
    expect(j.written[3].loop).toBe('/dev/loop0');
    expect(h.calls.find((c) => c.startsWith('mkfs.ext4'))).toContain('-E nodiscard');
    expect(h.calls.find((c) => c.startsWith('mount'))).toContain('-o nodev,nosuid,nodiscard /dev/loop0');
    expect([...h.owners.values()]).toEqual([SANDBOX_UID, SANDBOX_UID, SANDBOX_UID, SANDBOX_UID]);
    // The reservation outlives a trim once the device refuses discard.
    h.trim(record.image);
    expect(h.files.get(record.image)!.blocks).toBe(FULL);
  });

  it('refuses the start when the host cannot spare the image and its floor, before anything is written', async () => {
    const h = host({freeBytes: 11 * 1024 ** 3});
    const j = journal();
    await expect(createAttemptFs(h.sys, ROOT, 'r1', j.persist)).rejects.toThrow(/insufficient_disk/);
    expect(h.calls).toEqual([]);
    expect(j.written).toEqual([]);
  });

  it('refuses to mount a device whose discard cannot be turned off', async () => {
    const h = host({stuckDiscard: true});
    await expect(createAttemptFs(h.sys, ROOT, 'r1', journal().persist)).rejects.toThrow(/discard_not_disabled/);
    expect(h.mounts.size).toBe(0);
  });

  it('after a reboot, reattaches the same image with discard off and the same UUID, before any trim can run', async () => {
    const h = host();
    const record = await createAttemptFs(h.sys, ROOT, 'r1', journal().persist);
    h.reboot();
    const j = journal();
    const again = await mountAttemptFs(h.sys, record, j.persist);
    expect(again).toMatchObject({loop: '/dev/loop1', uuid: record.uuid, state: 'mounted'});
    h.trim(record.image);
    expect(h.files.get(record.image)!.blocks).toBe(FULL);
  });

  it('verifies a mount that survived a supervisor restart instead of mounting again', async () => {
    const h = host();
    const record = await createAttemptFs(h.sys, ROOT, 'r1', journal().persist);
    const mountsBefore = h.calls.filter((c) => c.startsWith('mount')).length;
    await mountAttemptFs(h.sys, record, journal().persist);
    expect(h.calls.filter((c) => c.startsWith('mount')).length).toBe(mountsBefore);
  });

  it('refuses an image that was replaced, a foreign mount, or a reservation already lost', async () => {
    const h = host();
    const record = await createAttemptFs(h.sys, ROOT, 'r1', journal().persist);
    h.reboot();
    h.files.set(record.image, {...h.files.get(record.image)!, ino: 999});
    await expect(mountAttemptFs(h.sys, record, journal().persist)).rejects.toThrow(/attempt_fs_mismatch/);
    h.files.set(record.image, {...h.files.get(record.image)!, ino: record.imageIno!});
    h.mounts.set(record.mountPoint, '/dev/sdb1');
    await expect(mountAttemptFs(h.sys, record, journal().persist)).rejects.toThrow(/attempt_fs_mismatch/);
    h.mounts.clear();
    h.files.get(record.image)!.blocks = 1000;
    await expect(mountAttemptFs(h.sys, record, journal().persist)).rejects.toThrow(/attempt_fs_not_reserved/);
  });

  it('deletes the image only after the mount and every loop device are gone', async () => {
    const happy = host();
    const record = await createAttemptFs(happy.sys, ROOT, 'r1', journal().persist);
    expect(await releaseAttemptFs(happy.sys, record)).toEqual([]);
    expect(happy.files.has(record.image)).toBe(false);

    for (const failure of [{umountFails: true}, {detachFails: true}]) {
      const h = host(failure);
      const r = await createAttemptFs(h.sys, ROOT, 'r1', journal().persist);
      expect((await releaseAttemptFs(h.sys, r)).length).toBe(1);
      expect(h.files.has(r.image)).toBe(true);
      expect(h.calls.some((c) => c.startsWith('unlink'))).toBe(false);
    }
  });

  it('makes one device-backed volume, only on a verified mount, and recognizes nothing else as it', async () => {
    const h = host();
    const record = await createAttemptFs(h.sys, ROOT, 'r1', journal().persist);
    const labels = {'sift.machine.run': 'r1'};
    expect(attemptVolumeCreateArgs(record, 'r1', labels)).toEqual(['volume', 'create', '--driver', 'local', '--opt', 'type=ext4',
      '--opt', 'device=/dev/loop0', '--opt', 'o=nodev,nosuid,nodiscard', '--label', 'sift.machine.run=r1', 'sift-a-r1-fs']);
    expect(() => attemptVolumeCreateArgs({...record, state: 'formatted'}, 'r1', labels)).toThrow(/verified mount/);
    const shown = {Name: 'sift-a-r1-fs', Driver: 'local', Labels: {'sift.machine.run': 'r1'},
      Options: {type: 'ext4', device: '/dev/loop0', o: 'nodev,nosuid,nodiscard'}};
    expect(attemptVolumeProblem(shown, record, 'r1', labels)).toBeUndefined();
    expect(attemptVolumeProblem({...shown, Name: 'sift-a-r2-fs'}, record, 'r1', labels)).toBe('volume_name');
    expect(attemptVolumeProblem({...shown, Driver: 'nfs'}, record, 'r1', labels)).toBe('volume_driver');
    expect(attemptVolumeProblem({...shown, Labels: {}}, record, 'r1', labels)).toBe('volume_labels');
    // A loop number that changed with a reboot, a bind of some host path, extra or missing options: never this volume.
    for (const Options of [{...shown.Options, device: '/dev/loop7'}, {type: 'none', o: 'bind', device: '/var/lib/x'},
      {...shown.Options, o: 'nodev,nosuid'}, {...shown.Options, size: '1g'}, {type: 'ext4', device: '/dev/loop0'}]) {
      expect(attemptVolumeProblem({...shown, Options}, record, 'r1', labels), JSON.stringify(Options)).toBe('volume_options');
    }
  });

  it('never adopts an existing path at the image, so nothing is allocated or formatted over it', async () => {
    const h = host();
    h.files.set(`${ROOT}/r1.img`, {dev: 7, ino: 5, blocks: 8});
    await expect(createAttemptFs(h.sys, ROOT, 'r1', journal().persist)).rejects.toThrow(/attempt_fs_exists/);
    expect(h.calls.some((c) => c.startsWith('fallocate') || c.startsWith('mkfs'))).toBe(false);
  });

  it('refuses to mount a device whose filesystem is not the pinned UUID', async () => {
    const h = host();
    const record = await createAttemptFs(h.sys, ROOT, 'r1', journal().persist);
    h.reboot();
    h.uuidOf.set(record.imageIno!, 'uuid-other');
    const mountsBefore = h.calls.filter((c) => c.startsWith('mount')).length;
    await expect(mountAttemptFs(h.sys, record, journal().persist)).rejects.toThrow(/pinned/);
    expect(h.calls.filter((c) => c.startsWith('mount')).length).toBe(mountsBefore);
  });

  it('holds instead of unmounting, detaching or deleting anything that is not provably ours', async () => {
    // A replaced image: nothing is touched.
    const replaced = host();
    const r1 = await createAttemptFs(replaced.sys, ROOT, 'r1', journal().persist);
    replaced.files.set(r1.image, {...replaced.files.get(r1.image)!, ino: 999});
    expect(await releaseAttemptFs(replaced.sys, r1)).toEqual([`image_unverified:${r1.image}`]);
    expect(replaced.calls.some((c) => c.startsWith('umount') || c.startsWith('losetup --detach') || c.startsWith('unlink'))).toBe(false);

    // Something else mounted at the mount point: never unmounted.
    const foreign = host();
    const r2 = await createAttemptFs(foreign.sys, ROOT, 'r1', journal().persist);
    foreign.mounts.set(r2.mountPoint, '/dev/sdb1');
    expect(await releaseAttemptFs(foreign.sys, r2)).toEqual([`mount_foreign:${r2.mountPoint}`]);
    expect(foreign.calls.some((c) => c.startsWith('umount') || c.startsWith('unlink'))).toBe(false);

    // The journaled device name and UUID now belong to a copy of the image at another path: never unmounted.
    const copied = host();
    const r3 = await createAttemptFs(copied.sys, ROOT, 'r1', journal().persist);
    copied.loops.set(r3.loop!, {image: `${ROOT}/copy.img`, ino: 4242});
    copied.uuidOf.set(4242, r3.uuid!);
    expect(await releaseAttemptFs(copied.sys, r3)).toEqual([`mount_foreign:${r3.mountPoint}`]);
    expect(copied.calls.some((c) => c.startsWith('umount') || c.startsWith('unlink'))).toBe(false);

    // A path never verified (a crash before its identity was journaled): held for the operator.
    const unverified = host();
    unverified.files.set(`${ROOT}/r9.img`, {dev: 7, ino: 3, blocks: 8});
    expect(await releaseAttemptFs(unverified.sys, {image: `${ROOT}/r9.img`, mountPoint: `${ROOT}/r9`, state: 'reserving'}))
      .toEqual([`image_unverified:${ROOT}/r9.img`]);
  });

  describe('attempt root', () => {
    const me = process.getuid?.() ?? 0;
    let base: string;
    beforeEach(async () => { base = await fs.mkdtemp(path.join(tmpdir(), 'sift-root-')); });
    afterEach(async () => { await fs.rm(base, {recursive: true, force: true}); });

    it('creates the parent and the root on a fresh machine, private to their owner', async () => {
      const root = path.join(base, 'siftable', 'attempts');
      await ensureAttemptRoot(root, me);
      for (const dir of [path.dirname(root), root]) {
        const stat = await fs.lstat(dir);
        expect(stat.isDirectory()).toBe(true);
        expect(stat.mode & 0o777).toBe(0o700);
      }
      // A second start accepts what the first made.
      await expect(ensureAttemptRoot(root, me)).resolves.toBeUndefined();
    });

    it('refuses a symlinked, shared or foreign attempt root before any attempt', async () => {
      const elsewhere = path.join(base, 'elsewhere');
      await fs.mkdir(elsewhere);
      await fs.symlink(elsewhere, path.join(base, 'linked'));
      await expect(ensureAttemptRoot(path.join(base, 'linked', 'attempts'), me)).rejects.toThrow(/not a real directory/);
      const shared = path.join(base, 'shared');
      await fs.mkdir(shared, {mode: 0o777});
      await fs.chmod(shared, 0o777);
      await expect(ensureAttemptRoot(path.join(shared, 'attempts'), me)).rejects.toThrow(/writable by group or others/);
      await expect(ensureAttemptRoot(path.join(base, 'owned', 'attempts'), me + 1)).rejects.toThrow(/owned by uid/);
    });
  });
});

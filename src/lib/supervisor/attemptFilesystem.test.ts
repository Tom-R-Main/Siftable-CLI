import {describe, expect, it} from 'vitest';
import {
  ATTEMPT_FS_BYTES, type AttemptFsRecord, type AttemptFsSystem, attemptVolumeCreateArgs, createAttemptFs, mountAttemptFs,
  releaseAttemptFs, SANDBOX_UID,
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
  const loops = new Map<string, string>();
  const discard = new Map<string, string>();
  const mounts = new Map<string, string>();
  const calls: string[] = [];
  const owners = new Map<string, number>();
  let nextIno = 100;
  let nextLoop = 0;
  const uuidOf = new Map<string, string>();
  const sys: AttemptFsSystem = {
    async run(file, args) {
      const tool = file.split('/').at(-1)!;
      calls.push(`${tool} ${args.join(' ')}`);
      const ok = (stdout = '') => ({code: 0, stdout, stderr: ''});
      switch (tool) {
        case 'fallocate': files.set(args.at(-1)!, {dev: 7, ino: nextIno++, blocks: FULL}); return ok();
        case 'mkfs.ext4': {
          const image = args.at(-1)!;
          uuidOf.set(image, `uuid-${image.length}`);
          if (!args.join(' ').includes('nodiscard')) files.get(image)!.blocks = 65 * 2048;
          return ok();
        }
        case 'losetup': {
          if (args[0] === '--find') {
            const loop = `/dev/loop${nextLoop++}`;
            loops.set(loop, args.at(-1)!);
            discard.set(loop, '4294966784');
            return ok(`${loop}\n`);
          }
          if (args[0] === '--detach') { if (!options.detachFails) loops.delete(args[1]); return ok(); }
          const image = args.at(-1)!;
          return ok([...loops].filter(([, target]) => target === image).map(([loop]) => loop).join('\n'));
        }
        case 'mount': mounts.set(args.at(-1)!, args.at(-2)!); return ok();
        case 'umount': if (options.umountFails) return {code: 32, stdout: '', stderr: 'target is busy'}; mounts.delete(args[0]); return ok();
        case 'findmnt': { const source = mounts.get(args.at(-1)!); return source ? ok(`${source}\n`) : {code: 1, stdout: '', stderr: ''}; }
        case 'blkid': return ok(uuidOf.get(loops.get(args.at(-1)!)!) ?? '');
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
    const loop = [...loops].find(([, target]) => target === image)?.[0];
    if (!loop || discard.get(loop) !== '0') files.get(image)!.blocks = 72 * 2048;
  };
  const reboot = () => { loops.clear(); mounts.clear(); discard.clear(); };
  return {sys, calls, files, loops, mounts, owners, trim, reboot};
}

const journal = () => {
  const written: AttemptFsRecord[] = [];
  return {written, persist: async (record: AttemptFsRecord) => { written.push(record); }};
};

describe('attempt filesystem', () => {
  it('reserves, formats without discard, mounts on its own loop device and journals each identity first', async () => {
    const h = host();
    const j = journal();
    const record = await createAttemptFs(h.sys, ROOT, 'r1', j.persist);
    expect(record).toMatchObject({image: `${ROOT}/r1.img`, mountPoint: `${ROOT}/r1`, loop: '/dev/loop0', state: 'mounted', inodes: 399_872});
    expect(j.written.map((r) => r.state)).toEqual(['reserving', 'reserving', 'formatted', 'formatted', 'mounted']);
    expect(j.written[1]).toMatchObject({imageDev: 7, imageIno: 100});
    expect(j.written[3].loop).toBe('/dev/loop0');
    expect(h.calls.find((c) => c.startsWith('mkfs.ext4'))).toContain('-E nodiscard');
    expect(h.calls.find((c) => c.startsWith('mount'))).toContain('-o nodev,nosuid,nodiscard /dev/loop0');
    expect([...h.owners.values()]).toEqual([SANDBOX_UID, SANDBOX_UID, SANDBOX_UID]);
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

  it('creates bind-backed volumes only on a verified mount', async () => {
    const h = host();
    const record = await createAttemptFs(h.sys, ROOT, 'r1', journal().persist);
    expect(attemptVolumeCreateArgs(record, 'r1', 'work', {'sift.machine.run': 'r1'})).toEqual(['volume', 'create', '--driver', 'local',
      '--opt', 'type=none', '--opt', 'o=bind', '--opt', `device=${ROOT}/r1/work`, '--label', 'sift.machine.run=r1', 'sift-a-r1-work']);
    expect(() => attemptVolumeCreateArgs({...record, state: 'formatted'}, 'r1', 'work', {})).toThrow(/verified mount/);
  });
});

import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ATTEMPT_FS_BYTES, type AttemptFsRecord, type AttemptFsSystem} from './attemptFilesystem.js';
import {
  freezePatch, type HelperRole, prepareWorkspace, releaseWorkspace, type WorkspaceContext, WorkspaceRefused, writerVolumes,
} from './attemptWorkspace.js';
import {PATCH_FILE} from './checkoutHelper.js';
import type {Attach} from './machineQualify.js';

const IMAGE = `registry.example/sift-agent@sha256:${'a'.repeat(64)}`;
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const checkout = {repositoryUrl: 'https://github.com/acme/widgets', baseSha: 'c'.repeat(40), writeScope: ['src', 'test/unit']};

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(tmpdir(), 'sift-workspace-')); });
afterEach(async () => { await fs.rm(root, {recursive: true, force: true}); });

/** An attempt filesystem host where every step succeeds; the mount point is a real directory. */
function fsHost(): AttemptFsSystem & {calls: string[]} {
  let attached = false;
  let mounted = false;
  const calls: string[] = [];
  const ok = (stdout = '') => ({code: 0, stdout, stderr: ''});
  return {
    calls,
    createExclusive: async () => ({dev: 1, ino: 2}),
    async run(file, args) {
      const tool = file.split('/').at(-1)!;
      calls.push(`${tool} ${args[0]}`);
      if (tool === 'losetup' && args[0] === '--find') { attached = true; return ok('/dev/loop0\n'); }
      if (tool === 'losetup' && args[0] === '--list') return ok(attached ? '/dev/loop0 2\n' : '');
      if (tool === 'losetup' && args[0] === '--detach') { attached = false; return ok(); }
      if (tool === 'mount') { mounted = true; return ok(); }
      if (tool === 'umount') { mounted = false; return ok(); }
      if (tool === 'findmnt') return mounted ? ok('/dev/loop0\n') : {code: 1, stdout: '', stderr: ''};
      if (tool === 'blkid') return ok('uuid-1\n');
      return ok();
    },
    stat: async () => ({dev: 1, ino: 2, blocks: ATTEMPT_FS_BYTES / 512}),
    statfs: async () => ({bavail: 1e9, bsize: 4096, files: 400_000}),
    readFile: async () => '0',
    writeFile: async () => undefined,
    mkdir: async (dir) => { await fs.mkdir(dir, {recursive: true}); },
    chown: async () => undefined,
    unlink: async (file) => { calls.push(`unlink ${path.basename(file)}`); },
    rmdir: async () => undefined,
  };
}

const flag = (args: string[], name: string) => args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : []));

/** What Docker 29 reports for a container made from these create arguments, volumes and subpaths included. */
function inspectFrom(id: string, created: string[], tamper?: (inspect: Record<string, unknown>) => void) {
  const memory = Number(flag(created, '--memory')[0].replace('m', ''));
  const mounts = flag(created, '--mount').map((m) => {
    const parts = Object.fromEntries(m.split(',').map((p) => (p.includes('=') ? p.split('=') : [p, 'true']) as [string, string]));
    return parts;
  });
  const inspect = {
    Id: id, Image: IMAGE_ID,
    Config: {Image: IMAGE, User: flag(created, '--user')[0], Entrypoint: flag(created, '--entrypoint'),
      Labels: Object.fromEntries(flag(created, '--label').map((l) => l.split('=') as [string, string]))},
    HostConfig: {Privileged: false, CapAdd: null, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], ReadonlyRootfs: true,
      PidMode: '', IpcMode: 'private', UTSMode: '', UsernsMode: '', CgroupnsMode: 'private', CgroupParent: flag(created, '--cgroup-parent')[0],
      NetworkMode: flag(created, '--network')[0], Devices: [], VolumesFrom: null, PortBindings: {}, PublishAllPorts: false,
      Tmpfs: Object.fromEntries(flag(created, '--tmpfs').map((t) => [t.split(':')[0], t.slice(t.indexOf(':') + 1)])),
      RestartPolicy: {Name: 'no'}, Memory: memory * 1024 * 1024, MemorySwap: memory * 1024 * 1024,
      NanoCpus: Number(flag(created, '--cpus')[0]) * 1e9, PidsLimit: Number(flag(created, '--pids-limit')[0]),
      Mounts: mounts.filter((m) => m.type === 'volume').map((m) => ({Type: 'volume', Source: m.source, Target: m.target,
        ...(m.readonly ? {ReadOnly: true} : {}), ...(m['volume-subpath'] ? {VolumeOptions: {Subpath: m['volume-subpath']}} : {})}))},
    Mounts: mounts.map((m) => (m.type === 'volume'
      ? {Type: 'volume', Name: m.source, Destination: m.target, RW: !m.readonly}
      : {Type: 'bind', Source: m.source, Destination: m.target, RW: false})),
    NetworkSettings: {Networks: {}},
  };
  tamper?.(inspect);
  return inspect;
}

interface Scenario {
  result?: Record<string, unknown> | 'hang';
  exit?: number;
  tamper?: (inspect: Record<string, unknown>) => void;
  /** Writes the patch helper's output into the attempt filesystem, as the helper would. */
  patch?: (outDir: string) => Promise<void>;
  volumeRm?: number;
}

function context(scenario: Scenario = {}) {
  const events: string[] = [];
  const created = new Map<string, string[]>();
  const docker: WorkspaceContext['docker'] = async (args) => {
    const ok = (stdout = '') => ({code: 0, stdout, stderr: ''});
    const [a, b] = args;
    events.push(`${a} ${b}${a === 'volume' && b === 'create' ? ` ${args.at(-1)}` : ''}`);
    if (a === 'container' && b === 'inspect') return ok(JSON.stringify([inspectFrom(args[2], created.get(args[2])!, scenario.tamper)]));
    if (a === 'volume' && b === 'ls') return ok('sift-a-r1-src\nsift-a-r1-work\n');
    if (a === 'volume' && b === 'rm' && scenario.volumeRm) return {code: scenario.volumeRm, stdout: '', stderr: 'volume is in use'};
    return ok();
  };
  const create = async (role: HelperRole, args: string[]) => {
    events.push(`create:${role}`);
    const id = role === 'fetch' ? 'net-fetch' : `c-${role}`;
    created.set(id, args);
    return id;
  };
  const attach: Attach = (args) => {
    const id = args.at(-1)!;
    events.push(`start:${id}`);
    const stdout = new PassThrough();
    const exited = new Promise<number>((resolve) => {
      if (scenario.result === 'hang') return;
      void (async () => {
        if (id === 'c-patch') await scenario.patch?.(path.join(root, 'r1', 'src'));
        stdout.end(`${JSON.stringify(scenario.result ?? {ok: true})}\n`);
        resolve(scenario.exit ?? 0);
      })();
    });
    return {stdin: new PassThrough(), stdout, exited, kill: () => { events.push(`detach:${id}`); }};
  };
  const ctx: WorkspaceContext = {
    runId: 'r1', attemptId: 'a1', imageRef: IMAGE, imageId: IMAGE_ID, slice: 'siftable-a1.slice', checkout,
    helperAsset: '/usr/lib/sift/checkoutHelper.js', docker, attach, create, fsSystem: fsHost(), attemptRoot: root,
    persistFs: async () => undefined, timeouts: {checkoutMs: 200, patchMs: 200},
  };
  return {ctx, events, created};
}

const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => (error as WorkspaceRefused).code);

describe('attempt workspace', () => {
  it('mounts the checkout read-only for the writer, each write scope writable over it by literal subpath', () => {
    expect(writerVolumes('r1', ['src', 'test/unit'])).toEqual([
      {volume: 'sift-a-r1-work', target: '/workspace', readonly: true},
      {volume: 'sift-a-r1-work', target: '/workspace/src', readonly: false, subpath: 'src'},
      {volume: 'sift-a-r1-work', target: '/workspace/test/unit', readonly: false, subpath: 'test/unit'},
    ]);
  });

  it('reserves the filesystem, makes its volumes, checks out on a bridge of its own, then removes the helper and the bridge', async () => {
    const {ctx, events, created} = context();
    const record = await prepareWorkspace(ctx);
    expect(record).toMatchObject({state: 'mounted', mountPoint: path.join(root, 'r1')});
    expect(events).toEqual(['volume create sift-a-r1-src', 'volume create sift-a-r1-work', 'create:fetch', 'create:checkout',
      'container inspect', 'start:c-checkout', 'container rm', 'network rm']);
    const args = created.get('c-checkout')!;
    expect(flag(args, '--network')).toEqual(['net-fetch']);
    expect(flag(args, '--mount')).toEqual(['type=bind,source=/usr/lib/sift/checkoutHelper.js,target=/sift/checkoutHelper.js,readonly',
      'type=volume,source=sift-a-r1-src,target=/src', 'type=volume,source=sift-a-r1-work,target=/workspace']);
    expect(flag(args, '--cgroup-parent')).toEqual(['siftable-a1.slice']);
    expect(JSON.parse(flag(args, '--env').find((e) => e.startsWith('SIFT_CHECKOUT='))!.slice('SIFT_CHECKOUT='.length))).toEqual(checkout);
    expect(flag(created.get('net-fetch')!, '--label')).toContain('sift.machine.run=r1');
  });

  it('refuses the start with the helper\'s own reason, and still removes the helper and the bridge', async () => {
    const {ctx, events} = context({result: {ok: false, code: 'scope_invalid', detail: 'linked is a symlink'}, exit: 2});
    expect(await refusal(prepareWorkspace(ctx))).toBe('scope_invalid');
    expect(events.slice(-2)).toEqual(['container rm', 'network rm']);
  });

  it('never starts a helper whose sandbox is not as specified', async () => {
    const {ctx, events} = context({tamper: (inspect) => { (inspect.Mounts as Array<{RW: boolean}>)[1].RW = false; }});
    expect(await refusal(prepareWorkspace(ctx))).toBe('checkout_sandbox');
    expect(events.some((e) => e.startsWith('start:'))).toBe(false);
    expect(events).toContain('container rm');
  });

  it('kills and removes a helper that runs past its time', async () => {
    const {ctx, events} = context({result: 'hang'});
    const pending = refusal(freezePatch(ctx, {image: '', mountPoint: path.join(root, 'r1'), state: 'mounted'} as AttemptFsRecord, root));
    expect(await pending).toBe('patch_timeout');
    expect(events).toEqual(expect.arrayContaining(['container kill', 'detach:c-patch', 'container rm']));
  });

  it('builds the patch with no network and the checkout read-only, then copies it out as data', async () => {
    const {ctx, created} = context({patch: async (out) => {
      await fs.mkdir(out, {recursive: true});
      await fs.writeFile(path.join(out, PATCH_FILE), '# sift patch v1\n');
    }});
    const outDir = path.join(root, 'input');
    await fs.mkdir(outDir);
    const frozen = await freezePatch(ctx, {image: '', mountPoint: path.join(root, 'r1'), state: 'mounted'} as AttemptFsRecord, outDir);
    expect(frozen).toMatchObject({kind: 'patch', contentType: 'text/x-diff', bytes: 16, path: path.join(outDir, PATCH_FILE)});
    expect(frozen.sha256).toMatch(/^[0-9a-f]{64}$/);
    const args = created.get('c-patch')!;
    expect(flag(args, '--network')).toEqual(['none']);
    expect(flag(args, '--mount')).toContain('type=volume,source=sift-a-r1-work,target=/workspace,readonly');
    expect(flag(args, '--env')).toContain('SIFT_MODE=patch');
  });

  it('refuses a patch that is a link instead of a file', async () => {
    const {ctx} = context({patch: async (out) => {
      await fs.mkdir(out, {recursive: true});
      await fs.symlink('/etc/hosts', path.join(out, PATCH_FILE));
    }});
    await expect(freezePatch(ctx, {image: '', mountPoint: path.join(root, 'r1'), state: 'mounted'} as AttemptFsRecord, root))
      .rejects.toThrow(/ELOOP|symbolic/);
  });

  it('removes the volumes before the filesystem, and keeps the filesystem while a volume is held', async () => {
    const {ctx, events} = context();
    const record = await prepareWorkspace(ctx);
    const fsCalls = ctx.fsSystem as AttemptFsSystem & {calls: string[]};
    expect(await releaseWorkspace(ctx.docker, ctx.fsSystem, 'r1', record)).toEqual([]);
    expect(events.filter((e) => e.startsWith('volume rm'))).toHaveLength(2);
    expect(fsCalls.calls).toContain('unlink r1.img');

    const held = context({volumeRm: 1});
    const kept = await prepareWorkspace(held.ctx);
    expect(await releaseWorkspace(held.ctx.docker, held.ctx.fsSystem, 'r1', kept)).toEqual(['volume:sift-a-r1-src', 'volume:sift-a-r1-work']);
    expect((held.ctx.fsSystem as AttemptFsSystem & {calls: string[]}).calls.some((c) => c.startsWith('unlink'))).toBe(false);
  });
});

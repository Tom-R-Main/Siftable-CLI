/**
 * An attempt's checkout and patch (first-run U5b-2c, checkout contract rev 5),
 * between the attempt filesystem and the containers. Before the writer: the
 * filesystem is reserved and mounted, its volumes are created, and the
 * checkout helper fetches and checks out the base on a bridge of its own,
 * which is removed with it. After the writer: the patch helper, with no
 * network and the checkout read-only, writes the write scope's patch into the
 * attempt filesystem, and the root supervisor copies it out as data. Every
 * helper is created through the caller's journaled create, carries the
 * attempt's labels and cgroup slice, is checked before it starts, and is
 * killed and removed when its time is up.
 */
import {createHash} from 'node:crypto';
import {constants, promises as fs} from 'node:fs';
import path from 'node:path';
import type {FrozenArtifact} from './attemptEvidence.js';
import {PATCH_CONTENT_TYPE} from './attemptEvidence.js';
import type {CheckoutPlan} from './attemptCheckout.js';
import {
  AttemptFsError, type AttemptFsRecord, type AttemptFsSystem, attemptVolumeCreateArgs, attemptVolumeName, createAttemptFs, releaseAttemptFs,
} from './attemptFilesystem.js';
import {MAX_PATCH_BYTES, PATCH_FILE} from './checkoutHelper.js';
import {evaluateSandboxInspect, sandboxCreateArgs, type SandboxContainerSpec, type SandboxVolume} from './containerSandbox.js';
import type {Attach} from './machineQualify.js';

export const CHECKOUT_TIMEOUT_MS = 180_000;
export const PATCH_TIMEOUT_MS = 10_000;
const RESULT_LIMIT = 64 * 1024;

export type HelperRole = 'fetch' | 'checkout' | 'patch';

export interface WorkspaceContext {
  runId: string;
  attemptId: string;
  imageRef: string;
  imageId: string;
  /** The attempt's cgroup slice, so Stop kills a helper with everything else. */
  slice: string;
  checkout: CheckoutPlan;
  /** The shipped checkout helper program, bind-mounted read-only. */
  helperAsset: string;
  docker: (args: string[]) => Promise<{code: number; stdout: string; stderr: string}>;
  attach: Attach;
  /** The caller's journaled create: records the request before sending and the ID when it answers. */
  create: (role: HelperRole, args: string[]) => Promise<string>;
  fsSystem: AttemptFsSystem;
  attemptRoot: string;
  persistFs: (record: AttemptFsRecord) => Promise<void>;
  /** Tests shorten these; production uses the contract's bounds. */
  timeouts?: {checkoutMs?: number; patchMs?: number};
}

export class WorkspaceRefused extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
  }
}

const labels = (ctx: Pick<WorkspaceContext, 'runId' | 'attemptId'>, role: string) =>
  ({'sift.machine.run': ctx.runId, 'sift.machine.role': role, 'sift.machine.attempt': ctx.attemptId});

/** The writer's view: the checkout read-only, each write scope writable over it, by literal subpath. */
export function writerVolumes(runId: string, writeScope: string[]): SandboxVolume[] {
  const work = attemptVolumeName(runId, 'work');
  return [{volume: work, target: '/workspace', readonly: true},
    ...writeScope.map((scope) => ({volume: work, target: `/workspace/${scope}`, readonly: false, subpath: scope}))];
}

function helperSpec(ctx: WorkspaceContext, role: 'checkout' | 'patch', networkId: string, volumes: SandboxVolume[],
  env: Record<string, string>): SandboxContainerSpec {
  return {
    name: `sift-a-${ctx.runId}-${role}`, imageRef: ctx.imageRef, networkId, labels: labels(ctx, role),
    entrypoint: 'node', command: ['/sift/checkoutHelper.js'],
    mounts: [{source: ctx.helperAsset, target: '/sift/checkoutHelper.js'}], volumes, tmpfs: ['/tmp'],
    env: {...env, SIFT_CHECKOUT: JSON.stringify(ctx.checkout)},
    limits: {cpus: 2, memoryMb: 2048, pidsLimit: 256}, cgroupParent: ctx.slice,
  };
}

/** Creates, checks, runs and removes one helper; returns its JSON result line. Never leaves it running. */
async function runHelper(ctx: WorkspaceContext, role: 'checkout' | 'patch', spec: SandboxContainerSpec, timeoutMs: number) {
  const id = await ctx.create(role, sandboxCreateArgs(spec));
  try {
    const inspected = await ctx.docker(['container', 'inspect', id]);
    const [entry] = inspected.code === 0 ? JSON.parse(inspected.stdout) as unknown[] : [];
    const problems = evaluateSandboxInspect(entry, {containerId: id, imageRef: ctx.imageRef, imageId: ctx.imageId,
      networkId: spec.networkId, spec, phase: 'created'}).problems;
    if (problems.length > 0) throw new WorkspaceRefused(`${role}_sandbox`, problems.join(', '));
    const run = ctx.attach(['start', '--attach', id]);
    let out = '';
    run.stdout.on('data', (chunk: Buffer | string) => { if (out.length < RESULT_LIMIT) out += chunk.toString(); });
    // The result line is read only once the output has ended: a process can exit before its output is drained.
    const ended = new Promise<void>((resolve) => { run.stdout.once('end', resolve); run.stdout.once('close', resolve); });
    let timer: NodeJS.Timeout | undefined;
    const exit = await Promise.race([Promise.all([run.exited, ended]).then(([code]) => code),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
    clearTimeout(timer);
    if (exit === null) {
      await ctx.docker(['container', 'kill', '--signal', 'KILL', id]);
      run.kill();
      throw new WorkspaceRefused(`${role}_timeout`, `the ${role} helper ran past ${timeoutMs} ms`);
    }
    const line = out.trim().split('\n').at(-1) ?? '';
    let result: {ok?: unknown; code?: unknown; detail?: unknown} = {};
    try { result = JSON.parse(line) as typeof result; } catch { /* reported below */ }
    if (exit !== 0 || result.ok !== true) {
      throw new WorkspaceRefused(typeof result.code === 'string' ? result.code : `${role}_failed`,
        typeof result.detail === 'string' ? result.detail : `exit ${exit}`);
    }
    return result;
  } finally {
    await ctx.docker(['container', 'rm', '--force', id]);
  }
}

/**
 * Reserves the attempt filesystem, creates its volumes and checks out the
 * base. Any failure refuses the start before the writer exists; whatever was
 * made is left for the caller's teardown, which finds it by journal and label.
 */
export async function prepareWorkspace(ctx: WorkspaceContext): Promise<AttemptFsRecord> {
  let record: AttemptFsRecord;
  try {
    record = await createAttemptFs(ctx.fsSystem, ctx.attemptRoot, ctx.runId, ctx.persistFs);
  } catch (error) {
    if (error instanceof AttemptFsError) throw new WorkspaceRefused(error.code, error.message);
    throw error;
  }
  for (const dir of ['src', 'work'] as const) {
    const made = await ctx.docker(attemptVolumeCreateArgs(record, ctx.runId, dir, labels(ctx, `volume-${dir}`)));
    if (made.code !== 0) throw new WorkspaceRefused('checkout_failed', `volume ${dir}: ${made.stderr.trim().slice(0, 200)}`);
  }
  const fetchNetwork = await ctx.create('fetch', ['network', 'create', '--driver', 'bridge',
    ...Object.entries(labels(ctx, 'fetch')).flatMap(([key, value]) => ['--label', `${key}=${value}`]), `sift-a-${ctx.runId}-fetch`]);
  try {
    await runHelper(ctx, 'checkout', helperSpec(ctx, 'checkout', fetchNetwork, [
      {volume: attemptVolumeName(ctx.runId, 'src'), target: '/src', readonly: false},
      {volume: attemptVolumeName(ctx.runId, 'work'), target: '/workspace', readonly: false},
    ], {HOME: '/tmp/h'}), ctx.timeouts?.checkoutMs ?? CHECKOUT_TIMEOUT_MS);
  } finally {
    await ctx.docker(['network', 'rm', fetchNetwork]);
  }
  return record;
}

/**
 * Builds the patch after every writer process has stopped, then copies it out
 * of the attempt filesystem as data: a regular file, opened without following
 * links, at most the cap. Returns it frozen for the evidence manifest.
 */
export async function freezePatch(ctx: WorkspaceContext, record: AttemptFsRecord, outDir: string): Promise<FrozenArtifact> {
  await runHelper(ctx, 'patch', helperSpec(ctx, 'patch', 'none', [
    {volume: attemptVolumeName(ctx.runId, 'work'), target: '/workspace', readonly: true},
    {volume: attemptVolumeName(ctx.runId, 'src'), target: '/out', readonly: false},
  ], {HOME: '/tmp/h', SIFT_MODE: 'patch'}), ctx.timeouts?.patchMs ?? PATCH_TIMEOUT_MS);
  const source = path.join(record.mountPoint, 'src', PATCH_FILE);
  const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let content: Buffer;
  try {
    const stat = await handle.stat();
    // The header line is counted in the cap by the helper; a little room covers it.
    if (!stat.isFile() || stat.size > MAX_PATCH_BYTES + 4096) throw new WorkspaceRefused('patch_failed', 'the patch is not a bounded regular file');
    content = await handle.readFile();
  } finally {
    await handle.close();
  }
  const target = path.join(outDir, PATCH_FILE);
  await fs.writeFile(target, content, {mode: 0o600});
  return {kind: 'patch', contentType: PATCH_CONTENT_TYPE, path: target, bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex')};
}

/**
 * Removes the attempt's volumes, then its filesystem. Returns what is still
 * held; the image is never deleted while a volume or mount may use it.
 */
export async function releaseWorkspace(docker: WorkspaceContext['docker'], fsSystem: AttemptFsSystem, runId: string,
  record: AttemptFsRecord): Promise<string[]> {
  const listed = await docker(['volume', 'ls', '--quiet', '--filter', `label=sift.machine.run=${runId}`]);
  if (listed.code !== 0) return [`volumes:${runId}`];
  const held: string[] = [];
  for (const name of listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const removed = await docker(['volume', 'rm', name]);
    if (removed.code !== 0 && !/no such volume/i.test(removed.stderr)) held.push(`volume:${name}`);
  }
  if (held.length > 0) return held;
  return releaseAttemptFs(fsSystem, record);
}

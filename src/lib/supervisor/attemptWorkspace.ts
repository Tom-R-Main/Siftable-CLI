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
 * killed and removed when its time is up or the attempt stops.
 *
 * Preparation follows the attempt's lifetime: once its signal aborts, no new
 * step starts (a system tool already running finishes within its own bound),
 * so the caller can wait for it to end before tearing down. A helper whose
 * removal cannot be shown is reported held, never assumed gone.
 */
import {createHash} from 'node:crypto';
import {constants, promises as fs} from 'node:fs';
import path from 'node:path';
import type {FrozenArtifact} from './attemptEvidence.js';
import {PATCH_CONTENT_TYPE} from './attemptEvidence.js';
import type {CheckoutPlan} from './attemptCheckout.js';
import {
  AttemptFsError, type AttemptFsRecord, type AttemptFsSystem, attemptVolumeCreateArgs, attemptVolumeName, attemptVolumeProblem, createAttemptFs,
  releaseAttemptFs,
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
  /** The attempt's lifetime: once aborted, no new step starts and a running helper is killed. */
  signal?: AbortSignal;
  /** Told of anything a step made that could not be shown removed (a helper container, the fetch bridge). */
  held?: (item: string) => void;
}

export class WorkspaceRefused extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
  }
}

const stopped = (ctx: WorkspaceContext) => {
  if (ctx.signal?.aborted) throw new WorkspaceRefused('interrupted', 'the attempt stopped before this step');
};

/** The attempt filesystem host, refusing to start any further step once the attempt has stopped. */
function guardedSystem(ctx: WorkspaceContext): AttemptFsSystem {
  const sys = ctx.fsSystem;
  return {...sys,
    run: async (file, args) => { stopped(ctx); return sys.run(file, args); },
    createExclusive: async (file, mode) => { stopped(ctx); return sys.createExclusive(file, mode); }};
}

const gone = (result: {code: number; stderr: string}) => result.code === 0 || /no such (container|network)|not found/i.test(result.stderr);

const labels = (ctx: Pick<WorkspaceContext, 'runId' | 'attemptId'>, role: string) =>
  ({'sift.machine.run': ctx.runId, 'sift.machine.role': role, 'sift.machine.attempt': ctx.attemptId});

/**
 * The writer's view of the attempt volume: the checkout (subpath `work`) read-only, and each write scope writable
 * over it by its literal `work/<scope>` subpath. The volume's root is never mounted.
 */
export function writerVolumes(runId: string, writeScope: string[]): SandboxVolume[] {
  const volume = attemptVolumeName(runId);
  return [{volume, target: '/workspace', readonly: true, subpath: 'work'},
    ...writeScope.map((scope) => ({volume, target: `/workspace/${scope}`, readonly: false, subpath: `work/${scope}`}))];
}

const volumeLabels = (ctx: Pick<WorkspaceContext, 'runId' | 'attemptId'>) => labels(ctx, 'volume');

/** Checked before every handoff: the attempt volume is still exactly ours, on the journaled loop device. */
export async function checkAttemptVolume(ctx: WorkspaceContext, record: AttemptFsRecord): Promise<void> {
  const shown = await ctx.docker(['volume', 'inspect', attemptVolumeName(ctx.runId)]);
  const [entry] = shown.code === 0 ? JSON.parse(shown.stdout) as unknown[] : [];
  const problem = attemptVolumeProblem(entry, record, ctx.runId, volumeLabels(ctx));
  if (problem) throw new WorkspaceRefused('attempt_volume', problem);
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
  stopped(ctx);
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
    let onAbort: (() => void) | undefined;
    const exit = await Promise.race([Promise.all([run.exited, ended]).then(([code]) => code),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
      new Promise<'stopped'>((resolve) => {
        onAbort = () => resolve('stopped');
        if (ctx.signal?.aborted) onAbort();
        else ctx.signal?.addEventListener('abort', onAbort, {once: true});
      })]);
    clearTimeout(timer);
    if (onAbort) ctx.signal?.removeEventListener('abort', onAbort);
    if (exit === null || exit === 'stopped') {
      await ctx.docker(['container', 'kill', '--signal', 'KILL', id]);
      run.kill();
      throw exit === null ? new WorkspaceRefused(`${role}_timeout`, `the ${role} helper ran past ${timeoutMs} ms`)
        : new WorkspaceRefused('interrupted', `the attempt stopped while the ${role} helper ran`);
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
    const removed = await ctx.docker(['container', 'rm', '--force', id]);
    if (!gone(removed)) ctx.held?.(`container:${id}`);
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
    record = await createAttemptFs(guardedSystem(ctx), ctx.attemptRoot, ctx.runId, ctx.persistFs);
  } catch (error) {
    if (error instanceof AttemptFsError) throw new WorkspaceRefused(error.code, error.message);
    throw error;
  }
  stopped(ctx);
  const made = await ctx.docker(attemptVolumeCreateArgs(record, ctx.runId, volumeLabels(ctx)));
  if (made.code !== 0) throw new WorkspaceRefused('checkout_failed', `volume: ${made.stderr.trim().slice(0, 200)}`);
  await checkAttemptVolume(ctx, record);
  stopped(ctx);
  const fetchNetwork = await ctx.create('fetch', ['network', 'create', '--driver', 'bridge',
    ...Object.entries(labels(ctx, 'fetch')).flatMap(([key, value]) => ['--label', `${key}=${value}`]), `sift-a-${ctx.runId}-fetch`]);
  try {
    await runHelper(ctx, 'checkout', helperSpec(ctx, 'checkout', fetchNetwork, [
      {volume: attemptVolumeName(ctx.runId), target: '/src', readonly: false, subpath: 'src'},
      {volume: attemptVolumeName(ctx.runId), target: '/workspace', readonly: false, subpath: 'work'},
    ], {HOME: '/tmp/h'}), ctx.timeouts?.checkoutMs ?? CHECKOUT_TIMEOUT_MS);
  } finally {
    const removed = await ctx.docker(['network', 'rm', fetchNetwork]);
    if (!gone(removed)) ctx.held?.(`network:${fetchNetwork}`);
  }
  return record;
}

/**
 * Builds the patch after every writer process has stopped, then copies it out
 * of the attempt filesystem as data: a regular file, opened without following
 * links, at most the cap. Returns it frozen for the evidence manifest.
 */
export async function freezePatch(ctx: WorkspaceContext, record: AttemptFsRecord, outDir: string): Promise<FrozenArtifact> {
  await checkAttemptVolume(ctx, record);
  await runHelper(ctx, 'patch', helperSpec(ctx, 'patch', 'none', [
    {volume: attemptVolumeName(ctx.runId), target: '/workspace', readonly: true, subpath: 'work'},
    {volume: attemptVolumeName(ctx.runId), target: '/out', readonly: false, subpath: 'src'},
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
 * Removes the attempt's volume, verified as its own, then its filesystem. Returns what is still held: a volume
 * that is not exactly ours, cannot be inspected or cannot be removed holds the backing storage, and the image is
 * never deleted while a volume or mount may use it.
 */
export async function releaseWorkspace(docker: WorkspaceContext['docker'], fsSystem: AttemptFsSystem, ctx: Pick<WorkspaceContext, 'runId' | 'attemptId'>,
  record: AttemptFsRecord): Promise<string[]> {
  const listed = await docker(['volume', 'ls', '--quiet', '--filter', `label=sift.machine.run=${ctx.runId}`]);
  if (listed.code !== 0) return [`volumes:${ctx.runId}`];
  const held: string[] = [];
  for (const name of listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const shown = await docker(['volume', 'inspect', name]);
    const [entry] = shown.code === 0 ? JSON.parse(shown.stdout) as unknown[] : [];
    if (attemptVolumeProblem(entry, record, ctx.runId, volumeLabels(ctx))) { held.push(`volume_unverified:${name}`); continue; }
    const removed = await docker(['volume', 'rm', name]);
    if (removed.code !== 0 && !/no such volume/i.test(removed.stderr)) held.push(`volume:${name}`);
  }
  if (held.length > 0) return held;
  return releaseAttemptFs(fsSystem, record);
}

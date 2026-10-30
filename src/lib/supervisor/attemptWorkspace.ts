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
import {admitDependencies, DependencyRefused, MAX_MANIFEST_BYTES} from './attemptDependencies.js';
import {INSTALL_LOG, MAX_INSTALL_LOG_BYTES, MAX_PATCH_BYTES, PATCH_FILE} from './checkoutHelper.js';
import {evaluateNetworkInspect, evaluateSandboxInspect, networkCreateArgs, sandboxCreateArgs, type SandboxContainerSpec,
  type SandboxVolume} from './containerSandbox.js';
import {PROXY_PORT} from './registryProxy.js';
import {SANDBOX_UID} from './attemptFilesystem.js';
import type {Attach} from './machineQualify.js';

export const CHECKOUT_TIMEOUT_MS = 180_000;
export const PATCH_TIMEOUT_MS = 10_000;
export const INSTALL_TIMEOUT_MS = 300_000;
const RESULT_LIMIT = 64 * 1024;

export type HelperRole = 'fetch' | 'checkout' | 'patch' | 'volume' | 'install-net' | 'egress' | 'proxy' | 'install'
  | 'verify-checkout' | 'tree-check' | 'report' | 'verifier';
/** The helpers that run a shipped program and answer with one JSON line. */
export type ProgramRole = 'checkout' | 'patch' | 'install' | 'verify-checkout' | 'tree-check' | 'report';

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
  /** The shipped registry proxy program; needed only to install dependencies. */
  proxyAsset?: string;
  /** The host's own addresses, which the registry proxy refuses to reach. */
  hostAddresses?: string[];
  docker: (args: string[]) => Promise<{code: number; stdout: string; stderr: string}>;
  attach: Attach;
  /** The caller's journaled create: records the request before sending and the ID when it answers. */
  create: (role: HelperRole, args: string[]) => Promise<string>;
  fsSystem: AttemptFsSystem;
  attemptRoot: string;
  persistFs: (record: AttemptFsRecord) => Promise<void>;
  /** Tests shorten these; production uses the contract's bounds. */
  timeouts?: {checkoutMs?: number; patchMs?: number; installMs?: number};
  /** The attempt's lifetime: once aborted, no new step starts and a running helper is killed. */
  signal?: AbortSignal;
  /** Told of anything a step made that could not be shown removed (a helper container, the fetch bridge). */
  held?: (item: string) => void;
}

export class WorkspaceRefused extends Error {
  /** A failed dependency install's own output, so the caller can keep it before the filesystem goes. */
  log?: Buffer;
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
  }
}

export const stopped = (ctx: Pick<WorkspaceContext, 'signal'>) => {
  if (ctx.signal?.aborted) throw new WorkspaceRefused('interrupted', 'the attempt stopped before this step');
};

/** The attempt filesystem host, refusing to start any further step once the attempt has stopped. */
function guardedSystem(ctx: WorkspaceContext): AttemptFsSystem {
  const sys = ctx.fsSystem;
  return {...sys,
    run: async (file, args) => { stopped(ctx); return sys.run(file, args); },
    createExclusive: async (file, mode) => { stopped(ctx); return sys.createExclusive(file, mode); }};
}

export const gone = (result: {code: number; stderr: string}) => result.code === 0 || /no such (container|network)|not found/i.test(result.stderr);

export const labels = (ctx: Pick<WorkspaceContext, 'runId' | 'attemptId'>, role: string) =>
  ({'sift.machine.run': ctx.runId, 'sift.machine.role': role, 'sift.machine.attempt': ctx.attemptId});

/**
 * The writer's view of the attempt volume: the checkout (subpath `work`) read-only, the installed dependencies
 * (subpath `deps/node_modules`) read-only at node_modules when there are any, and each write scope writable over it
 * by its literal `work/<scope>` subpath. The volume's root is never mounted.
 */
export function writerVolumes(runId: string, writeScope: string[], dependencies = false): SandboxVolume[] {
  const volume = attemptVolumeName(runId);
  return [{volume, target: '/workspace', readonly: true, subpath: 'work'},
    ...(dependencies ? [{volume, target: '/workspace/node_modules', readonly: true, subpath: 'deps/node_modules'}] : []),
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

export function helperSpec(ctx: WorkspaceContext, role: ProgramRole, networkId: string, volumes: SandboxVolume[],
  env: Record<string, string>, program = {source: ctx.helperAsset, target: '/sift/checkoutHelper.js'}): SandboxContainerSpec {
  return {
    name: `sift-a-${ctx.runId}-${role}`, imageRef: ctx.imageRef, networkId, labels: labels(ctx, role),
    entrypoint: 'node', command: [program.target],
    mounts: [program], volumes, tmpfs: ['/tmp'],
    env: {...env, SIFT_CHECKOUT: JSON.stringify(ctx.checkout)},
    limits: {cpus: 2, memoryMb: 2048, pidsLimit: 256}, cgroupParent: ctx.slice,
  };
}

/** Creates, checks, runs and removes one helper; returns its JSON result line. Never leaves it running. */
export async function runHelper(ctx: WorkspaceContext, role: ProgramRole, spec: SandboxContainerSpec, timeoutMs: number,
  resultLimit = RESULT_LIMIT) {
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
    run.stdout.on('data', (chunk: Buffer | string) => { if (out.length < resultLimit) out += chunk.toString(); });
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
  // Journaled like any create: a reply that never comes holds the backing storage until the volume is found or ruled out.
  await ctx.create('volume', attemptVolumeCreateArgs(record, ctx.runId, volumeLabels(ctx)));
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
export async function freezePatch(ctx: WorkspaceContext, record: AttemptFsRecord, outDir: string): Promise<FrozenArtifact & {changed: string[]}> {
  await checkAttemptVolume(ctx, record);
  const built = await runHelper(ctx, 'patch', helperSpec(ctx, 'patch', 'none', [
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
  // The changed paths, for the frozen-test check (U3); a list the helper did not return is refused.
  const changed = (built as {changed?: unknown}).changed;
  if (!Array.isArray(changed) || changed.some((file) => typeof file !== 'string')) throw new WorkspaceRefused('patch_failed', 'no changed-path list');
  return {kind: 'patch', contentType: PATCH_CONTENT_TYPE, path: target, bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'), changed: changed as string[]};
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

/** Reads a regular file the checkout or a helper wrote, without following links, within a cap. */
async function readBounded(file: string, cap: number): Promise<Buffer | null> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > cap) throw new WorkspaceRefused('unsupported_dependency_source', `${path.basename(file)} is not a bounded regular file`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

const networkArgs = (ctx: WorkspaceContext, role: string, name: string, internal: boolean) => (internal
  ? networkCreateArgs(name, labels(ctx, role))
  : ['network', 'create', '--driver', 'bridge', ...Object.entries(labels(ctx, role)).flatMap(([key, value]) => ['--label', `${key}=${value}`]), name]);

/**
 * Admits and installs the checkout's npm dependencies (dependency install
 * contract rev 3), after the checkout and before the writer. The manifests are
 * read from the checkout as data and admitted; their exact bytes go to the deps
 * volume, where the install helper runs npm ci on an internal network whose
 * only route out is the registry proxy. The proxy, both networks and the helper
 * are removed before the writer's network exists. Returns the install log.
 */
export async function installDependencies(ctx: WorkspaceContext, record: AttemptFsRecord): Promise<Buffer> {
  if (!ctx.proxyAsset) throw new WorkspaceRefused('dependency_install_failed', 'the registry proxy program is missing');
  const work = path.join(record.mountPoint, 'work');
  const deps = path.join(record.mountPoint, 'deps');
  const manifest = await readBounded(path.join(work, 'package.json'), MAX_MANIFEST_BYTES);
  const lock = await readBounded(path.join(work, 'package-lock.json'), MAX_MANIFEST_BYTES);
  if (!manifest || !lock) throw new WorkspaceRefused('unsupported_dependency_source', 'the checkout has no package.json and package-lock.json at its root');
  try {
    admitDependencies(manifest.toString('utf8'), lock.toString('utf8'));
  } catch (error) {
    if (error instanceof DependencyRefused) throw new WorkspaceRefused(error.code, error.message);
    throw error;
  }
  // The writer's node_modules is the installed one, mounted over an empty directory; a committed one is not admitted.
  if (await fs.lstat(path.join(work, 'node_modules')).then(() => true, () => false)) {
    throw new WorkspaceRefused('unsupported_dependency_source', 'the checkout commits a top-level node_modules');
  }
  await fs.mkdir(path.join(work, 'node_modules'), {mode: 0o755});
  await ctx.fsSystem.chown(path.join(work, 'node_modules'), SANDBOX_UID, SANDBOX_UID);
  // The admitted bytes stay root-owned and read-only: the install helper (uid 10001) reads them and cannot change them.
  for (const [name, bytes] of [['package.json', manifest], ['package-lock.json', lock]] as const) {
    await fs.writeFile(path.join(deps, name), bytes, {mode: 0o444, flag: 'wx'});
  }
  stopped(ctx);
  await checkAttemptVolume(ctx, record);

  const proxyName = `sift-a-${ctx.runId}-proxy`;
  stopped(ctx);
  const installNet = await ctx.create('install-net', networkArgs(ctx, 'install-net', `sift-a-${ctx.runId}-install`, true));
  const made2: string[] = [];
  try {
    stopped(ctx);
    const egress = await ctx.create('egress', networkArgs(ctx, 'egress', `sift-a-${ctx.runId}-egress`, false));
    made2.push(egress);
    stopped(ctx);
    const proxySpec: SandboxContainerSpec = {
      name: proxyName, imageRef: ctx.imageRef, networkId: egress, labels: labels(ctx, 'proxy'),
      entrypoint: 'node', command: ['/sift/registryProxy.js'], mounts: [{source: ctx.proxyAsset, target: '/sift/registryProxy.js'}],
      tmpfs: ['/tmp'], env: {SIFT_DENY_ADDRESSES: (ctx.hostAddresses ?? []).join(','),
        SIFT_PROXY_LIFETIME_MS: String((ctx.timeouts?.installMs ?? INSTALL_TIMEOUT_MS) + 30_000)},
      limits: {cpus: 0.5, memoryMb: 256, pidsLimit: 64}, cgroupParent: ctx.slice,
    };
    const proxy = await ctx.create('proxy', sandboxCreateArgs(proxySpec));
    try {
      const inspected = await ctx.docker(['container', 'inspect', proxy]);
      const [entry] = inspected.code === 0 ? JSON.parse(inspected.stdout) as unknown[] : [];
      const problems = evaluateSandboxInspect(entry, {containerId: proxy, imageRef: ctx.imageRef, imageId: ctx.imageId, networkId: egress,
        spec: proxySpec, phase: 'created'}).problems;
      if (problems.length > 0) throw new WorkspaceRefused('proxy_sandbox', problems.join(', '));
      const joined = await ctx.docker(['network', 'connect', installNet, proxy]);
      if (joined.code !== 0) throw new WorkspaceRefused('dependency_install_failed', `the proxy could not join the install network: ${joined.stderr.trim().slice(0, 200)}`);
      stopped(ctx);
      const started = await ctx.docker(['container', 'start', proxy]);
      if (started.code !== 0) throw new WorkspaceRefused('dependency_install_failed', `the proxy did not start: ${started.stderr.trim().slice(0, 200)}`);
      // The install network gets the attempt network's checks: ours, internal, no gateway or host address, and only the proxy on it.
      const network = await ctx.docker(['network', 'inspect', installNet]);
      const [networkEntry] = network.code === 0 ? JSON.parse(network.stdout) as unknown[] : [];
      const networkProblems = evaluateNetworkInspect(networkEntry, {networkId: installNet, labels: labels(ctx, 'install-net'),
        containerIds: [proxy], hostAddresses: ctx.hostAddresses ?? []});
      if (networkProblems.length > 0) throw new WorkspaceRefused('install_network', networkProblems.join(', '));
      try {
        await runHelper(ctx, 'install', helperSpec(ctx, 'install', installNet, [
          {volume: attemptVolumeName(ctx.runId), target: '/build', readonly: false, subpath: 'deps'},
        ], {HOME: '/tmp/h', SIFT_MODE: 'install', SIFT_PROXY: `http://${proxyName}:${PROXY_PORT}`}), ctx.timeouts?.installMs ?? INSTALL_TIMEOUT_MS);
      } catch (error) {
        // npm's output is the only account of why the install failed: it travels with the refusal.
        if (error instanceof WorkspaceRefused) error.log = await readBounded(path.join(deps, INSTALL_LOG), MAX_INSTALL_LOG_BYTES + 4096).catch(() => null) ?? undefined;
        throw error;
      }
    } finally {
      const removed = await ctx.docker(['container', 'rm', '--force', proxy]);
      if (!gone(removed)) ctx.held?.(`container:${proxy}`);
    }
  } finally {
    for (const network of [...made2, installNet]) {
      const removed = await ctx.docker(['network', 'rm', network]);
      if (!gone(removed)) ctx.held?.(`network:${network}`);
    }
  }
  return (await readBounded(path.join(deps, INSTALL_LOG), MAX_INSTALL_LOG_BYTES + 4096)) ?? Buffer.alloc(0);
}

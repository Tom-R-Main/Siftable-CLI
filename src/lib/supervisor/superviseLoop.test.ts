import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {attemptSliceCgroup} from './attemptCgroup.js';
import {GO_LINE, READY_LINE} from './attemptLauncher.js';
import type {DeadlineDocker} from './hostDocker.js';
import type {Attach} from './machineQualify.js';
import {generateMachineKey, machineKeyFingerprint, rawEd25519PublicKey} from './machineProtocol.js';
import {commitMachine, ensureStateDirectory, readJournal, writeCredential, writeJournal, writeKey} from './machineState.js';
import {OUTBOX} from './cleanupReceiptOutbox.js';
import {ATTEMPT_FS_BYTES, type AttemptFsSystem} from './attemptFilesystem.js';
import {type AttemptJournal, JOURNAL, superviseOnce, type SuperviseDeps} from './superviseLoop.js';
import {systemClock} from './superviseAuthority.js';

const API = 'https://api.example';
const IMAGE = `registry.example/sift-agent@sha256:${'a'.repeat(64)}`;
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const ENROLLMENT = '33333333-3333-4333-8333-333333333333';
const RUNNER = '7a0c2a59-4f3e-4c1d-9b2e-5d6f7a8b9c0d';
const DISPATCH = '66666666-6666-4666-8666-666666666666';
const WORK_ITEM = '77777777-7777-4777-8777-777777777777';
const ATTEMPT = '88888888-8888-4888-8888-888888888888';
const INPUT_SHA = 'f'.repeat(64);
const STORAGE = 'https://storage.example/';
const MANIFEST = 'e'.repeat(64);
const WORKLOAD_OUTPUT = 'the workload ran\nand wrote to stderr too\n';
const CONTROL = '99999999-9999-4999-8999-999999999999';
const PLAN = {repositoryId: 'repo-1', branch: 'main', baseSha: 'c'.repeat(40), imageRef: IMAGE, command: ['sh', '-c', 'true']};
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();

/** Waits for a condition instead of a fixed time, so slow hosts cannot reorder the steps a test relies on. */
async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = performance.now();
  while (!condition()) {
    if (performance.now() - started > timeoutMs) throw new Error('Timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Scenario {
  dispatch?: object | null;
  claimExpiresAt?: string | 'none';
  controls?: () => Array<{id: string; action: string; state: string}>;
  heartbeat?: () => {status: number; body: object} | 'throw';
  ack?: () => {status: number} | 'throw';
  populated?: () => string;
  privileged?: boolean;
  agentExit?: number | 'never';
  runnerHeartbeat?: number;
  attachReplay?: boolean;
  runningStatus?: number;
  reviewStatus?: number;
  readyDelayMs?: number;
  /** The running inspect never returns, as a wedged Docker daemon would. */
  hangRunningInspect?: boolean;
  /** The attach commits on the server but its reply is lost. */
  attachLost?: boolean;
  /** The agent container create answers late, or never. */
  agentCreateDelay?: number | 'never';
  /** Every call after the attach is answered with this status (401 for a revoked credential). */
  afterAttach?: number;
  /** The terminal report for the attempt is answered with this status. */
  terminalStatus?: number;
  /** A lookup by exact name finds the resource an unanswered create made. */
  nameFound?: boolean;
  /** Consume is answered with this status, as when the runner's lease changed (409). */
  consumeStatus?: number;
  /** The frozen-input request is answered with this status. */
  inputStatus?: number;
  /** Each evidence upload PUT is answered with this status; a function sees the attempt number. */
  putStatus?: number | ((n: number) => number);
  /** Each evidence acknowledge is answered with this, or its reply is lost. */
  evidenceAck?: (n: number) => number | 'lost';
  /** The agent's attach stream never ends, even once its container is killed. */
  stdoutNeverEnds?: boolean;
  /** Called when evidence is declared, before the reply: a shutdown can arrive here. */
  onDeclare?: () => void;
  /** Whether the person has answered the writer's question yet. */
  answered?: () => boolean;
  /** Opening a question never answers (until the request is aborted). */
  openHangs?: boolean;
  /** Delivery receipts are answered with this status. */
  deliveryStatus?: number;
  /** A checkout plan (U5b-2c): the attempt filesystem lives under `root`; the helpers answer with these results. */
  checkout?: {root: string; result?: object; patchResult?: object; patchRmFails?: boolean; patchCreateLost?: boolean;
    /** Removing the attempt's volumes fails, as when one is still in use. */
    volumeRmFails?: boolean;
    /** The volume create's answer never comes (the daemon may still make it). */
    volumeCreateLost?: boolean;
    /** After this many inspections, Docker shows the volume on another device (it was replaced under us). */
    volumeMovesAfter?: number;
    /** Volumes that already exist, left by an earlier run. */
    seedVolumes?: string[];
    /** Files the checkout leaves at the repository root (package.json, package-lock.json). */
    files?: Record<string, string>;
    /** The install helper's result. */
    installResult?: object};
}

/** An attempt filesystem host where every step succeeds; mount points and directories are real, under the test's root. */
function attemptFsHost(options: {stallFallocate?: Promise<void>} = {}) {
  let attached = false;
  let mounted = false;
  const calls: string[] = [];
  const ok = (stdout = '') => ({code: 0, stdout, stderr: ''});
  const system: AttemptFsSystem = {
    createExclusive: async () => ({dev: 1, ino: 2}),
    async run(file, args) {
      const tool = file.split('/').at(-1)!;
      calls.push(`${tool} ${args[0]}`);
      if (tool === 'fallocate' && options.stallFallocate) await options.stallFallocate;
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
  return {system, calls};
}

/** The API, Docker and attached processes one attempt touches, recording what happened in order. */
function world(scenario: Scenario = {}) {
  const events: string[] = [];
  const modelKeys: Array<string | undefined> = [];
  const sidecarIo: {stdin?: PassThrough; stdout?: PassThrough} = {};
  const agentInput: {value?: Record<string, unknown>} = {};
  const posts: Array<{path: string; body: Record<string, unknown>; key?: string}> = [];
  const evidence = {puts: [] as Array<{url: string; headers: Record<string, string>; body: string}>, acknowledged: false, declared: [] as unknown[]};
  const receipts: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.startsWith(STORAGE)) {
      const n = evidence.puts.length + 1;
      evidence.puts.push({url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array).toString()});
      events.push('evidence-put');
      const status = typeof scenario.putStatus === 'function' ? scenario.putStatus(n) : scenario.putStatus ?? 200;
      return new Response(null, {status});
    }
    const route = url.slice(API.length);
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (route.includes('/runtime-requests')) {
      if (init.method === 'POST') posts.push({path: route, body, key: (init.headers as Record<string, string>)['Idempotency-Key']});
      if (route.endsWith('/runtime-requests/sync')) {
        const type = (body.observations as Array<{type: string}>)[0].type;
        events.push(`rr-sync:${type}`);
        if (type === 'opened' && scenario.openHangs) {
          return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
        }
        return new Response(JSON.stringify({version: 1, changed: 1}), {status: 200});
      }
      if (route.endsWith('/delivery')) {
        events.push(`rr-delivery:${(body.delivery as {outcome: string}).outcome}`);
        return new Response(JSON.stringify({version: 1}), {status: scenario.deliveryStatus ?? 200});
      }
      if (route.includes('open=true')) {
        return new Response(JSON.stringify({requests: [{providerRequestId: 'q-1', runtimeId: `machine:${ENROLLMENT}:${DISPATCH}`,
          createdAt: new Date().toISOString()}]}), {status: 200});
      }
      const requests = scenario.answered?.() ? [{id: 'req-1', providerRequestId: 'q-1', resolution: {answers: {branch: 'main'}}}] : [];
      return new Response(JSON.stringify({requests, truncated: false}), {status: 200});
    }
    const key = (init.headers as Record<string, string>)['Idempotency-Key'];
    const reply = (status: number, value: object) => new Response(JSON.stringify(value), {status});
    if (init.method === 'POST') posts.push({path: route, body, key});
    if (scenario.afterAttach && events.includes('attempt:starting') && !route.endsWith('/consume') && !route.endsWith('/runners/heartbeat')) {
      events.push(`denied:${route.split('/').at(-1)}`);
      return reply(scenario.afterAttach, {});
    }
    if (route.endsWith('/consume')) {
      events.push('consume');
      if (scenario.consumeStatus) return reply(scenario.consumeStatus, {detail: 'Runner lease changed; reconcile the existing runtime'});
      if (scenario.dispatch === null) return reply(200, {dispatch: null});
      return reply(200, {dispatch: {id: DISPATCH, workItemId: WORK_ITEM, computeGrantExpiresAt: null, ...scenario.dispatch},
        workItem: {id: WORK_ITEM, claimToken: 'claim-secret', title: 't', prompt: 'p',
          ...(scenario.claimExpiresAt === 'none' ? {} : {claimExpiresAt: scenario.claimExpiresAt ?? inFuture(600_000)})},
        controls: []});
    }
    if (route.endsWith('/cleanup-receipts')) {
      receipts.push(body.receipt as Record<string, unknown>);
      events.push(`receipt:${String((body.receipt as {state?: string}).state)}`);
      return reply(201, {});
    }
    if (route.endsWith('/runners/heartbeat')) { events.push('runner-heartbeat'); return reply(scenario.runnerHeartbeat ?? 200, {}); }
    if (route.includes('/model/')) {
      modelKeys.push(key);
      return new Response('event: done\n\n', {status: 200});
    }
    if (route.endsWith('/input')) {
      events.push('input');
      if (scenario.inputStatus) return reply(scenario.inputStatus, {});
      return reply(200, {payloadSha256: INPUT_SHA, task: {version: 2, title: 'From the server'}, replayed: false});
    }
    if (route.endsWith('/evidence-manifest/acknowledge')) {
      const n = events.filter((e) => e === 'evidence-ack').length + 1;
      events.push('evidence-ack');
      const outcome = scenario.evidenceAck?.(n) ?? 200;
      if (outcome === 200) evidence.acknowledged = true;
      if (outcome === 'lost') { evidence.acknowledged = true; throw new TypeError('fetch failed'); }
      return reply(outcome, {});
    }
    if (route.endsWith('/evidence-manifest')) {
      events.push('evidence-declare');
      evidence.declared.push(body.artifacts);
      scenario.onDeclare?.();
      const artifacts = body.artifacts as Array<{sha256: string}>;
      return reply(200, {manifestDigest: MANIFEST, acknowledgedAt: evidence.acknowledged ? '2026-10-29T00:00:00.000Z' : null,
        uploads: evidence.acknowledged ? [] : artifacts.map((artifact) => ({sha256: artifact.sha256, url: `${STORAGE}attempts/${ATTEMPT}/${artifact.sha256}`}))});
    }
    if (route.endsWith('/review')) { events.push('review'); return reply(scenario.reviewStatus ?? 200, {}); }
    if (route.endsWith('/fail')) { events.push('fail'); return reply(200, {}); }
    if (route.endsWith('/execution-attempts')) {
      events.push(`attempt:${String(body.state)}${body.endReason ? `:${String(body.endReason)}` : ''}`);
      if (body.state === 'running' && scenario.runningStatus) return reply(scenario.runningStatus, {});
      if (body.state === 'starting' && scenario.attachLost) throw new TypeError('fetch failed');
      if ((body.state === 'ended' || body.state === 'interrupted') && scenario.terminalStatus) return reply(scenario.terminalStatus, {});
      return reply(200, {attempt: {id: ATTEMPT, state: scenario.attachReplay ? 'ended' : body.state}, replayed: scenario.attachReplay === true});
    }
    if (route.endsWith('/controls/ack')) { events.push(`control-ack:${String(body.state)}`); return reply(200, {}); }
    if (route.endsWith('/ack')) {
      events.push(`ack:${String(body.state)}`);
      const outcome = body.state === 'acknowledged' ? scenario.ack?.() : undefined;
      if (outcome === 'throw') throw new TypeError('fetch failed');
      return reply(outcome?.status ?? 200, {});
    }
    if (route.includes('/controls?')) return reply(200, {controls: scenario.controls?.() ?? []});
    if (route.endsWith('/heartbeat')) {
      events.push('heartbeat');
      const outcome = scenario.heartbeat?.() ?? {status: 200, body: {authority: {claimExpiresAt: inFuture(300_000)}}};
      if (outcome === 'throw') throw new TypeError('fetch failed');
      return reply(outcome.status, outcome.body);
    }
    throw new Error(`unexpected ${init.method} ${route}`);
  }) as unknown as typeof fetch;

  const containers = new Map<string, string[]>();
  const started = new Set<string>();
  const volumes: string[] = [...(scenario.checkout?.seedVolumes ?? [])];
  let volumeInspections = 0;
  /** What each volume was created with; a seeded one is as the earlier run made it. */
  const volumeArgs = new Map<string, string[]>((scenario.checkout?.seedVolumes ?? []).map((name) => [name, ['volume', 'create', '--driver', 'local',
    '--opt', 'type=ext4', '--opt', 'device=/dev/loop0', '--opt', 'o=nodev,nosuid,nodiscard', '--label', `sift.machine.run=${name.split('-')[2]}`,
    '--label', 'sift.machine.role=volume', '--label', `sift.machine.attempt=${ATTEMPT}`, name]]));
  const mountParts = (m: string) => Object.fromEntries(m.split(',').map((p) => (p.includes('=') ? p.split('=') : [p, 'true']) as [string, string]));
  const flag = (args: string[], name: string) => args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : []));
  const docker: DeadlineDocker = async (args) => {
    const ok = (stdout = '') => ({code: 0, stdout, stderr: ''});
    const [a, b] = args;
    if (a === 'info') return ok(JSON.stringify({CgroupDriver: 'systemd', CgroupVersion: '2', ServerVersion: '28.5.1'}));
    if (a === 'image' && b === 'inspect') return ok(JSON.stringify([{Id: IMAGE_ID, RepoDigests: [IMAGE]}]));
    if (a === 'network' && b === 'create') {
      const helperNet = ['fetch', 'install', 'egress'].find((role) => args.at(-1)!.endsWith(`-${role}`));
      if (helperNet) { events.push(`${helperNet}-network-create`); return ok(`net-${helperNet}\n`); }
      events.push('network-create');
      return ok('net-1\n');
    }
    if (a === 'volume' && b === 'create' && scenario.checkout?.volumeCreateLost) return {code: 124, stdout: '', stderr: 'deadline passed'};
    if (a === 'volume') {
      events.push(`volume-${b}${b === 'create' ? `:${args.at(-1)!.split('-').at(-1)}` : ''}`);
      if (b === 'create') { volumes.push(args.at(-1)!); volumeArgs.set(args.at(-1)!, args); }
      if (b === 'inspect') {
        volumeInspections += 1;
        const moved = scenario.checkout?.volumeMovesAfter !== undefined && volumeInspections > scenario.checkout.volumeMovesAfter;
        const made = (volumeArgs.get(args[2]) ?? []).map((arg) => (moved && arg.startsWith('device=') ? 'device=/dev/loop7' : arg));
        const opts = Object.fromEntries(flag(made, '--opt').map((o) => [o.slice(0, o.indexOf('=')), o.slice(o.indexOf('=') + 1)]));
        return made.length ? ok(JSON.stringify([{Name: made.at(-1), Driver: flag(made, '--driver')[0], Options: opts,
          Labels: Object.fromEntries(flag(made, '--label').map((l) => l.split('=') as [string, string]))}])) : {code: 1, stdout: '[]', stderr: 'no such volume'};
      }
      if (b === 'rm' && scenario.checkout?.volumeRmFails) return {code: 1, stdout: '', stderr: 'volume is in use'};
      if (b === 'rm') volumes.splice(volumes.indexOf(args.at(-1)!), 1);
      return ok(b === 'ls' ? volumes.join('\n') : '');
    }
    if (a === 'network' && b === 'inspect' && args[2] === 'net-install') {
      return ok(JSON.stringify([{Id: 'net-install', Driver: 'bridge', Internal: true, EnableIPv6: false, Scope: 'local', Attachable: false,
        Ingress: false, Options: {'com.docker.network.bridge.gateway_mode_ipv4': 'isolated'}, IPAM: {Config: [{Subnet: '172.31.0.0/16'}]},
        // The same run and attempt labels as the proxy, with the network's own role.
        Labels: {...Object.fromEntries(flag(containers.get('c-proxy') ?? [], '--label').map((l) => l.split('=') as [string, string])),
          'sift.machine.role': 'install-net'},
        Containers: {'c-proxy': {}}}]));
    }
    if (a === 'network' && b === 'inspect') {
      return ok(JSON.stringify([{Id: 'net-1', Driver: 'bridge', Internal: true, EnableIPv6: false, Options: {'com.docker.network.bridge.gateway_mode_ipv4': 'isolated'}, IPAM: {Config: [{Subnet: '172.18.0.0/16'}]}, Scope: 'local', Attachable: false, Ingress: false,
        Labels: {'sift.machine.run': flag(containers.get('c-relay') ?? [], '--label').find((l) => l.startsWith('sift.machine.run='))?.split('=')[1],
          'sift.machine.attempt': ATTEMPT},
        // Only the relay and the agent join the attempt network; the helpers have their own or none.
        Containers: Object.fromEntries([...started].filter((id) => id === 'c-relay' || id === 'c-agent').map((id) => [id, {}]))}]));
    }
    if (a === 'container' && b === 'create') {
      const name = flag(args, '--name')[0];
      const id = `c-${['relay', 'checkout', 'patch', 'proxy', 'install'].find((role) => name.endsWith(`-${role}`)) ?? 'agent'}`;
      // The daemon may have made it, but the answer never came back within the deadline.
      if (id === 'c-patch' && scenario.checkout?.patchCreateLost) return {code: 124, stdout: '', stderr: 'deadline passed'};
      containers.set(id, args);
      events.push(`create:${id}`);
      // What the agent is handed, read while it still exists (the supervisor removes it on finish).
      const input = flag(args, '--mount').map((m) => /source=([^,]+),target=\/sift\/input\.json/.exec(m)?.[1]).find(Boolean);
      if (input) agentInput.value = JSON.parse(await fs.readFile(input, 'utf8')) as Record<string, unknown>;
      if (id === 'c-agent' && scenario.agentCreateDelay === 'never') return new Promise(() => {});
      if (id === 'c-agent' && scenario.agentCreateDelay) {
        await new Promise((resolve) => setTimeout(resolve, scenario.agentCreateDelay as number));
        events.push('create-answered:c-agent');
      }
      return ok(`${id}\n`);
    }
    if (a === 'container' && b === 'inspect' && args[2] === '--format') return ok(args.at(-1) === 'c-relay' ? '101\n' : '102\n');
    if (a === 'container' && b === 'inspect' && scenario.hangRunningInspect && started.size > 0) {
      events.push('inspect-hung');
      return new Promise(() => {});
    }
    if (a === 'container' && b === 'inspect') {
      return ok(JSON.stringify(args.slice(2).map((id) => {
        const created = containers.get(id)!;
        const memory = Number(flag(created, '--memory')[0].replace('m', ''));
        return {
          Id: id, Image: IMAGE_ID,
          Config: {Image: IMAGE, User: flag(created, '--user')[0], Entrypoint: flag(created, '--entrypoint'),
            Labels: Object.fromEntries(flag(created, '--label').map((l) => l.split('=') as [string, string]))},
          HostConfig: {Privileged: scenario.privileged === true, CapAdd: null, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
            ReadonlyRootfs: true, PidMode: '', IpcMode: 'private', UTSMode: '', UsernsMode: '', CgroupnsMode: 'private',
            CgroupParent: flag(created, '--cgroup-parent')[0], NetworkMode: flag(created, '--network')[0], Devices: [], VolumesFrom: null,
            PortBindings: {}, PublishAllPorts: false,
            Tmpfs: Object.fromEntries(flag(created, '--tmpfs').map((t) => [t.split(':')[0], t.slice(t.indexOf(':') + 1)])),
            RestartPolicy: {Name: 'no'}, Memory: memory * 1024 * 1024, MemorySwap: memory * 1024 * 1024,
            NanoCpus: Number(flag(created, '--cpus')[0]) * 1e9, PidsLimit: Number(flag(created, '--pids-limit')[0]),
            Mounts: flag(created, '--mount').map(mountParts).filter((parts) => parts.type === 'volume').map((parts) => ({Type: 'volume',
              Source: parts.source, Target: parts.target, ...(parts.readonly ? {ReadOnly: true} : {}),
              ...(parts['volume-subpath'] ? {VolumeOptions: {Subpath: parts['volume-subpath']}} : {})}))},
          Mounts: flag(created, '--mount').map(mountParts).map((parts) => (parts.type === 'volume'
            ? {Type: 'volume', Name: parts.source, Destination: parts.target, RW: !parts.readonly}
            : {Type: 'bind', Source: parts.source, Destination: parts.target, RW: false})),
          NetworkSettings: {Networks: {'sift-a': {NetworkID: started.has(id) ? 'net-1' : ''}}},
        };
      })));
    }
    if ((a === 'container' || a === 'network') && b === 'ls') {
      const byName = args.some((arg) => arg.startsWith('name='));
      events.push(byName ? `ls-name:${a}` : `ls:${a}`);
      return ok(byName && scenario.nameFound ? 'c-agent\n' : '');
    }
    if (a === 'container' && b === 'kill') {
      events.push(`kill:${args.at(-1)}`);
      // A killed container closes its attach stream.
      if (args.at(-1) === 'c-agent' && !scenario.stdoutNeverEnds) agentStdout?.end();
      return ok();
    }
    if ((a === 'network' && b === 'connect') || (a === 'container' && b === 'start')) { events.push(`${a}-${b}:${args.at(-1)}`); return ok(); }
    if (a === 'container' && b === 'rm') {
      events.push(`rm:${args.at(-1)}`);
      if (args.at(-1) === 'c-patch' && scenario.checkout?.patchRmFails) return {code: 124, stdout: '', stderr: 'deadline passed'};
      return ok();
    }
    if (a === 'network' && b === 'rm') { events.push('network-rm'); return ok(); }
    throw new Error(`unexpected docker ${args.join(' ')}`);
  };

  let resolveExit: (code: number) => void = () => {};
  let agentStdout: PassThrough | undefined;
  const attach: Attach = (args) => {
    const id = args.at(-1)!;
    started.add(id);
    events.push(`start:${id}`);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    if (id === 'c-checkout' || id === 'c-patch' || id === 'c-install') {
      const exited = (async () => {
        const result = (id === 'c-checkout' ? scenario.checkout?.result : id === 'c-patch' ? scenario.checkout?.patchResult
          : scenario.checkout?.installResult) ?? {ok: true};
        const [run] = (await fs.readdir(scenario.checkout!.root, {withFileTypes: true})).filter((entry) => entry.isDirectory());
        const mount = path.join(scenario.checkout!.root, run.name);
        if (id === 'c-checkout') {
          for (const [name, text] of Object.entries(scenario.checkout?.files ?? {})) await fs.writeFile(path.join(mount, 'work', name), text);
        }
        if (id === 'c-install') {
          await fs.mkdir(path.join(mount, 'deps', 'node_modules', 'left-pad'), {recursive: true});
          await fs.writeFile(path.join(mount, 'deps', 'install.log'),
            (result as {ok?: boolean}).ok === false ? 'npm error 404 Not Found - GET https://registry.npmjs.org/left-pad\n' : 'added 1 package in 1s\n');
        }
        // The patch helper writes the patch into the attempt filesystem's src directory.
        if (id === 'c-patch' && (result as {ok?: boolean}).ok !== false) await fs.writeFile(path.join(mount, 'src', 'sift.patch'), '# sift patch v1\n+change\n');
        stdout.end(`${JSON.stringify(result)}\n`);
        return (result as {ok?: boolean}).ok === false ? 2 : 0;
      })();
      return {stdin, stdout, exited, kill: () => stdout.end()};
    }
    if (id === 'c-relay') {
      sidecarIo.stdin = stdin;
      sidecarIo.stdout = stdout;
      return {stdin, stdout, exited: new Promise(() => {}), kill: () => stdout.end()};
    }
    agentStdout = stdout;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    setTimeout(() => stdout.write(`${READY_LINE}\n`), scenario.readyDelayMs ?? 0);
    stdin.on('data', (chunk: Buffer) => {
      if (!chunk.toString().includes(GO_LINE)) return;
      events.push('go');
      stdout.write(WORKLOAD_OUTPUT);
      if (scenario.agentExit !== 'never') setTimeout(() => resolveExit(scenario.agentExit ?? 0), 20);
    });
    return {stdin, stdout, exited, kill: () => stdout.end()};
  };

  const readFile = async (file: string) => {
    if (file.startsWith('/proc/')) return `0::${attemptSliceCgroup(ATTEMPT)}/docker-${file.split('/')[2]}.scope\n`;
    if (file.endsWith('cgroup.events')) return (scenario.populated ?? (() => 'populated 0\n'))();
    throw Object.assign(new Error('missing'), {code: 'ENOENT'});
  };
  return {events, posts, fetchImpl, docker, attach, readFile, modelKeys, sidecarIo, agentInput, evidence, receipts, containers};
}

describe('superviseOnce', () => {
  let root: string;
  let inputRoot: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(tmpdir(), 'sift-supervise-'));
    root = path.join(base, 'state');
    inputRoot = path.join(base, 'inputs');
    const key = generateMachineKey();
    const state = {root, owner: null};
    await ensureStateDirectory(state);
    await writeKey(state, key.pem);
    await writeCredential(state, 'sift_pat_supervisor');
    await commitMachine(state, {version: 1, apiUrl: API, enrollmentId: ENROLLMENT, runnerId: RUNNER,
      fingerprint: machineKeyFingerprint(rawEd25519PublicKey(key.privateKey)), scope: {type: 'user'}, enrolledAt: '2026-10-29T05:00:00.000Z'});
  });
  // Runs a test started in the background are stopped and drained even when an assertion fails first.
  let started: Array<() => Promise<unknown>> = [];
  const background = (run: Promise<unknown>, stop: () => void) => {
    started.push(async () => { stop(); await run.catch(() => undefined); });
    return run;
  };
  afterEach(async () => {
    await Promise.all(started.map((drain) => drain()));
    started = [];
    await fs.chmod(root, 0o700).catch(() => undefined);
    await fs.rm(path.dirname(root), {recursive: true, force: true});
  });

  const deps = (w: ReturnType<typeof world>, overrides: Partial<SuperviseDeps> = {}): SuperviseDeps => ({
    fetch: w.fetchImpl, docker: w.docker, attach: w.attach, clock: systemClock, readFile: w.readFile, hostAddresses: () => ['127.0.0.1', '10.84.15.113'],
    state: {root, owner: null}, log: () => {}, assets: {sidecar: '/opt/sift/relaySidecar.js', launcher: '/opt/sift/attemptLauncher.js'},
    inputRoot, resolvePlan: async () => PLAN, timing: {controlPollMs: 20, readyTimeoutMs: 1_000, logDrainMs: 200}, ...overrides,
  });
  const journal = () => readJournal<AttemptJournal>({root, owner: null}, JOURNAL);

  it('is idle when there is no dispatch', async () => {
    const w = world({dispatch: null});
    expect(await superviseOnce(deps(w))).toEqual({kind: 'idle'});
  });

  it('acknowledges only after a verified, ready start, then releases the workload and cleans up on exit', async () => {
    const w = world();
    const outcome = await superviseOnce(deps(w));
    expect(outcome).toMatchObject({kind: 'finished', reason: 'workload_exited', exitCode: 0,
      facts: {processesStopped: true, cgroupEmpty: 'empty', resourcesRemoved: true, held: []}});
    const order = (event: string) => w.events.indexOf(event);
    expect(order('runner-heartbeat')).toBeLessThan(order('consume'));
    expect(order('attempt:starting')).toBeLessThan(order('network-create'));
    expect(order('start:c-agent')).toBeLessThan(order('ack:acknowledged'));
    expect(order('ack:acknowledged')).toBeLessThan(order('attempt:running'));
    expect(order('attempt:running')).toBeLessThan(order('go'));
    expect(order('go')).toBeLessThan(order('kill:c-agent'));
    expect(order('attempt:ended')).toBeLessThan(order('review'));
    // The stop and its cleanup are reported with signed receipts once the run has settled.
    expect(order('review')).toBeLessThan(order('receipt:execution_stopped'));
    expect(order('receipt:execution_stopped')).toBeLessThan(order('receipt:cleaned'));
    expect(outcome).toMatchObject({settled: true});
    // The per-dispatch runtime identity, the agent's environment and nothing secret on disk.
    const attach = w.posts.find((post) => post.path.endsWith('/execution-attempts'))!;
    expect(attach.body).toMatchObject({runtimeId: `machine:${ENROLLMENT}:${DISPATCH}`, leaseGeneration: 1, state: 'starting', dispatchId: DISPATCH});
    expect(await journal()).toBeNull();
    const retired = await fs.readdir(path.join(root, 'retired'));
    const archived = await fs.readFile(path.join(root, 'retired', retired.find((name) => name.endsWith(JOURNAL))!), 'utf8');
    expect(archived).not.toContain('claim-secret');
    expect(await fs.readdir(inputRoot)).toEqual([]);
  });

  it('hands the agent the frozen input the server recorded for the attempt, fetched before any container', async () => {
    const w = world();
    await superviseOnce(deps(w));
    const order = (event: string) => w.events.indexOf(event);
    expect(order('attempt:starting')).toBeLessThan(order('input'));
    expect(order('input')).toBeLessThan(order('network-create'));
    expect(w.posts.find((post) => post.path.endsWith('/input'))?.body).toEqual({claimToken: 'claim-secret'});
    // The server's task and digest, not the consume body.
    expect(w.agentInput.value).toEqual({version: 1, attemptId: ATTEMPT, workItemId: WORK_ITEM, inputSha256: INPUT_SHA,
      task: {version: 2, title: 'From the server'}, plan: PLAN});
  });

  it('starts nothing when the server does not return the frozen input, and fails the start truthfully', async () => {
    const w = world({inputStatus: 409});
    expect(await superviseOnce(deps(w))).toMatchObject({kind: 'finished', reason: 'start_failed'});
    expect(w.events).not.toContain('network-create');
    expect(w.events).toContain('ack:failed');
  });

  it('stops on a Stop control, acknowledges it only after the cgroup is empty, and reports terminated', async () => {
    const w = world({agentExit: 'never', controls: () => [{id: CONTROL, action: 'stop', state: 'pending'}]});
    const outcome = await superviseOnce(deps(w));
    expect(outcome).toMatchObject({kind: 'finished', reason: 'stop_control', facts: {cgroupEmpty: 'empty'}});
    expect(w.events.indexOf('kill:c-agent')).toBeLessThan(w.events.indexOf('control-ack:acknowledged'));
    expect(w.events).toContain('attempt:ended:terminated');
  });

  it('holds everything and acknowledges nothing when the cgroup stays populated, and then blocks new work', async () => {
    const w = world({agentExit: 'never', controls: () => [{id: CONTROL, action: 'stop', state: 'pending'}], populated: () => 'populated 1\n'});
    const outcome = await superviseOnce(deps(w, {}));
    expect(outcome).toMatchObject({kind: 'finished', facts: {cgroupEmpty: 'populated', resourcesRemoved: false}});
    expect(w.events.some((event) => event.startsWith('control-ack'))).toBe(false);
    expect(w.events.some((event) => event.startsWith('rm:'))).toBe(false);
    expect(await journal()).toMatchObject({state: 'held'});
    const again = world({populated: () => 'populated 1\n'});
    expect(await superviseOnce(deps(again))).toMatchObject({kind: 'held'});
    expect(again.events).not.toContain('consume');
  }, 30_000);

  it('stops by the confirmed deadline when renewals fail, without acknowledging any Stop', async () => {
    // 46 s of claim leaves about 1 s once the clock allowance and teardown margin are taken off.
    const w = world({agentExit: 'never', claimExpiresAt: inFuture(46_000), heartbeat: () => 'throw'});
    const outcome = await superviseOnce(deps(w));
    expect(outcome).toMatchObject({kind: 'finished', reason: 'lease_lost'});
    expect(w.events.some((event) => event.startsWith('control-ack'))).toBe(false);
  }, 20_000);

  it('stops at once when a renewal is refused', async () => {
    const w = world({agentExit: 'never', claimExpiresAt: inFuture(60_000), heartbeat: () => ({status: 409, body: {}})});
    const startedAt = performance.now();
    expect(await superviseOnce(deps(w))).toMatchObject({kind: 'finished', reason: 'lease_lost'});
    expect(w.events).toContain('attempt:interrupted:lease_lost');
    // The first renewal is due halfway to the 15 s cap; the refusal ends the run there, not at the cap.
    expect(performance.now() - startedAt).toBeLessThan(12_000);
  }, 20_000);

  it('never sends go or a failed ack when the acknowledgement reply is lost', async () => {
    const w = world({ack: () => 'throw'});
    expect(await superviseOnce(deps(w))).toMatchObject({kind: 'finished', reason: 'ack_unknown'});
    expect(w.events).not.toContain('go');
    expect(w.events).not.toContain('ack:failed');
    expect(w.posts.filter((post) => post.path.endsWith('/ack')).every((post) => post.key === `${DISPATCH}:ack`)).toBe(true);
  });

  it('never starts a container that was not created as specified, and fails the start truthfully', async () => {
    const w = world({privileged: true});
    expect(await superviseOnce(deps(w))).toMatchObject({kind: 'finished', reason: 'start_failed'});
    expect(w.events.some((event) => event.startsWith('start:'))).toBe(false);
    expect(w.events).toContain('ack:failed');
  });

  it('refuses a compute-grant dispatch and a missing plan before creating anything', async () => {
    const grant = world({dispatch: {computeGrantId: 'g-1'}});
    expect(await superviseOnce(deps(grant))).toEqual({kind: 'refused', reason: 'compute_grant_dispatch_unsupported'});
    expect(grant.events).not.toContain('network-create');
    const noPlan = world();
    expect(await superviseOnce(deps(noPlan, {resolvePlan: async () => null}))).toEqual({kind: 'refused', reason: 'no_plan'});
    expect(noPlan.events).toContain('ack:failed');
  });

  it('stops and cleans up the running attempt when the service shuts down', async () => {
    const w = world({agentExit: 'never'});
    const shutdown = new AbortController();
    const running = background(superviseOnce(deps(w, {shutdown: shutdown.signal})), () => shutdown.abort());
    await until(() => w.events.includes('go'));
    expect(w.events).toContain('go');
    shutdown.abort();
    expect(await running).toMatchObject({kind: 'finished', reason: 'shutdown', facts: {cgroupEmpty: 'empty', resourcesRemoved: true}});
    expect(w.events).toContain('attempt:interrupted:terminated');
    expect(w.events.some((event) => event.startsWith('control-ack'))).toBe(false);
    expect(await journal()).toBeNull();
  });

  it('never runs a dispatch twice: a ledgered dispatch handed back again is only reconciled', async () => {
    await superviseOnce(deps(world()));
    const again = world();
    expect(await superviseOnce(deps(again))).toEqual({kind: 'refused', reason: 'dispatch_already_executed'});
    expect(again.events).not.toContain('network-create');
    expect(again.events).toContain('fail');
  });

  it('treats a replayed or advanced attach as reconciliation, never a launch', async () => {
    const w = world({attachReplay: true});
    expect(await superviseOnce(deps(w))).toMatchObject({kind: 'refused', reason: 'attach_not_fresh_200'});
    expect(w.events).not.toContain('network-create');
  });

  it('sends no go unless the server confirms the attempt running', async () => {
    const w = world({runningStatus: 409});
    expect(await superviseOnce(deps(w))).toMatchObject({kind: 'finished', reason: 'start_failed'});
    expect(w.events).toContain('ack:acknowledged');
    expect(w.events).not.toContain('go');
  });

  it('keeps an unconfirmed settlement and completes it later with the recovered claim, without relaunching', async () => {
    const first = world({reviewStatus: 503});
    expect(await superviseOnce(deps(first))).toMatchObject({kind: 'finished', reason: 'workload_exited', settled: false});
    expect(await journal()).toMatchObject({state: 'settling', settlement: {attemptReport: 'done', work: 'pending', exitCode: 0}});
    const second = world();
    expect(await superviseOnce(deps(second))).toEqual({kind: 'recovered', settled: true});
    expect(second.events).toEqual(['runner-heartbeat', 'consume', 'review']);
    expect(await journal()).toBeNull();
  });

  it('enforces the confirmed lease during startup: no ack and no go once it has passed', async () => {
    // About 0.3 s of confirmed lease; the launcher reports ready only after a second.
    const w = world({claimExpiresAt: inFuture(45_300), readyDelayMs: 1_000});
    expect(await superviseOnce(deps(w))).toMatchObject({kind: 'finished', reason: 'lease_lost'});
    expect(w.events).not.toContain('ack:acknowledged');
    expect(w.events).not.toContain('go');
  });

  it('refuses a dispatch with no confirmed lease left before creating anything', async () => {
    const w = world({claimExpiresAt: inFuture(30_000)});
    expect(await superviseOnce(deps(w))).toEqual({kind: 'refused', reason: 'no_confirmed_lease'});
    expect(w.events).not.toContain('network-create');
  });

  it('announces the runner before consuming, and stops if the machine is not admitted', async () => {
    const w = world({runnerHeartbeat: 403});
    expect(await superviseOnce(deps(w))).toEqual({kind: 'refused', reason: 'not_admitted'});
    expect(w.events).toEqual(['runner-heartbeat']);
  });

  it('gives concurrent model calls distinct, journaled call IDs', async () => {
    const w = world({agentExit: 'never', controls: () => (w.modelKeys.length >= 2 ? [{id: CONTROL, action: 'stop', state: 'pending'}] : [])});
    const shutdown = new AbortController();
    const running = background(superviseOnce(deps(w, {shutdown: shutdown.signal})), () => shutdown.abort());
    await until(() => w.events.includes('go'));
    const frame = (id: number) => `${JSON.stringify({id, method: 'POST', path: '/sift/v1/model/anthropic/v1/messages', body: Buffer.from('{}').toString('base64')})}\n`;
    w.sidecarIo.stdout?.write(frame(1) + frame(2));
    expect(await running).toMatchObject({kind: 'finished', reason: 'stop_control'});
    expect([...w.modelKeys].sort()).toEqual([`${ATTEMPT}:1`, `${ATTEMPT}:2`]);
  });

  it('interrupts a startup await that never returns when the service shuts down, and still cleans up', async () => {
    const w = world({hangRunningInspect: true});
    const shutdown = new AbortController();
    const running = background(superviseOnce(deps(w, {shutdown: shutdown.signal})), () => shutdown.abort());
    await until(() => w.events.includes('inspect-hung'));
    expect(w.events).toContain('inspect-hung');
    const stoppedAt = performance.now();
    shutdown.abort();
    expect(await running).toMatchObject({kind: 'finished', reason: 'shutdown', facts: {cgroupEmpty: 'empty', resourcesRemoved: true}});
    expect(performance.now() - stoppedAt).toBeLessThan(5_000);
    expect(w.events).toEqual(expect.arrayContaining(['kill:c-relay', 'kill:c-agent']));
    expect(w.events).not.toContain('ack:acknowledged');
    expect(w.events).not.toContain('go');
  });

  it('ends an attempt whose attach reply was lost, by its journaled runtime, before failing the start', async () => {
    const w = world({attachLost: true});
    expect(await superviseOnce(deps(w))).toEqual({kind: 'refused', reason: 'attach_unknown'});
    expect(w.events).toEqual(['runner-heartbeat', 'consume', 'attempt:starting', 'attempt:ended:failed', 'ack:failed']);
    expect(await journal()).toBeNull();
  });

  it('ends an attempt attached just before a crash, though its ID was never saved', async () => {
    await writeJournal({root, owner: null}, JOURNAL, {version: 1, state: 'claimed', runId: 'abc123abc123', dispatchId: DISPATCH,
      workItemId: WORK_ITEM, runtimeId: `machine:${ENROLLMENT}:${DISPATCH}`, containers: {}, callSeq: 0,
      workspace: {repositoryId: PLAN.repositoryId, branch: PLAN.branch, baseSha: PLAN.baseSha}} satisfies AttemptJournal);
    const w = world();
    expect(await superviseOnce(deps(w))).toEqual({kind: 'recovered', settled: true});
    expect(w.events).toEqual(['ls:container', 'ls:network', 'runner-heartbeat', 'consume', 'attempt:ended:failed', 'ack:failed']);
  });

  it('records a create that answers after shutdown and removes it, instead of trusting an empty sweep', async () => {
    const w = world({agentCreateDelay: 600});
    const shutdown = new AbortController();
    const running = background(superviseOnce(deps(w, {shutdown: shutdown.signal})), () => shutdown.abort());
    await until(() => w.events.includes('create:c-agent'));
    expect(w.events).toContain('create:c-agent');
    shutdown.abort();
    expect(await running).toMatchObject({kind: 'finished', reason: 'shutdown', facts: {resourcesRemoved: true, held: []}});
    const answered = w.events.indexOf('create-answered:c-agent');
    expect(answered).toBeGreaterThan(-1);
    expect(w.events.indexOf('rm:c-agent')).toBeGreaterThan(answered);
  });

  it('holds a create that never answers, and blocks new work until a later start sweeps it', async () => {
    const w = world({agentCreateDelay: 'never'});
    const shutdown = new AbortController();
    const running = background(superviseOnce(deps(w, {shutdown: shutdown.signal})), () => shutdown.abort());
    await until(() => w.events.includes('create:c-agent'));
    shutdown.abort();
    const outcome = await running;
    expect(outcome).toMatchObject({kind: 'finished', reason: 'shutdown', settled: false, facts: {resourcesRemoved: false}});
    expect((outcome as {facts: {held: string[]}}).facts.held).toContain('create:agent');
    expect(await journal()).toMatchObject({state: 'held', pendingCreates: ['agent']});
    // The receipts owed say so: stopped, but cleanup failed on the unanswered create; never cleaned.
    const outbox = await readJournal<{entries: Array<{facts: {state: string; reason: string | null}}>}>({root, owner: null}, OUTBOX);
    expect(outbox?.entries.map((entry) => entry.facts.state)).toEqual(['execution_stopped', 'cleanup_failed']);
    expect(outbox?.entries[1].facts.reason).toContain('create:agent');
    // An empty sweep proves nothing: still held, and no new work.
    const empty = world();
    expect(await superviseOnce(deps(empty))).toMatchObject({kind: 'held', held: expect.arrayContaining(['create:agent'])});
    expect(empty.events).toContain('ls-name:container');
    expect(empty.events).not.toContain('consume');
    // Found by its exact name: resolved, removed by the sweep, and settled.
    const found = world({nameFound: true});
    expect(await superviseOnce(deps(found))).toMatchObject({kind: 'recovered'});
    expect(await journal()).toBeNull();
  }, 30_000);

  it('lets the operator release an unknown create that Docker shows was never made', async () => {
    const w = world({agentCreateDelay: 'never'});
    const shutdown = new AbortController();
    const running = background(superviseOnce(deps(w, {shutdown: shutdown.signal})), () => shutdown.abort());
    await until(() => w.events.includes('create:c-agent'));
    shutdown.abort();
    await running;
    expect(await superviseOnce(deps(world()))).toMatchObject({kind: 'held'});
    const released = world();
    expect(await superviseOnce(deps(released, {releaseUnknownCreates: true}))).toMatchObject({kind: 'recovered'});
    expect(released.events).not.toContain('ls-name:container');
    expect(await journal()).toBeNull();
  }, 30_000);

  it('keeps settlement pending, never archived, when the credential is refused after an attach', async () => {
    const w = world({attachLost: true, afterAttach: 401});
    expect(await superviseOnce(deps(w))).toEqual({kind: 'refused', reason: 'attach_unknown'});
    expect(await journal()).toMatchObject({state: 'settling', settlement: {attemptReport: 'pending', work: 'pending'}});
  });

  it('records the server refusing to end a never-recorded attempt as a surfaced conflict, then fails the start', async () => {
    const w = world({attachLost: true, terminalStatus: 409});
    expect(await superviseOnce(deps(w))).toEqual({kind: 'refused', reason: 'attach_unknown', conflicts: ['attempt_report']});
    expect(w.events).toContain('ack:failed');
    expect(await journal()).toBeNull();
    const retired = await fs.readdir(path.join(root, 'retired'));
    const archived = JSON.parse(await fs.readFile(path.join(root, 'retired', retired.find((name) => name.endsWith(JOURNAL))!), 'utf8')) as AttemptJournal;
    expect(archived.settlement).toMatchObject({attemptReport: 'conflict', work: 'done'});
  });

  it('kills and removes even when the journal cannot be written, then raises the write failure', async () => {
    const w = world({agentExit: 'never'});
    const shutdown = new AbortController();
    const running = background(superviseOnce(deps(w, {shutdown: shutdown.signal})), () => shutdown.abort());
    await until(() => w.events.includes('go'));
    expect(w.events).toContain('go');
    await fs.chmod(root, 0o500);
    try {
      shutdown.abort();
      await expect(running).rejects.toThrow(/was stopped .*journal could not be written/);
    } finally {
      await fs.chmod(root, 0o700);
    }
    expect(w.events).toEqual(expect.arrayContaining(['kill:c-relay', 'kill:c-agent', 'rm:c-relay', 'rm:c-agent']));
    // The earlier journal survives for the next start.
    expect(await journal()).toMatchObject({state: 'running'});
  });

  it('kills at once on shutdown even while a journal write never completes', async () => {
    const w = world({agentExit: 'never'});
    const shutdown = new AbortController();
    let hang = false;
    let releaseWrites: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseWrites = resolve; });
    const writer = async (next: AttemptJournal) => {
      if (hang) await held;
      await writeJournal({root, owner: null}, JOURNAL, next);
    };
    const running = background(superviseOnce(deps(w, {shutdown: shutdown.signal, writeJournal: writer})), () => { shutdown.abort(); releaseWrites(); });
    await until(() => w.events.includes('go'));
    expect(w.events).toContain('go');
    hang = true;
    shutdown.abort();
    await until(() => w.events.includes('kill:c-agent') && w.events.includes('kill:c-relay'));
    // The journal is stuck, yet both known containers were killed.
    expect(w.events).toEqual(expect.arrayContaining(['kill:c-agent', 'kill:c-relay']));
    releaseWrites();
    expect(await running).toMatchObject({kind: 'finished', reason: 'shutdown'});
  });

  it('keeps the attempt journaled while its receipts cannot reach the outbox, and archives only once they do', async () => {
    // A directory where the outbox file belongs makes every outbox write fail.
    await fs.mkdir(path.join(root, OUTBOX));
    const w = world();
    expect(await superviseOnce(deps(w))).toMatchObject({kind: 'finished', reason: 'workload_exited', settled: false});
    expect(await journal()).toMatchObject({receiptsQueued: false,
      receipts: [expect.objectContaining({state: 'execution_stopped'}), expect.objectContaining({state: 'cleaned'})]});
    await fs.rmdir(path.join(root, OUTBOX));
    const next = world();
    expect(await superviseOnce(deps(next))).toMatchObject({kind: 'recovered', settled: true});
    expect(await journal()).toBeNull();
    const outbox = await readJournal<{entries: Array<{facts: {operationKey: string}}>}>({root, owner: null}, OUTBOX);
    expect(outbox?.entries.map((entry) => entry.facts.operationKey)).toEqual([`${ATTEMPT}:execution_stopped:1`, `${ATTEMPT}:cleaned:1`]);
  });

  it('keeps the receipt obligation when working out the receipts fails, and settles it once that works', async () => {
    let stopNow = false;
    const w = world({agentExit: 'never', controls: () => (stopNow ? [{id: CONTROL, action: 'stop', state: 'pending'}] : [])});
    const shutdown = new AbortController();
    const running = background(superviseOnce(deps(w, {shutdown: shutdown.signal})), () => shutdown.abort());
    await until(() => w.events.includes('go'));
    // The machine record cannot be read while the stop is handled.
    await fs.chmod(path.join(root, 'machine.json'), 0o000);
    stopNow = true;
    try {
      expect(await running).toMatchObject({kind: 'finished', reason: 'stop_control', settled: false});
    } finally {
      await fs.chmod(path.join(root, 'machine.json'), 0o600);
    }
    expect(await journal()).toMatchObject({receiptsDerived: false, receiptsQueued: false});
    const next = world();
    expect(await superviseOnce(deps(next))).toMatchObject({kind: 'recovered', settled: true});
    expect(await journal()).toBeNull();
    const outbox = await readJournal<{entries: Array<{facts: {state: string}}>}>({root, owner: null}, OUTBOX);
    expect(outbox?.entries.map((entry) => entry.facts.state)).toEqual(['execution_stopped', 'cleaned']);
  });

  it('keeps the receipt obligation while the machine state is incomplete, and settles it once restored', async () => {
    let stopNow = false;
    const w = world({agentExit: 'never', controls: () => (stopNow ? [{id: CONTROL, action: 'stop', state: 'pending'}] : [])});
    const shutdown = new AbortController();
    const running = background(superviseOnce(deps(w, {shutdown: shutdown.signal})), () => shutdown.abort());
    await until(() => w.events.includes('go'));
    // The credential goes missing while the stop is handled: the state reads as partial, not enrolled.
    await fs.rename(path.join(root, 'credential.json'), path.join(root, 'credential.json.away'));
    stopNow = true;
    try {
      expect(await running).toMatchObject({kind: 'finished', reason: 'stop_control', settled: false});
      expect(await journal()).toMatchObject({receiptsDerived: false, receiptsQueued: false});
    } finally {
      await fs.rename(path.join(root, 'credential.json.away'), path.join(root, 'credential.json'));
    }
    expect(await superviseOnce(deps(world()))).toMatchObject({kind: 'recovered', settled: true});
    const outbox = await readJournal<{entries: Array<{facts: {state: string}}>}>({root, owner: null}, OUTBOX);
    expect(outbox?.entries.map((entry) => entry.facts.state)).toEqual(['execution_stopped', 'cleaned']);
  });

  it('tears down a run left by a crash by exact ID and never relaunches it', async () => {
    await writeJournal({root, owner: null}, JOURNAL, {version: 1, state: 'running', runId: 'abc123abc123', dispatchId: DISPATCH,
      workItemId: WORK_ITEM, runtimeId: `machine:${ENROLLMENT}:${DISPATCH}`, attemptId: ATTEMPT, networkId: 'net-1',
      workspace: {repositoryId: PLAN.repositoryId, branch: PLAN.branch, baseSha: PLAN.baseSha},
      containers: {sidecar: 'c-relay', agent: 'c-agent'}, callSeq: 3} satisfies AttemptJournal);
    const w = world();
    expect(await superviseOnce(deps(w))).toEqual({kind: 'recovered', settled: true});
    // Journaled IDs are killed before any discovery listing runs; the server is then told with the recovered claim.
    // Receipts go out only after the physical recovery, never before it.
    expect(w.events).toEqual(['kill:c-relay', 'kill:c-agent', 'ls:container', 'ls:network', 'rm:c-relay', 'rm:c-agent', 'network-rm',
      'receipt:execution_stopped', 'receipt:cleaned', 'runner-heartbeat', 'consume', 'attempt:ended:failed', 'fail']);
    expect(w.events).not.toContain('network-create');
    expect(await journal()).toBeNull();
  });

  it('waits instead of exiting when consume reports the lease changed, keeping the earlier attempt journaled', async () => {
    await writeJournal({root, owner: null}, JOURNAL, {version: 1, state: 'running', runId: 'abc123abc123', dispatchId: DISPATCH,
      workItemId: WORK_ITEM, runtimeId: `machine:${ENROLLMENT}:${DISPATCH}`, attemptId: ATTEMPT, networkId: 'net-1',
      workspace: {repositoryId: PLAN.repositoryId, branch: PLAN.branch, baseSha: PLAN.baseSha},
      containers: {sidecar: 'c-relay', agent: 'c-agent'}, callSeq: 3} satisfies AttemptJournal);
    const w = world({consumeStatus: 409});
    expect(await superviseOnce(deps(w))).toEqual({kind: 'refused', reason: 'runner_lease_changed'});
    // Physical recovery and receipts still happen; nothing is reported with a claim this host does not hold.
    expect(w.events).toEqual(['kill:c-relay', 'kill:c-agent', 'ls:container', 'ls:network', 'rm:c-relay', 'rm:c-agent', 'network-rm',
      'receipt:execution_stopped', 'receipt:cleaned', 'runner-heartbeat', 'consume']);
    expect(await journal()).toMatchObject({state: 'settling'});
    // Once the operator requeues, consume hands back nothing for the old dispatch and the journal is archived.
    const after = world({dispatch: null});
    expect(await superviseOnce(deps(after))).toEqual({kind: 'recovered', settled: false});
    expect(await journal()).toBeNull();
    expect(await superviseOnce(deps(world({consumeStatus: 502})))).toEqual({kind: 'refused', reason: 'consume_http_502'});
  });

  describe('evidence (U5b-2b, log only)', () => {
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const receipts = (w: ReturnType<typeof world>) => w.posts.filter((post) => post.path.endsWith('/cleanup-receipts'))
      .map((post) => (post.body.receipt as {recoveryVolumeRetained?: boolean}).recoveryVolumeRetained);

    it('declares the frozen log after every process has stopped, uploads it create-only, and binds the review to it', async () => {
      const w = world();
      expect(await superviseOnce(deps(w))).toMatchObject({kind: 'finished', reason: 'workload_exited', settled: true});
      const order = (event: string) => w.events.indexOf(event);
      expect(order('rm:c-agent')).toBeLessThan(order('evidence-declare'));
      expect(order('evidence-ack')).toBeLessThan(order('review'));
      expect(w.evidence.declared).toEqual([[{kind: 'agent_log', sha256: sha(WORKLOAD_OUTPUT), bytes: WORKLOAD_OUTPUT.length,
        contentType: 'text/plain'}]]);
      expect(w.evidence.puts).toEqual([{url: `${STORAGE}attempts/${ATTEMPT}/${sha(WORKLOAD_OUTPUT)}`, body: WORKLOAD_OUTPUT,
        headers: {'Content-Type': 'text/plain', 'x-goog-if-generation-match': '0',
          'x-goog-content-length-range': `${WORKLOAD_OUTPUT.length},${WORKLOAD_OUTPUT.length}`}}]);
      const review = w.posts.find((post) => post.path.endsWith('/review'))!;
      expect(review.body.artifactRefs).toContainEqual({type: 'evidence_manifest', attemptId: ATTEMPT, manifestDigest: MANIFEST});
      expect(await fs.readdir(inputRoot)).toEqual([]);
    });

    it('fails the work when the upload never succeeds, keeping the log and claiming no retained volume', async () => {
      const w = world({putStatus: 503});
      expect(await superviseOnce(deps(w))).toMatchObject({kind: 'finished', reason: 'workload_exited', settled: true});
      expect(w.events.filter((e) => e === 'evidence-declare')).toHaveLength(3);
      expect(w.events).not.toContain('evidence-ack');
      expect(w.events).not.toContain('review');
      expect(w.events).toContain('attempt:ended:failed');
      const fail = w.posts.find((post) => post.path.endsWith('/fail'))!;
      expect(String(fail.body.failureReason)).toContain('evidence_upload_failed');
      // The log stays on the machine, byte for byte, and the archived journal says where.
      expect(await fs.readFile(path.join(inputRoot, ATTEMPT, 'agent.log'), 'utf8')).toBe(WORKLOAD_OUTPUT);
      const retired = await fs.readdir(path.join(root, 'retired'));
      const archived = JSON.parse(await fs.readFile(path.join(root, 'retired', retired.find((name) => name.endsWith(JOURNAL))!), 'utf8'));
      expect(archived.evidence).toMatchObject({sha256: sha(WORKLOAD_OUTPUT), bytes: WORKLOAD_OUTPUT.length, acknowledged: false});
      // Only a real retained volume would make this true; there is none in this cut.
      expect(receipts(w).length).toBeGreaterThan(0);
      expect(receipts(w).every((retained) => retained === false)).toBe(true);
    });

    it('settles a lost acknowledge reply by declaring again, without a second upload', async () => {
      const w = world({evidenceAck: (n) => (n === 1 ? 'lost' : 200)});
      expect(await superviseOnce(deps(w))).toMatchObject({kind: 'finished', reason: 'workload_exited', settled: true});
      expect(w.events.filter((e) => e === 'evidence-declare')).toHaveLength(2);
      expect(w.evidence.puts).toHaveLength(1);
      expect(w.events.filter((e) => e === 'evidence-ack')).toHaveLength(1);
      expect(w.events.filter((e) => e === 'review')).toHaveLength(1);
      // The same declaration both times: the frozen log's digest never changes.
      expect(w.evidence.declared[0]).toEqual(w.evidence.declared[1]);
    });

    /** A journal as a crash leaves it: the workload exited 0, its processes are gone, and the log was frozen. */
    async function crashedAfterFreeze(evidence: Partial<{acknowledged: boolean; manifestDigest: string}> | 'not-frozen',
      logText: string | null = WORKLOAD_OUTPUT) {
      const dir = path.join(inputRoot, ATTEMPT);
      await fs.mkdir(dir, {recursive: true});
      const logPath = path.join(dir, 'agent.log');
      if (logText !== null) await fs.writeFile(logPath, logText);
      await writeJournal({root, owner: null}, JOURNAL, {version: 1, state: 'stopping', runId: 'abc123abc123', dispatchId: DISPATCH,
        workItemId: WORK_ITEM, runtimeId: `machine:${ENROLLMENT}:${DISPATCH}`, attemptId: ATTEMPT, networkId: 'net-1',
        workspace: {repositoryId: PLAN.repositoryId, branch: PLAN.branch, baseSha: PLAN.baseSha},
        containers: {sidecar: 'c-relay', agent: 'c-agent'}, callSeq: 0, stop: {reason: 'workload_exited', exitCode: 0},
        evidenceOwed: true,
        ...(evidence === 'not-frozen' ? {} : {evidence: {path: logPath, sha256: sha(WORKLOAD_OUTPUT), bytes: WORKLOAD_OUTPUT.length, ...evidence}}),
      } satisfies AttemptJournal);
      return dir;
    }

    it('finishes an upload a crash cut off, under the recovered claim, and settles the clean exit as a review', async () => {
      const dir = await crashedAfterFreeze({});
      const w = world();
      expect(await superviseOnce(deps(w))).toEqual({kind: 'recovered', settled: true});
      const order = (event: string) => w.events.indexOf(event);
      expect(order('consume')).toBeLessThan(order('evidence-declare'));
      expect(order('evidence-ack')).toBeLessThan(order('review'));
      expect(w.evidence.puts).toHaveLength(1);
      const review = w.posts.find((post) => post.path.endsWith('/review'))!;
      expect(review.body.artifactRefs).toContainEqual({type: 'evidence_manifest', attemptId: ATTEMPT, manifestDigest: MANIFEST});
      expect(w.events).not.toContain('fail');
      await expect(fs.stat(dir)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('acknowledges once after a crash between the upload and its acknowledgement, without a second object', async () => {
      await crashedAfterFreeze({});
      const w = world({putStatus: 412});
      expect(await superviseOnce(deps(w))).toEqual({kind: 'recovered', settled: true});
      expect(w.events.filter((e) => e === 'evidence-ack')).toHaveLength(1);
      expect(w.events).toContain('review');
    });

    it('settles an acknowledgement journaled before a crash without uploading again', async () => {
      await crashedAfterFreeze({acknowledged: true, manifestDigest: MANIFEST});
      const w = world();
      expect(await superviseOnce(deps(w))).toEqual({kind: 'recovered', settled: true});
      expect(w.events).not.toContain('evidence-declare');
      const review = w.posts.find((post) => post.path.endsWith('/review'))!;
      expect(review.body.artifactRefs).toContainEqual({type: 'evidence_manifest', attemptId: ATTEMPT, manifestDigest: MANIFEST});
    });

    it('fails the work, never uploading, when the frozen log is gone after a crash', async () => {
      await crashedAfterFreeze({}, null);
      const w = world();
      expect(await superviseOnce(deps(w))).toEqual({kind: 'recovered', settled: true});
      expect(w.events).not.toContain('evidence-declare');
      const fail = w.posts.find((post) => post.path.endsWith('/fail'))!;
      expect(String(fail.body.failureReason)).toContain('evidence_upload_failed');
      expect(w.events).toContain('attempt:ended:failed');
    });

    it('fails the work, without crashing, when the log cannot be written', async () => {
      // The log's path is taken by a directory: opening it fails.
      await fs.mkdir(path.join(inputRoot, ATTEMPT, 'agent.log'), {recursive: true});
      const w = world();
      expect(await superviseOnce(deps(w))).toMatchObject({kind: 'finished', reason: 'workload_exited', settled: true});
      expect(w.events).not.toContain('evidence-declare');
      expect(String(w.posts.find((post) => post.path.endsWith('/fail'))!.body.failureReason)).toContain('evidence_upload_failed');
    });

    it('never declares a log whose stream did not reach its end', async () => {
      const w = world({stdoutNeverEnds: true});
      expect(await superviseOnce(deps(w))).toMatchObject({kind: 'finished', reason: 'workload_exited', settled: true});
      expect(w.events).not.toContain('evidence-declare');
      expect(w.events).not.toContain('review');
      expect(String(w.posts.find((post) => post.path.endsWith('/fail'))!.body.failureReason)).toContain('evidence_upload_failed');
    });

    it('fails the work when a crash came between the clean exit and freezing its log', async () => {
      await crashedAfterFreeze('not-frozen');
      const w = world();
      expect(await superviseOnce(deps(w))).toEqual({kind: 'recovered', settled: true});
      expect(w.events).not.toContain('evidence-declare');
      expect(w.events).not.toContain('review');
      expect(String(w.posts.find((post) => post.path.endsWith('/fail'))!.body.failureReason)).toContain('evidence_upload_failed');
    });

    it.each([['about to expire', inFuture(0)], ['without an expiry', 'none' as const]])(
      'uploads nothing on recovery under a claim %s, and fails the work', async (_label, claimExpiresAt) => {
        await crashedAfterFreeze({});
        const w = world({claimExpiresAt});
        expect(await superviseOnce(deps(w))).toMatchObject({kind: 'recovered'});
        expect(w.events).not.toContain('evidence-declare');
        expect(w.evidence.puts).toEqual([]);
        expect(w.events).not.toContain('review');
      });

    it('stops uploading when shutdown arrives during settlement, posts nothing, and finishes on the next start', async () => {
      const shutdown = new AbortController();
      const first = world({onDeclare: () => shutdown.abort()});
      expect(await superviseOnce(deps(first, {shutdown: shutdown.signal}))).toMatchObject({kind: 'finished', reason: 'workload_exited', settled: false});
      expect(first.evidence.puts).toEqual([]);
      expect(first.events).not.toContain('evidence-ack');
      expect(first.events).not.toContain('review');
      expect(first.events).not.toContain('fail');
      expect(await fs.readFile(path.join(inputRoot, ATTEMPT, 'agent.log'), 'utf8')).toBe(WORKLOAD_OUTPUT);
      // A shutdown during the resumed upload again decides and posts nothing.
      const again = new AbortController();
      const interrupted = world({onDeclare: () => again.abort()});
      expect(await superviseOnce(deps(interrupted, {shutdown: again.signal}))).toEqual({kind: 'recovered', settled: false});
      expect(interrupted.events).not.toContain('evidence-ack');
      expect(interrupted.events).not.toContain('review');
      expect(interrupted.events).not.toContain('fail');
      expect(interrupted.events).not.toContain('attempt:ended');
      // The next start finishes the upload under the recovered claim, then settles the clean exit as a review.
      const second = world();
      expect(await superviseOnce(deps(second))).toEqual({kind: 'recovered', settled: true});
      expect(second.events.filter((e) => e === 'evidence-ack')).toHaveLength(1);
      const review = second.posts.find((post) => post.path.endsWith('/review'))!;
      expect(review.body.artifactRefs).toContainEqual({type: 'evidence_manifest', attemptId: ATTEMPT, manifestDigest: MANIFEST});
    });
  });

  describe('Needs you (U5b-3)', () => {
    it('opens the writer\'s question, hands it the answer, records delivery on its receipt, and closes at the stop', async () => {
      let answered = false;
      const w = world({agentExit: 'never', answered: () => answered,
        controls: () => (w.events.includes('rr-delivery:delivered') ? [{id: CONTROL, action: 'stop', state: 'pending'}] : [])});
      const shutdown = new AbortController();
      const running = background(superviseOnce(deps(w, {shutdown: shutdown.signal})), () => shutdown.abort());
      await until(() => w.events.includes('go'));
      const replies: Array<{id: number; status?: number; body?: string}> = [];
      w.sidecarIo.stdin?.on('data', (chunk: Buffer) => chunk.toString().split('\n').filter(Boolean)
        .forEach((line) => replies.push(JSON.parse(line) as {id: number; status?: number; body?: string})));
      const send = (id: number, path: string, body: object) => w.sidecarIo.stdout?.write(
        `${JSON.stringify({id, method: 'POST', path, body: Buffer.from(JSON.stringify(body)).toString('base64')})}\n`);
      const replyTo = async (id: number) => {
        await until(() => replies.some((r) => r.id === id));
        const found = replies.find((r) => r.id === id)!;
        return {status: found.status, body: found.body ? JSON.parse(Buffer.from(found.body, 'base64').toString() || '{}') : undefined};
      };
      send(1, '/sift/v1/questions', {questionId: 'q-1', questions: [{id: 'branch', header: 'Branch', question: 'Which branch?', options: []}]});
      expect((await replyTo(1)).status).toBe(202);
      await until(() => w.events.includes('rr-sync:opened'));
      answered = true;
      send(2, '/sift/v1/questions/poll', {questionId: 'q-1'});
      const answer = await replyTo(2);
      expect(answer).toMatchObject({status: 200, body: {answers: {branch: 'main'}}});
      send(3, '/sift/v1/questions/received', {questionId: 'q-1', answerId: answer.body.answerId});
      expect((await replyTo(3)).status).toBe(200);
      expect(await running).toMatchObject({kind: 'finished', reason: 'stop_control'});
      const delivered = w.posts.filter((post) => post.path.endsWith('/delivery'));
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({path: `/api/v1/work-items/${WORK_ITEM}/runtime-requests/req-1/delivery`, key: 'req-1:delivered',
        body: {runtimeId: `machine:${ENROLLMENT}:${DISPATCH}`, leaseGeneration: 1, claimOwner: `mobile-runner:${RUNNER}`, delivery: {outcome: 'delivered'}}});
      // The stop closes the session's requests.
      expect(w.events.indexOf('rr-sync:session_ended')).toBeGreaterThan(w.events.indexOf('rr-delivery:delivered'));
    });

    it('after a restart, records a received answer delivered and an unconfirmed one failed, closing the session first', async () => {
      const question = {questions: [{question: 'Which branch?'}], summary: 'Which branch?', answers: {branch: 'main'}};
      await writeJournal({root, owner: null}, JOURNAL, {version: 1, state: 'stopping', runId: 'abc123abc123', dispatchId: DISPATCH,
        workItemId: WORK_ITEM, runtimeId: `machine:${ENROLLMENT}:${DISPATCH}`, attemptId: ATTEMPT, networkId: 'net-1',
        workspace: {repositoryId: PLAN.repositoryId, branch: PLAN.branch, baseSha: PLAN.baseSha},
        containers: {sidecar: 'c-relay', agent: 'c-agent'}, callSeq: 0, stop: {reason: 'workload_exited', exitCode: 0},
        evidenceOwed: true, evidence: {path: '/gone', sha256: 'a'.repeat(64), bytes: 1, acknowledged: true, manifestDigest: MANIFEST},
        questions: [{...question, questionId: 'q-1', state: 'received', requestId: 'req-1', answerId: 'req-1:x'},
          {...question, questionId: 'q-2', state: 'offered', requestId: 'req-2', answerId: 'req-2:x'}],
      } satisfies AttemptJournal);
      const w = world();
      expect(await superviseOnce(deps(w))).toEqual({kind: 'recovered', settled: true});
      expect(w.posts.filter((post) => post.path.endsWith('/delivery')).map((post) => [post.path.split('/').at(-2), post.key,
        post.body.delivery])).toEqual([
        ['req-1', 'req-1:delivered', {outcome: 'delivered'}],
        ['req-2', 'req-2:not_received', {outcome: 'failed', error: 'not_received'}],
      ]);
      expect(w.events.indexOf('rr-sync:session_ended')).toBeLessThan(w.events.indexOf('review'));
    });

    it('still closes the session at shutdown, within a short budget', async () => {
      const w = world({agentExit: 'never'});
      const shutdown = new AbortController();
      const running = background(superviseOnce(deps(w, {shutdown: shutdown.signal})), () => shutdown.abort());
      await until(() => w.events.includes('go'));
      w.sidecarIo.stdout?.write(`${JSON.stringify({id: 1, method: 'POST', path: '/sift/v1/questions',
        body: Buffer.from(JSON.stringify({questionId: 'q-1', questions: [{id: 'branch', header: 'Branch', question: 'Which branch?', options: []}]})).toString('base64')})}\n`);
      await until(() => w.events.includes('rr-sync:opened'));
      shutdown.abort();
      const stoppedAt = performance.now();
      expect(await running).toMatchObject({kind: 'finished', reason: 'shutdown'});
      expect(w.events).toContain('rr-sync:session_ended');
      expect(performance.now() - stoppedAt).toBeLessThan(10_000);
    });

    it('interrupts a question call that never answers when the service shuts down', async () => {
      const w = world({agentExit: 'never', openHangs: true});
      const shutdown = new AbortController();
      const running = background(superviseOnce(deps(w, {shutdown: shutdown.signal})), () => shutdown.abort());
      await until(() => w.events.includes('go'));
      w.sidecarIo.stdout?.write(`${JSON.stringify({id: 1, method: 'POST', path: '/sift/v1/questions',
        body: Buffer.from(JSON.stringify({questionId: 'q-1', questions: [{id: 'branch', header: 'Branch', question: 'Which branch?', options: []}]})).toString('base64')})}\n`);
      await until(() => w.events.includes('rr-sync:opened'));
      const stoppedAt = performance.now();
      shutdown.abort();
      expect(await running).toMatchObject({kind: 'finished', reason: 'shutdown', facts: {cgroupEmpty: 'empty'}});
      expect(performance.now() - stoppedAt).toBeLessThan(5_000);
    });

    it('keeps the attempt unsettled while a received answer is unrecorded, and finishes it on the next start', async () => {
      const question = {questions: [{question: 'Which branch?'}], summary: 'Which branch?', answers: {branch: 'main'}};
      await writeJournal({root, owner: null}, JOURNAL, {version: 1, state: 'stopping', runId: 'abc123abc123', dispatchId: DISPATCH,
        workItemId: WORK_ITEM, runtimeId: `machine:${ENROLLMENT}:${DISPATCH}`, attemptId: ATTEMPT, networkId: 'net-1',
        workspace: {repositoryId: PLAN.repositoryId, branch: PLAN.branch, baseSha: PLAN.baseSha},
        containers: {sidecar: 'c-relay', agent: 'c-agent'}, callSeq: 0, stop: {reason: 'workload_exited', exitCode: 0},
        evidenceOwed: true, evidence: {path: '/gone', sha256: 'a'.repeat(64), bytes: 1, acknowledged: true, manifestDigest: MANIFEST},
        questions: [{...question, questionId: 'q-1', state: 'received', requestId: 'req-1', answerId: 'req-1:x'}],
      } satisfies AttemptJournal);
      const failing = world({deliveryStatus: 503});
      expect(await superviseOnce(deps(failing))).toEqual({kind: 'recovered', settled: false});
      expect(failing.events).not.toContain('rr-sync:session_ended');
      expect(failing.events).not.toContain('review');
      expect((await journal())?.questions?.[0]).toMatchObject({state: 'received'});
      const healthy = world();
      expect(await superviseOnce(deps(healthy))).toEqual({kind: 'recovered', settled: true});
      const order = (event: string) => healthy.events.indexOf(event);
      expect(order('rr-delivery:delivered')).toBeLessThan(order('rr-sync:session_ended'));
      expect(order('rr-sync:session_ended')).toBeLessThan(order('review'));
    });
  });

  describe('checkout (U5b-2c)', () => {
    const CHECKOUT_PLAN = {...PLAN, repositoryUrl: 'https://github.com/acme/widgets', writeScope: ['src']};
    /** A world with a checkout plan, its attempt filesystem host, and the deps that run it. */
    async function checkoutWorld(extra: Partial<NonNullable<Scenario['checkout']>> = {}, scenario: Scenario = {},
      hostOptions: Parameters<typeof attemptFsHost>[0] = {}, overrides: Partial<SuperviseDeps> = {}) {
      const attemptRoot = await fs.mkdtemp(path.join(path.dirname(root), 'attempts-'));
      const host = attemptFsHost(hostOptions);
      const w = world({...scenario, checkout: {root: attemptRoot, ...extra}});
      const run = () => superviseOnce(deps(w, {resolvePlan: async () => CHECKOUT_PLAN, attemptFs: {system: host.system, root: attemptRoot},
        assets: {sidecar: '/opt/sift/relaySidecar.js', launcher: '/opt/sift/attemptLauncher.js', checkoutHelper: '/opt/sift/checkoutHelper.js'},
        ...overrides}));
      return {w, host, run};
    }
    const mounts = (w: ReturnType<typeof world>, id: string) =>
      (w.containers.get(id) ?? []).flatMap((arg, i, all) => (arg === '--mount' ? [all[i + 1]] : []));

    it('checks out before the writer, gives it the repository read-only except the write scope, and ships the patch with the log', async () => {
      const {w, host, run} = await checkoutWorld();
      const outcome = await run();
      expect(outcome).toMatchObject({kind: 'finished', reason: 'workload_exited', exitCode: 0, settled: true});
      const order = (event: string) => w.events.indexOf(event);
      // Checkout on its own bridge, removed before the writer's network exists.
      expect(order('volume-create:fs')).toBeLessThan(order('fetch-network-create'));
      expect(order('start:c-checkout')).toBeLessThan(order('network-rm'));
      expect(order('network-rm')).toBeLessThan(order('network-create'));
      // The writer: the checkout read-only, the write scope writable over it, and no scratch /workspace.
      const agentMounts = mounts(w, 'c-agent').filter((m) => m.startsWith('type=volume'));
      expect(agentMounts.map((m) => m.replace(/sift-a-[0-9a-f]+-fs/, 'FS'))).toEqual([
        'type=volume,source=FS,target=/workspace,volume-subpath=work,readonly', 'type=volume,source=FS,target=/workspace/src,volume-subpath=work/src']);
      expect(w.containers.get('c-agent')!.filter((arg) => arg.startsWith('/workspace:'))).toEqual([]);
      expect(w.containers.get('c-agent')).toEqual(expect.arrayContaining(['--workdir', '/workspace']));
      // The patch: no network, the checkout read-only, after the writer was killed, declared beside the log.
      expect(w.containers.get('c-patch')).toEqual(expect.arrayContaining(['--network', 'none']));
      expect(order('kill:c-agent')).toBeLessThan(order('start:c-patch'));
      expect((w.evidence.declared[0] as Array<{kind: string}>).map((a) => a.kind)).toEqual(['agent_log', 'patch']);
      expect(w.evidence.puts.map((put) => put.headers['Content-Type']).sort()).toEqual(['text/plain', 'text/x-diff']);
      // Acknowledged: the volumes and then the filesystem go, and the receipts say nothing was kept.
      expect(order('evidence-ack')).toBeLessThan(order('volume-rm'));
      expect(host.calls.some((c) => c.startsWith('umount'))).toBe(true);
      expect(host.calls.some((c) => c.startsWith('unlink'))).toBe(true);
      expect(w.receipts.map((r) => r.recoveryVolumeRetained)).toEqual([false, false]);
    });

    it('never hands the writer a volume that changed after the checkout', async () => {
      const {w, run} = await checkoutWorld({volumeMovesAfter: 1});
      expect(await run()).toMatchObject({kind: 'finished', reason: 'start_failed'});
      expect(w.events).toContain('start:c-checkout');
      expect(w.events).not.toContain('create:c-agent');
    });

    it('holds the filesystem while the volume create never answered, so nothing is released under a late volume', async () => {
      const {host, run} = await checkoutWorld({volumeCreateLost: true});
      expect(await run()).toMatchObject({kind: 'finished', reason: 'start_failed', settled: false,
        facts: {resourcesRemoved: false, held: expect.arrayContaining(['create:volume'])}});
      expect(host.calls.some((c) => c.startsWith('unlink') || c.startsWith('umount') || c.startsWith('losetup --detach'))).toBe(false);
      expect(await journal()).toMatchObject({state: 'held', pendingCreates: ['volume']});
    });

    it('keeps the attempt filesystem and says so when the evidence was not acknowledged', async () => {
      const {w, host, run} = await checkoutWorld({}, {putStatus: 503});
      const outcome = await run();
      expect(outcome).toMatchObject({kind: 'finished', reason: 'workload_exited', settled: true});
      expect(w.events).toContain('fail');
      expect(w.events).not.toContain('volume-rm');
      expect(host.calls.some((c) => c.startsWith('umount') || c.startsWith('unlink'))).toBe(false);
      expect(w.receipts.map((r) => [r.state, r.recoveryVolumeRetained])).toEqual([['execution_stopped', true], ['cleaned', true]]);
    });

    it('refuses the start when the checkout is refused: no writer exists, and nothing is kept', async () => {
      const {w, host, run} = await checkoutWorld({result: {ok: false, code: 'scope_invalid', detail: 'src is a symlink'}});
      const outcome = await run();
      expect(outcome).toMatchObject({kind: 'finished', reason: 'start_failed'});
      expect(w.events).not.toContain('create:c-agent');
      expect(w.events).not.toContain('go');
      expect(w.events).toContain('ack:failed');
      expect(host.calls.some((c) => c.startsWith('unlink'))).toBe(true);
      expect(w.receipts.every((r) => r.recoveryVolumeRetained === false)).toBe(true);
    });

    it('fails the evidence when the patch cannot be built, and keeps the filesystem for the operator', async () => {
      const {w, host, run} = await checkoutWorld({patchResult: {ok: false, code: 'patch_too_large', detail: 'over the cap'}});
      await run();
      expect(w.events).not.toContain('evidence-declare');
      expect(w.events).toContain('fail');
      expect(host.calls.some((c) => c.startsWith('unlink'))).toBe(false);
      expect(w.receipts.some((r) => r.recoveryVolumeRetained === true)).toBe(true);
    });

    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    /** What the queued receipts say about the attempt filesystem: recovery queues them after the evidence decision, to send next cycle. */
    const queuedRetention = async () => ((await readJournal<{entries: Array<{facts: {recoveryVolumeRetained: boolean}}>}>({root, owner: null}, OUTBOX))
      ?.entries ?? []).map((entry) => entry.facts.recoveryVolumeRetained);
    /** A journal left by a crash after the writer stopped: its log frozen, its patch frozen or not, its filesystem still there. */
    async function crashedWithCheckout(patchFrozen: boolean, volumeRmFails = false) {
      const attemptRoot = await fs.mkdtemp(path.join(path.dirname(root), 'attempts-'));
      const host = attemptFsHost();
      const dir = path.join(inputRoot, ATTEMPT);
      await fs.mkdir(dir, {recursive: true});
      const logPath = path.join(dir, 'agent.log');
      await fs.writeFile(logPath, WORKLOAD_OUTPUT);
      const patchText = '# sift patch v1\n+change\n';
      const patchPath = path.join(dir, 'sift.patch');
      if (patchFrozen) await fs.writeFile(patchPath, patchText);
      await writeJournal({root, owner: null}, JOURNAL, {version: 1, state: 'stopping', runId: 'abc123abc123', dispatchId: DISPATCH,
        workItemId: WORK_ITEM, runtimeId: `machine:${ENROLLMENT}:${DISPATCH}`, attemptId: ATTEMPT, networkId: 'net-1',
        workspace: {repositoryId: PLAN.repositoryId, branch: PLAN.branch, baseSha: PLAN.baseSha},
        containers: {sidecar: 'c-relay', agent: 'c-agent'}, callSeq: 0, stop: {reason: 'workload_exited', exitCode: 0}, evidenceOwed: true,
        evidence: {path: logPath, sha256: sha(WORKLOAD_OUTPUT), bytes: WORKLOAD_OUTPUT.length},
        fs: {image: path.join(attemptRoot, 'abc123abc123.img'), mountPoint: path.join(attemptRoot, 'abc123abc123'), imageDev: 1, imageIno: 2,
          loop: '/dev/loop0', uuid: 'uuid-1', inodes: 400_000, state: 'mounted'},
        ...(patchFrozen ? {patch: {kind: 'patch', contentType: 'text/x-diff', path: patchPath, sha256: sha(patchText), bytes: patchText.length}} : {}),
      } satisfies AttemptJournal);
      const w = world({checkout: {root: attemptRoot, volumeRmFails, seedVolumes: ['sift-a-abc123abc123-fs']}});
      const run = () => superviseOnce(deps(w, {attemptFs: {system: host.system, root: attemptRoot}}));
      return {w, host, run};
    }

    it('after a crash, uploads the frozen log and patch under the recovered claim, then releases the filesystem', async () => {
      const {w, host, run} = await crashedWithCheckout(true);
      expect(await run()).toEqual({kind: 'recovered', settled: true});
      expect((w.evidence.declared[0] as Array<{kind: string}>).map((a) => a.kind)).toEqual(['agent_log', 'patch']);
      expect(w.events).toContain('review');
      expect(host.calls.some((c) => c.startsWith('unlink'))).toBe(true);
      expect(await queuedRetention()).toEqual([false, false]);
    });

    it('after a crash, holds a workspace whose release fails, with cleanup_failed receipts', async () => {
      const {w, host, run} = await crashedWithCheckout(true, true);
      expect(await run()).toEqual({kind: 'held', held: ['volume:sift-a-abc123abc123-fs']});
      expect(w.events).toContain('evidence-ack');
      expect(host.calls.some((c) => c.startsWith('unlink'))).toBe(false);
      expect(await journal()).toMatchObject({state: 'held'});
      const outbox = await readJournal<{entries: Array<{facts: {state: string}}>}>({root, owner: null}, OUTBOX);
      expect(outbox?.entries.map((entry) => entry.facts.state)).toEqual(['execution_stopped', 'cleanup_failed']);
    });

    it('re-derives a failed release after a restart without dropping or reusing receipts an earlier stop owed', async () => {
      const attemptRoot = await fs.mkdtemp(path.join(path.dirname(root), 'attempts-'));
      const host = attemptFsHost();
      const receipt = (state: string, n: number) => ({attemptId: ATTEMPT, workItemId: WORK_ITEM, dispatchId: DISPATCH, orgId: null, state,
        reason: state === 'cleanup_failed' ? 'volume:older' : null, containersRemoved: 0, recoveryVolumeRetained: true, operationKey: `${ATTEMPT}:${state}:${n}`});
      // Settling after an acknowledged upload, owing two receipts from earlier stops, one of them an older cleanup failure.
      await writeJournal({root, owner: null}, JOURNAL, {version: 1, state: 'settling', runId: 'abc123abc123', dispatchId: DISPATCH,
        workItemId: WORK_ITEM, runtimeId: `machine:${ENROLLMENT}:${DISPATCH}`, attemptId: ATTEMPT, networkId: 'net-1',
        workspace: {repositoryId: PLAN.repositoryId, branch: PLAN.branch, baseSha: PLAN.baseSha},
        containers: {}, callSeq: 0, stop: {reason: 'workload_exited', exitCode: 0, facts: {processesStopped: true, cgroupEmpty: 'empty',
          resourcesRemoved: true, held: []}}, evidenceOwed: true,
        fs: {image: path.join(attemptRoot, 'abc123abc123.img'), mountPoint: path.join(attemptRoot, 'abc123abc123'), imageDev: 1, imageIno: 2,
          loop: '/dev/loop0', uuid: 'uuid-1', inodes: 400_000, state: 'mounted'},
        settlement: {reason: 'workload_exited', exitCode: 0, started: true, cgroupEmpty: true, attemptReport: 'pending', work: 'pending',
          evidence: {acknowledged: true, manifestDigest: MANIFEST}},
        receipts: [receipt('execution_stopped', 1), receipt('cleanup_failed', 1)], receiptsCarried: 2, receiptsQueued: false,
      } as AttemptJournal);
      const w = world({checkout: {root: attemptRoot, volumeRmFails: true, seedVolumes: ['sift-a-abc123abc123-fs']}});
      expect(await superviseOnce(deps(w, {attemptFs: {system: host.system, root: attemptRoot}}))).toEqual({kind: 'held', held: ['volume:sift-a-abc123abc123-fs']});
      const outbox = await readJournal<{entries: Array<{facts: {operationKey: string; reason: string | null}}>}>({root, owner: null}, OUTBOX);
      expect(outbox?.entries.map((entry) => entry.facts.operationKey.split(':').slice(1).join(':'))).toEqual(
        ['execution_stopped:1', 'cleanup_failed:1', 'cleanup_failed:2']);
      expect(outbox?.entries[2].facts.reason).toContain('volume:sift-a-abc123abc123-fs');
    });

    it('after a crash before the patch was frozen, fails the evidence and keeps the filesystem', async () => {
      const {w, host, run} = await crashedWithCheckout(false);
      expect(await run()).toEqual({kind: 'recovered', settled: true});
      expect(w.events).not.toContain('evidence-declare');
      expect(w.events).toContain('fail');
      expect(host.calls.some((c) => c.startsWith('unlink'))).toBe(false);
      expect(await queuedRetention()).toEqual([true, true]);
    });

    it('stops preparing at shutdown: nothing is made or journaled after teardown, and the partial filesystem is released', async () => {
      let resume: () => void = () => {};
      const stall = new Promise<void>((resolve) => { resume = resolve; });
      const shutdown = new AbortController();
      const {w, host, run} = await checkoutWorld({}, {}, {stallFallocate: stall}, {shutdown: shutdown.signal});
      const outcome = run();
      await until(() => host.calls.some((c) => c.startsWith('fallocate')));
      shutdown.abort();
      // The allocation answers only after the shutdown was seen; the next step must not start.
      setTimeout(resume, 50);
      expect(await outcome).toMatchObject({kind: 'finished', reason: 'shutdown'});
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(host.calls.some((c) => c.startsWith('mkfs'))).toBe(false);
      expect(w.events.some((e) => e.startsWith('volume-create') || e === 'fetch-network-create')).toBe(false);
      expect(host.calls.some((c) => c.startsWith('unlink'))).toBe(true);
      expect(await journal()).toBeNull();
    });

    it('holds the workspace while its preparation has not stopped, across cycles, then releases it once it has', async () => {
      let resume: () => void = () => {};
      const stall = new Promise<void>((resolve) => { resume = resolve; });
      const shutdown = new AbortController();
      const timing = {controlPollMs: 20, readyTimeoutMs: 1_000, logDrainMs: 200, prepareDrainMs: 100};
      const {host, run} = await checkoutWorld({}, {}, {stallFallocate: stall}, {shutdown: shutdown.signal, timing});
      const outcome = run();
      await until(() => host.calls.some((c) => c.startsWith('fallocate')));
      shutdown.abort();
      expect(await outcome).toMatchObject({kind: 'finished', reason: 'shutdown', settled: false,
        facts: {resourcesRemoved: false, held: expect.arrayContaining(['workspace:preparing'])}});
      expect(await journal()).toMatchObject({state: 'held', preparing: true});
      // The next cycle, with the allocation still running here: nothing is torn down under it.
      const next = world();
      expect(await superviseOnce(deps(next, {attemptFs: {system: host.system, root: path.dirname(root)}, timing})))
        .toEqual({kind: 'held', held: ['workspace:preparing']});
      expect(next.events).toEqual([]);
      expect(host.calls.some((c) => c.startsWith('unlink'))).toBe(false);
      // Once the allocation answers, preparation stops at its next step; the following cycle releases the partial filesystem.
      resume();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const last = world();
      const recovered = await superviseOnce(deps(last, {attemptFs: {system: host.system, root: path.dirname(root)}, timing}));
      expect(recovered).toMatchObject({kind: 'recovered'});
      expect(host.calls.some((c) => c.startsWith('mkfs'))).toBe(false);
      expect(host.calls.some((c) => c.startsWith('unlink'))).toBe(true);
    });

    it('holds a workspace whose release fails after acknowledgement, and never reports it cleaned', async () => {
      const {w, run} = await checkoutWorld({volumeRmFails: true});
      const outcome = await run();
      expect(w.events).toContain('evidence-ack');
      expect(outcome).toMatchObject({kind: 'finished', settled: false, facts: {resourcesRemoved: false,
        held: expect.arrayContaining([expect.stringMatching(/^volume:sift-a-[0-9a-f]+-fs$/)])}});
      expect(await journal()).toMatchObject({state: 'held'});
      const outbox = await readJournal<{entries: Array<{facts: {state: string}}>}>({root, owner: null}, OUTBOX);
      expect(outbox?.entries.map((entry) => entry.facts.state)).toEqual(['execution_stopped', 'cleanup_failed']);
    });

    it('holds a patch create whose answer was lost, so the next start looks for it by name', async () => {
      const {run} = await checkoutWorld({patchCreateLost: true});
      const outcome = await run();
      expect(outcome).toMatchObject({kind: 'finished', settled: false, facts: {resourcesRemoved: false, held: expect.arrayContaining(['create:patch'])}});
      expect(await journal()).toMatchObject({state: 'held', pendingCreates: ['patch']});
      const outbox = await readJournal<{entries: Array<{facts: {state: string}}>}>({root, owner: null}, OUTBOX);
      expect(outbox?.entries.map((entry) => entry.facts.state)).toEqual(['execution_stopped', 'cleanup_failed']);
    });

    it('holds a patch helper whose removal cannot be shown, and reports the cleanup failed', async () => {
      const {w, run} = await checkoutWorld({patchRmFails: true});
      const outcome = await run();
      expect(outcome).toMatchObject({kind: 'finished', settled: false, facts: {resourcesRemoved: false, held: expect.arrayContaining(['container:c-patch'])}});
      expect(await journal()).not.toBeNull();
      const outbox = await readJournal<{entries: Array<{facts: {state: string}}>}>({root, owner: null}, OUTBOX);
      expect(outbox?.entries.map((entry) => entry.facts.state)).toEqual(['execution_stopped', 'cleanup_failed']);
      expect(w.events).not.toContain('review');
    });

    describe('with dependencies', () => {
      const LOCK = JSON.stringify({name: 'w', lockfileVersion: 3, packages: {'': {name: 'w', dependencies: {'left-pad': '^1.3.0'}},
        'node_modules/left-pad': {version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
          integrity: `sha512-${'A'.repeat(86)}==`}}});
      const files = {'package.json': '{"name":"w","dependencies":{"left-pad":"^1.3.0"}}', 'package-lock.json': LOCK};
      const ASSETS = {sidecar: '/opt/sift/relaySidecar.js', launcher: '/opt/sift/attemptLauncher.js', checkoutHelper: '/opt/sift/checkoutHelper.js',
        registryProxy: '/opt/sift/registryProxy.js'};

      it('installs before the writer, mounts node_modules read-only, and heads the log with the install output', async () => {
        const {w, run} = await checkoutWorld({files}, {}, {}, {resolvePlan: async () => ({...CHECKOUT_PLAN, install: {manager: 'npm'}}),
          assets: ASSETS});
        expect(await run()).toMatchObject({kind: 'finished', reason: 'workload_exited', exitCode: 0, settled: true});
        const order = (event: string) => w.events.indexOf(event);
        expect(order('start:c-checkout')).toBeLessThan(order('start:c-install'));
        expect(order('start:c-install')).toBeLessThan(order('network-create'));
        expect(mounts(w, 'c-agent').map((m) => m.replace(/sift-a-[0-9a-f]+-/g, ''))).toContain(
          'type=volume,source=fs,target=/workspace/node_modules,volume-subpath=deps/node_modules,readonly');
        const log = w.evidence.puts.find((put) => put.headers['Content-Type'] === 'text/plain')!.body;
        expect(log.startsWith('[sift: dependency install]\nadded 1 package in 1s\n\n[sift: workload]\n')).toBe(true);
      });

      it('keeps a failed install\'s output beside the attempt before its filesystem is released', async () => {
        const {w, host, run} = await checkoutWorld({files, installResult: {ok: false, code: 'dependency_install_failed', detail: 'npm ci exited 1'}},
          {}, {}, {resolvePlan: async () => ({...CHECKOUT_PLAN, install: {manager: 'npm'}}), assets: ASSETS});
        expect(await run()).toMatchObject({kind: 'finished', reason: 'start_failed'});
        expect(w.events).not.toContain('create:c-agent');
        expect(await fs.readFile(path.join(inputRoot, ATTEMPT, 'install.log'), 'utf8')).toContain('npm error 404');
        expect(host.calls.some((c) => c.startsWith('unlink'))).toBe(true);
      });

      it('keeps the output of an install that timed out, like any other failed install', async () => {
        const {host, run} = await checkoutWorld({files, installResult: {ok: false, code: 'install_timeout', detail: 'ran past 300000 ms'}},
          {}, {}, {resolvePlan: async () => ({...CHECKOUT_PLAN, install: {manager: 'npm'}}), assets: ASSETS});
        expect(await run()).toMatchObject({kind: 'finished', reason: 'start_failed'});
        expect(await fs.readFile(path.join(inputRoot, ATTEMPT, 'install.log'), 'utf8')).toContain('npm error');
        expect(host.calls.some((c) => c.startsWith('unlink'))).toBe(true);
      });

      it('owes nothing when admission refuses the lockfile before any install ran', async () => {
        const git = JSON.stringify({lockfileVersion: 3, packages: {'': {}, 'node_modules/x': {version: '1.0.0', resolved: 'git+ssh://git@github.com/a/x.git'}}});
        const {w, host, run} = await checkoutWorld({files: {'package.json': '{}', 'package-lock.json': git}}, {}, {},
          {resolvePlan: async () => ({...CHECKOUT_PLAN, install: {manager: 'npm'}}), assets: ASSETS});
        expect(await run()).toMatchObject({kind: 'finished', reason: 'start_failed'});
        expect(w.events).not.toContain('start:c-install');
        expect(host.calls.some((c) => c.startsWith('unlink'))).toBe(true);
        await expect(fs.access(path.join(inputRoot, ATTEMPT))).rejects.toThrow();
      });

      it('keeps the filesystem holding a failed install\'s output when that output cannot be saved', async () => {
        // The output's destination is taken by a directory, so saving it fails.
        await fs.mkdir(path.join(inputRoot, ATTEMPT, 'install.log'), {recursive: true});
        const {host, run} = await checkoutWorld({files, installResult: {ok: false, code: 'dependency_install_failed', detail: 'npm ci exited 1'}},
          {}, {}, {resolvePlan: async () => ({...CHECKOUT_PLAN, install: {manager: 'npm'}}), assets: ASSETS});
        expect(await run()).toMatchObject({kind: 'finished', reason: 'start_failed'});
        expect(host.calls.some((c) => c.startsWith('unlink'))).toBe(false);
        const outbox = await readJournal<{entries: Array<{facts: {recoveryVolumeRetained: boolean}}>}>({root, owner: null}, OUTBOX);
        expect(outbox?.entries.every((entry) => entry.facts.recoveryVolumeRetained)).toBe(true);
      });

      /** A journal a crash left between a failed install and the copy of its output: nothing ran, the output is owed. */
      async function crashedOwingInstallOutput(logOnDisk: boolean) {
        const attemptRoot = await fs.mkdtemp(path.join(path.dirname(root), 'attempts-'));
        const mountPoint = path.join(attemptRoot, 'abc123abc123');
        if (logOnDisk) {
          await fs.mkdir(path.join(mountPoint, 'deps'), {recursive: true});
          await fs.writeFile(path.join(mountPoint, 'deps', 'install.log'), 'npm error 404 Not Found\n');
        }
        await writeJournal({root, owner: null}, JOURNAL, {version: 1, state: 'stopping', runId: 'abc123abc123', dispatchId: DISPATCH,
          workItemId: WORK_ITEM, runtimeId: `machine:${ENROLLMENT}:${DISPATCH}`, attemptId: ATTEMPT, networkId: 'net-1',
          workspace: {repositoryId: PLAN.repositoryId, branch: PLAN.branch, baseSha: PLAN.baseSha},
          containers: {}, callSeq: 0, stop: {reason: 'start_failed'}, installOutput: 'owed',
          fs: {image: path.join(attemptRoot, 'abc123abc123.img'), mountPoint, imageDev: 1, imageIno: 2, loop: '/dev/loop0', uuid: 'uuid-1',
            inodes: 400_000, state: 'mounted'},
        } as AttemptJournal);
        const host = attemptFsHost();
        const w = world({checkout: {root: attemptRoot, seedVolumes: ['sift-a-abc123abc123-fs']}});
        return {w, host, run: () => superviseOnce(deps(w, {attemptFs: {system: host.system, root: attemptRoot}}))};
      }

      it('after a crash before a failed install\'s output was copied, copies it from the filesystem before releasing it', async () => {
        const {host, run} = await crashedOwingInstallOutput(true);
        expect(await run()).toMatchObject({kind: 'recovered'});
        expect(await fs.readFile(path.join(inputRoot, ATTEMPT, 'install.log'), 'utf8')).toBe('npm error 404 Not Found\n');
        expect(host.calls.some((c) => c.startsWith('unlink'))).toBe(true);
      });

      it('after a crash, keeps the filesystem while a failed install\'s output still cannot be copied', async () => {
        const {host, run} = await crashedOwingInstallOutput(false);
        expect(await run()).toMatchObject({kind: 'recovered'});
        await expect(fs.access(path.join(inputRoot, ATTEMPT, 'install.log'))).rejects.toThrow();
        expect(host.calls.some((c) => c.startsWith('unlink'))).toBe(false);
      });

      it('refuses an install plan it cannot run, before anything is attached', async () => {
        for (const plan of [{...PLAN, install: {manager: 'npm'}}, {...CHECKOUT_PLAN, install: {manager: 'yarn'}},
          {...CHECKOUT_PLAN, writeScope: ['node_modules/left-pad'], install: {manager: 'npm'}}]) {
          const {w, host} = await checkoutWorld();
          const outcome = await superviseOnce(deps(w, {resolvePlan: async () => plan as typeof CHECKOUT_PLAN,
            attemptFs: {system: host.system, root: path.dirname(root)}, assets: ASSETS}));
          expect(outcome).toMatchObject({kind: 'refused', reason: 'plan_invalid'});
          expect(w.events).not.toContain('attempt:starting');
        }
      });
    });

    it('refuses a checkout plan it cannot run, before anything is attached', async () => {
      for (const bad of [{writeScope: ['../etc']}, {repositoryUrl: 'http://github.com/acme/widgets'}, {writeScope: ['src', 'src/lib']}]) {
        const {w, host} = await checkoutWorld();
        const outcome = await superviseOnce(deps(w, {resolvePlan: async () => ({...CHECKOUT_PLAN, ...bad}),
          attemptFs: {system: host.system, root: path.dirname(root)},
          assets: {sidecar: '/opt/sift/relaySidecar.js', launcher: '/opt/sift/attemptLauncher.js', checkoutHelper: '/opt/sift/checkoutHelper.js'}}));
        expect(outcome).toMatchObject({kind: 'refused', reason: 'plan_invalid'});
        expect(w.events).not.toContain('attempt:starting');
        expect(host.calls).toEqual([]);
      }
    });
  });
});

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
  claimExpiresAt?: string;
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
}

/** The API, Docker and attached processes one attempt touches, recording what happened in order. */
function world(scenario: Scenario = {}) {
  const events: string[] = [];
  const modelKeys: Array<string | undefined> = [];
  const sidecarIo: {stdin?: PassThrough; stdout?: PassThrough} = {};
  const agentInput: {value?: Record<string, unknown>} = {};
  const posts: Array<{path: string; body: Record<string, unknown>; key?: string}> = [];
  const evidence = {puts: [] as Array<{url: string; headers: Record<string, string>; body: string}>, acknowledged: false, declared: [] as unknown[]};
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
        workItem: {id: WORK_ITEM, claimToken: 'claim-secret', claimExpiresAt: scenario.claimExpiresAt ?? inFuture(600_000), title: 't', prompt: 'p'},
        controls: []});
    }
    if (route.endsWith('/cleanup-receipts')) {
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
      const [artifact] = body.artifacts as Array<{sha256: string}>;
      return reply(200, {manifestDigest: MANIFEST, acknowledgedAt: evidence.acknowledged ? '2026-10-29T00:00:00.000Z' : null,
        uploads: evidence.acknowledged ? [] : [{sha256: artifact.sha256, url: `${STORAGE}attempts/${ATTEMPT}/${artifact.sha256}`}]});
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
  const flag = (args: string[], name: string) => args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : []));
  const docker: DeadlineDocker = async (args) => {
    const ok = (stdout = '') => ({code: 0, stdout, stderr: ''});
    const [a, b] = args;
    if (a === 'info') return ok(JSON.stringify({CgroupDriver: 'systemd', CgroupVersion: '2', ServerVersion: '28.5.1'}));
    if (a === 'image' && b === 'inspect') return ok(JSON.stringify([{Id: IMAGE_ID, RepoDigests: [IMAGE]}]));
    if (a === 'network' && b === 'create') { events.push('network-create'); return ok('net-1\n'); }
    if (a === 'network' && b === 'inspect') {
      return ok(JSON.stringify([{Id: 'net-1', Driver: 'bridge', Internal: true, EnableIPv6: false, Options: {'com.docker.network.bridge.gateway_mode_ipv4': 'isolated'}, IPAM: {Config: [{Subnet: '172.18.0.0/16'}]}, Scope: 'local', Attachable: false, Ingress: false,
        Labels: {'sift.machine.run': flag(containers.get('c-relay') ?? [], '--label').find((l) => l.startsWith('sift.machine.run='))?.split('=')[1],
          'sift.machine.attempt': ATTEMPT},
        Containers: Object.fromEntries([...started].map((id) => [id, {}]))}]));
    }
    if (a === 'container' && b === 'create') {
      const id = flag(args, '--name')[0].endsWith('-relay') ? 'c-relay' : 'c-agent';
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
            NanoCpus: Number(flag(created, '--cpus')[0]) * 1e9, PidsLimit: Number(flag(created, '--pids-limit')[0])},
          Mounts: flag(created, '--mount').map((m) => {
            const parts = Object.fromEntries(m.split(',').map((p) => p.split('=') as [string, string]));
            return {Type: 'bind', Source: parts.source, Destination: parts.target, RW: false};
          }),
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
    if (a === 'container' && b === 'rm') { events.push(`rm:${args.at(-1)}`); return ok(); }
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
  return {events, posts, fetchImpl, docker, attach, readFile, modelKeys, sidecarIo, agentInput, evidence};
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
    async function crashedAfterFreeze(evidence: Partial<{acknowledged: boolean; manifestDigest: string}>, logText: string | null = WORKLOAD_OUTPUT) {
      const dir = path.join(inputRoot, ATTEMPT);
      await fs.mkdir(dir, {recursive: true});
      const logPath = path.join(dir, 'agent.log');
      if (logText !== null) await fs.writeFile(logPath, logText);
      await writeJournal({root, owner: null}, JOURNAL, {version: 1, state: 'stopping', runId: 'abc123abc123', dispatchId: DISPATCH,
        workItemId: WORK_ITEM, runtimeId: `machine:${ENROLLMENT}:${DISPATCH}`, attemptId: ATTEMPT, networkId: 'net-1',
        workspace: {repositoryId: PLAN.repositoryId, branch: PLAN.branch, baseSha: PLAN.baseSha},
        containers: {sidecar: 'c-relay', agent: 'c-agent'}, callSeq: 0, stop: {reason: 'workload_exited', exitCode: 0},
        evidence: {path: logPath, sha256: sha(WORKLOAD_OUTPUT), bytes: WORKLOAD_OUTPUT.length, ...evidence}} satisfies AttemptJournal);
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
  });
});

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
const CONTROL = '99999999-9999-4999-8999-999999999999';
const PLAN = {repositoryId: 'repo-1', branch: 'main', baseSha: 'c'.repeat(40), imageRef: IMAGE, command: ['sh', '-c', 'true']};
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();

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
}

/** The API, Docker and attached processes one attempt touches, recording what happened in order. */
function world(scenario: Scenario = {}) {
  const events: string[] = [];
  const modelKeys: Array<string | undefined> = [];
  const sidecarIo: {stdin?: PassThrough; stdout?: PassThrough} = {};
  const posts: Array<{path: string; body: Record<string, unknown>; key?: string}> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const route = url.slice(API.length);
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const key = (init.headers as Record<string, string>)['Idempotency-Key'];
    const reply = (status: number, value: object) => new Response(JSON.stringify(value), {status});
    if (init.method === 'POST') posts.push({path: route, body, key});
    if (route.endsWith('/consume')) {
      events.push('consume');
      if (scenario.dispatch === null) return reply(200, {dispatch: null});
      return reply(200, {dispatch: {id: DISPATCH, workItemId: WORK_ITEM, computeGrantExpiresAt: null, ...scenario.dispatch},
        workItem: {id: WORK_ITEM, claimToken: 'claim-secret', claimExpiresAt: scenario.claimExpiresAt ?? inFuture(600_000), title: 't', prompt: 'p'},
        controls: []});
    }
    if (route.endsWith('/runners/heartbeat')) { events.push('runner-heartbeat'); return reply(scenario.runnerHeartbeat ?? 200, {}); }
    if (route.includes('/model/')) {
      modelKeys.push(key);
      return new Response('event: done\n\n', {status: 200});
    }
    if (route.endsWith('/review')) { events.push('review'); return reply(scenario.reviewStatus ?? 200, {}); }
    if (route.endsWith('/fail')) { events.push('fail'); return reply(200, {}); }
    if (route.endsWith('/execution-attempts')) {
      events.push(`attempt:${String(body.state)}${body.endReason ? `:${String(body.endReason)}` : ''}`);
      if (body.state === 'running' && scenario.runningStatus) return reply(scenario.runningStatus, {});
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
    if (a === 'info') return ok(JSON.stringify({CgroupDriver: 'systemd', CgroupVersion: '2'}));
    if (a === 'image' && b === 'inspect') return ok(JSON.stringify([{Id: IMAGE_ID, RepoDigests: [IMAGE]}]));
    if (a === 'network' && b === 'create') { events.push('network-create'); return ok('net-1\n'); }
    if (a === 'network' && b === 'inspect') {
      return ok(JSON.stringify([{Id: 'net-1', Driver: 'bridge', Internal: true, EnableIPv6: false, Scope: 'local', Attachable: false, Ingress: false,
        Labels: {'sift.machine.run': flag(containers.get('c-relay') ?? [], '--label').find((l) => l.startsWith('sift.machine.run='))?.split('=')[1],
          'sift.machine.attempt': ATTEMPT},
        Containers: Object.fromEntries([...started].map((id) => [id, {}]))}]));
    }
    if (a === 'container' && b === 'create') {
      const id = flag(args, '--name')[0].endsWith('-relay') ? 'c-relay' : 'c-agent';
      containers.set(id, args);
      events.push(`create:${id}`);
      return ok(`${id}\n`);
    }
    if (a === 'container' && b === 'inspect' && args[2] === '--format') return ok(args.at(-1) === 'c-relay' ? '101\n' : '102\n');
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
    if ((a === 'container' || a === 'network') && b === 'ls') { events.push(`ls:${a}`); return ok(''); }
    if (a === 'container' && b === 'kill') { events.push(`kill:${args.at(-1)}`); return ok(); }
    if (a === 'container' && b === 'rm') { events.push(`rm:${args.at(-1)}`); return ok(); }
    if (a === 'network' && b === 'rm') { events.push('network-rm'); return ok(); }
    throw new Error(`unexpected docker ${args.join(' ')}`);
  };

  let resolveExit: (code: number) => void = () => {};
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
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    setTimeout(() => stdout.write(`${READY_LINE}\n`), scenario.readyDelayMs ?? 0);
    stdin.on('data', (chunk: Buffer) => {
      if (!chunk.toString().includes(GO_LINE)) return;
      events.push('go');
      if (scenario.agentExit !== 'never') setTimeout(() => resolveExit(scenario.agentExit ?? 0), 20);
    });
    return {stdin, stdout, exited, kill: () => stdout.end()};
  };

  const readFile = async (file: string) => {
    if (file.startsWith('/proc/')) return `0::${attemptSliceCgroup(ATTEMPT)}/docker-${file.split('/')[2]}.scope\n`;
    if (file.endsWith('cgroup.events')) return (scenario.populated ?? (() => 'populated 0\n'))();
    throw Object.assign(new Error('missing'), {code: 'ENOENT'});
  };
  return {events, posts, fetchImpl, docker, attach, readFile, modelKeys, sidecarIo};
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
  afterEach(async () => fs.rm(path.dirname(root), {recursive: true, force: true}));

  const deps = (w: ReturnType<typeof world>, overrides: Partial<SuperviseDeps> = {}): SuperviseDeps => ({
    fetch: w.fetchImpl, docker: w.docker, attach: w.attach, clock: systemClock, readFile: w.readFile,
    state: {root, owner: null}, log: () => {}, assets: {sidecar: '/opt/sift/relaySidecar.js', launcher: '/opt/sift/attemptLauncher.js'},
    inputRoot, resolvePlan: async () => PLAN, timing: {controlPollMs: 20, readyTimeoutMs: 1_000}, ...overrides,
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
    const running = superviseOnce(deps(w, {shutdown: shutdown.signal}));
    await new Promise((resolve) => setTimeout(resolve, 300));
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
    const running = superviseOnce(deps(w));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const frame = (id: number) => `${JSON.stringify({id, method: 'POST', path: '/sift/v1/model/anthropic/v1/messages', body: Buffer.from('{}').toString('base64')})}\n`;
    w.sidecarIo.stdout?.write(frame(1) + frame(2));
    expect(await running).toMatchObject({kind: 'finished', reason: 'stop_control'});
    expect([...w.modelKeys].sort()).toEqual([`${ATTEMPT}:1`, `${ATTEMPT}:2`]);
  });

  it('tears down a run left by a crash by exact ID and never relaunches it', async () => {
    await writeJournal({root, owner: null}, JOURNAL, {version: 1, state: 'running', runId: 'abc123abc123', dispatchId: DISPATCH,
      workItemId: WORK_ITEM, runtimeId: `machine:${ENROLLMENT}:${DISPATCH}`, attemptId: ATTEMPT, networkId: 'net-1',
      workspace: {repositoryId: PLAN.repositoryId, branch: PLAN.branch, baseSha: PLAN.baseSha},
      containers: {sidecar: 'c-relay', agent: 'c-agent'}, callSeq: 3} satisfies AttemptJournal);
    const w = world();
    expect(await superviseOnce(deps(w))).toEqual({kind: 'recovered', settled: true});
    // Journaled IDs are killed before any discovery listing runs; the server is then told with the recovered claim.
    expect(w.events).toEqual(['kill:c-relay', 'kill:c-agent', 'ls:container', 'ls:network', 'rm:c-relay', 'rm:c-agent', 'network-rm',
      'runner-heartbeat', 'consume', 'attempt:ended:failed', 'fail']);
    expect(w.events).not.toContain('network-create');
    expect(await journal()).toBeNull();
  });
});

import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {AttemptFsRecord, AttemptFsSystem} from './attemptFilesystem.js';
import {judgeReview, type ReviewContext, runReview} from './attemptReview.js';
import type {HelperRole} from './attemptWorkspace.js';
import type {Attach} from './machineQualify.js';
import {MODEL_PATHS, QUESTION_PATHS} from './relaySidecar.js';

const IMAGE = `registry.example/sift-reviewer@sha256:${'a'.repeat(64)}`;
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const HEAD = 'e'.repeat(40);
const BASE = 'c'.repeat(40);
const line = (receipt: object) => JSON.stringify({version: 'sift.review-result/v1', ok: true, receipt});

describe('review verdicts (R-D5, R8)', () => {
  it('passes only a complete verdict for exactly the result head, keeping every receipt', () => {
    expect(judgeReview(HEAD, line({verdict: {kind: 'complete', reviewedSha: HEAD}}))).toMatchObject({outcome: 'passed', receipt: {verdict: {kind: 'complete'}}});
    for (const kind of ['skipped', 'incomplete', 'failed']) {
      expect(judgeReview(HEAD, line({verdict: {kind, reviewedSha: HEAD}})), kind).toMatchObject({outcome: 'review_failed', detail: `verdict ${kind}`,
        receipt: {verdict: {kind}}});
    }
    expect(judgeReview(HEAD, line({verdict: {kind: 'complete', reviewedSha: BASE}}))).toMatchObject({outcome: 'review_head_mismatch'});
    expect(judgeReview(HEAD, 'not json').outcome).toBe('review_failed');
    expect(judgeReview(HEAD, JSON.stringify({version: 'sift.review-result/v1', ok: false, code: 'review_failed', detail: 'no codex'})))
      .toMatchObject({outcome: 'review_failed', detail: 'no codex'});
    expect(judgeReview(HEAD, JSON.stringify({version: 'other/v1', ok: true, receipt: {verdict: {kind: 'complete', reviewedSha: HEAD}}})).outcome)
      .toBe('review_failed');
    expect(judgeReview(HEAD, line({})).outcome).toBe('review_failed');
  });
});

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(tmpdir(), 'sift-review-')); });
afterEach(async () => { await fs.rm(root, {recursive: true, force: true}); });

const flag = (args: string[], name: string) => args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : []));

function inspectOf(id: string, made: string[]) {
  const mounts = flag(made, '--mount').map((m) => Object.fromEntries(m.split(',').map((p) => (p.includes('=') ? p.split('=') : [p, 'true']))));
  const memory = Number(flag(made, '--memory')[0].replace('m', ''));
  return {Id: id, Image: IMAGE_ID,
    Config: {Image: IMAGE, User: flag(made, '--user')[0], Entrypoint: flag(made, '--entrypoint'),
      Labels: Object.fromEntries(flag(made, '--label').map((l) => l.split('=') as [string, string]))},
    HostConfig: {Privileged: false, CapAdd: null, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], ReadonlyRootfs: true, PidMode: '',
      IpcMode: 'private', UTSMode: '', UsernsMode: '', CgroupnsMode: 'private', CgroupParent: flag(made, '--cgroup-parent')[0],
      NetworkMode: flag(made, '--network')[0], Devices: [], VolumesFrom: null, PortBindings: {}, PublishAllPorts: false,
      Tmpfs: Object.fromEntries(flag(made, '--tmpfs').map((t) => [t.split(':')[0], t.slice(t.indexOf(':') + 1)])), RestartPolicy: {Name: 'no'},
      Memory: memory * 1024 * 1024, MemorySwap: memory * 1024 * 1024, NanoCpus: Number(flag(made, '--cpus')[0]) * 1e9,
      PidsLimit: Number(flag(made, '--pids-limit')[0]),
      Mounts: mounts.filter((m) => m.type === 'volume').map((m) => ({Type: 'volume', Source: m.source, Target: m.target,
        ...(m.readonly ? {ReadOnly: true} : {}), ...(m['volume-subpath'] ? {VolumeOptions: {Subpath: m['volume-subpath']}} : {})}))},
    Mounts: mounts.map((m) => (m.type === 'volume' ? {Type: 'volume', Name: m.source, Destination: m.target, RW: !m.readonly}
      : {Type: 'bind', Source: m.source, Destination: m.target, RW: false})),
    NetworkSettings: {Networks: {}}};
}

interface World {result?: object | 'hang'; questionToo?: boolean}

function reviewWorld(world: World = {}) {
  const events: string[] = [];
  const created = new Map<string, string[]>();
  const relayed: Array<{role: string | null; key: string | null}> = [];
  let sidecarOut: PassThrough | undefined;
  let sidecarIn: PassThrough | undefined;
  const answers = new Map<number, string>();
  const docker: ReviewContext['docker'] = async (args) => {
    const ok = (stdout = '') => ({code: 0, stdout, stderr: ''});
    events.push(`${args[0]}-${args[1]}${args[0] === 'container' && (args[1] === 'kill' || args[1] === 'rm') ? `:${args.at(-1)}` : ''}`);
    if (args[0] === 'container' && args[1] === 'inspect') return ok(JSON.stringify(args.slice(2).map((id) => inspectOf(id, created.get(id)!))));
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return ok(JSON.stringify([{Name: 'sift-a-r1-fs', Driver: 'local', Labels: {'sift.machine.run': 'r1', 'sift.machine.role': 'volume',
        'sift.machine.attempt': 'a1'}, Options: {type: 'ext4', device: '/dev/loop0', o: 'nodev,nosuid,nodiscard'}}]));
    }
    if (args[0] === 'network' && args[1] === 'inspect') {
      const made = created.get('net-review')!;
      return ok(JSON.stringify([{Id: 'net-review', Driver: 'bridge', Internal: true, EnableIPv6: false, Scope: 'local', Attachable: false, Ingress: false,
        Options: {'com.docker.network.bridge.gateway_mode_ipv4': 'isolated'}, IPAM: {Config: [{Subnet: '172.29.0.0/16'}]},
        Labels: Object.fromEntries(flag(made, '--label').map((l) => l.split('=') as [string, string])), Containers: {}}]));
    }
    return ok();
  };
  const create = async (role: HelperRole, args: string[]) => {
    events.push(`create:${role}`);
    const id = role === 'review-net' ? 'net-review' : `c-${role}`;
    created.set(id, args);
    return id;
  };
  // The sidecar's frames: the reviewer's calls arrive on its stdout; the supervisor's answers go to its stdin.
  const call = (id: number, framePath: string) => new Promise<string>((resolve) => {
    answers.delete(id);
    const onLine = () => { if (answers.has(id)) { sidecarIn?.off('data', onLine); resolve(answers.get(id) as string); } };
    sidecarIn?.on('data', onLine);
    sidecarOut?.write(`${JSON.stringify({id, method: 'POST', path: framePath, body: Buffer.from('{"model":"m"}').toString('base64')})}\n`);
  });
  const attach: Attach = (args) => {
    const id = args.at(-1)!;
    events.push(`start:${id}`);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    if (id === 'c-review-relay') {
      sidecarOut = stdout;
      sidecarIn = stdin;
      let buffer = '';
      stdin.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
          const frame = JSON.parse(buffer.slice(0, nl)) as {id: number; status?: number; end?: boolean};
          buffer = buffer.slice(nl + 1);
          if (frame.status !== undefined) answers.set(frame.id, String(frame.status));
        }
        stdin.emit('frames');
      });
      return {stdin, stdout, exited: new Promise(() => {}), kill: () => { events.push('detach:relay'); }};
    }
    const exited = (async () => {
      if (id === 'c-result-commit') { stdout.end(`${JSON.stringify({ok: true, head: HEAD})}\n`); return 0; }
      if (id === 'c-reviewer') {
        if (world.result === 'hang') return new Promise<number>(() => {});
        events.push(`model:${await call(1, MODEL_PATHS.openai)}`);
        if (world.questionToo) events.push(`question:${await call(2, QUESTION_PATHS.ask)}`);
        stdout.end(`${typeof world.result === 'object' ? JSON.stringify(world.result) : line({verdict: {kind: 'complete', reviewedSha: HEAD}})}\n`);
        return 0;
      }
      stdout.end('{"ok":true}\n');
      return 0;
    })();
    return {stdin, stdout, exited, kill: () => { events.push(`detach:${id}`); }};
  };
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    relayed.push({role: headers.get('X-Sift-Model-Role'), key: headers.get('Idempotency-Key')});
    return new Response('event: done\n\n', {status: 200});
  }) as unknown as typeof fetch;
  const record: AttemptFsRecord = {image: path.join(root, 'r1.img'), mountPoint: path.join(root, 'm'), imageDev: 2, imageIno: 2,
    loop: '/dev/loop0', uuid: 'uuid-1', state: 'mounted'};
  let seq = 0;
  const ctx: ReviewContext = {
    runId: 'r1', attemptId: 'a1', imageRef: IMAGE, imageId: IMAGE_ID, slice: 'siftable-a1.slice',
    checkout: {repositoryUrl: 'https://github.com/acme/widgets', baseSha: BASE, writeScope: ['lib']},
    helperAsset: '/usr/lib/sift/checkoutHelper.js', docker, attach, create, fsSystem: {} as AttemptFsSystem, attemptRoot: root,
    persistFs: async () => undefined, record, reviewImageRef: IMAGE, reviewImageId: IMAGE_ID, model: 'gpt-6.1-sol',
    sidecarAsset: '/usr/lib/sift/relaySidecar.js', fetch: fetchImpl, hostAddresses: ['10.0.0.4'],
    relay: {apiUrl: 'https://api.example', token: 'pat', workspaceId: null, workItemId: 'w1', attemptId: 'a1', claimToken: 'claim'},
    nextCallId: async () => `a1:${++seq}`, timeoutMs: 2000,
  };
  return {ctx, events, created, relayed, call: (n: number) => call(n, MODEL_PATHS.openai)};
}

describe('review phase', () => {
  it('commits the result, reviews it as the reviewer through its own sidecar, and removes everything it made', async () => {
    const {ctx, events, created, relayed, call} = reviewWorld({questionToo: true});
    const outcome = await runReview(ctx, {baseSha: BASE, treeId: 'f'.repeat(40)});
    expect(outcome).toMatchObject({head: HEAD, outcome: 'passed', receipt: {verdict: {kind: 'complete', reviewedSha: HEAD}}});
    // One model call, billed to the reviewer under a journaled key; the writer's questions are not there.
    expect(relayed).toEqual([{role: 'reviewer', key: 'a1:1'}]);
    expect(events).toContain('model:200');
    expect(events).toContain('question:404');
    // After the phase the routes are closed.
    expect(await call(3)).toBe('503');
    const reviewer = created.get('c-reviewer')!;
    expect(flag(reviewer, '--network')).toEqual(['net-review']);
    expect(flag(reviewer, '--mount')).toEqual(expect.arrayContaining([
      'type=volume,source=sift-a-r1-fs,target=/workspace,volume-subpath=work,readonly',
      'type=volume,source=sift-a-r1-fs,target=/verify,volume-subpath=verify/selected,readonly']));
    expect(JSON.parse(flag(reviewer, '--env').find((e) => e.startsWith('SIFT_REVIEW='))!.slice(12))).toEqual({baseSha: BASE, head: HEAD, model: 'gpt-6.1-sol'});
    expect(flag(reviewer, '--env')).toContain('SIFT_RELAY_URL=http://sift-a-r1-review-relay:8787/sift/v1/model/openai/v1/responses');
    expect(flag(created.get('c-result-commit')!, '--network')).toEqual(['none']);
    // The network is checked empty before anything starts on it.
    expect(events.indexOf('network-inspect')).toBeLessThan(events.indexOf('start:c-review-relay'));
    for (const item of ['container-rm:c-reviewer', 'container-rm:c-review-relay', 'network-rm']) expect(events, item).toContain(item);
  });

  it('fails a non-complete verdict but keeps its receipt', async () => {
    const {ctx} = reviewWorld({result: {version: 'sift.review-result/v1', ok: true, receipt: {verdict: {kind: 'incomplete', reviewedSha: HEAD}}}});
    expect(await runReview(ctx, {baseSha: BASE, treeId: 'f'.repeat(40)})).toMatchObject({outcome: 'review_failed', receipt: {verdict: {kind: 'incomplete'}}});
  });

  it('times out a review that never ends, and one stopped mid-way is interrupted; both remove what they made', async () => {
    const timedOut = reviewWorld({result: 'hang'});
    expect(await runReview({...timedOut.ctx, timeoutMs: 50}, {baseSha: BASE, treeId: 'f'.repeat(40)})).toMatchObject({outcome: 'review_timeout'});
    expect(timedOut.events).toEqual(expect.arrayContaining(['container-kill:c-reviewer', 'container-rm:c-reviewer', 'network-rm']));
    const stopped = reviewWorld({result: 'hang'});
    const life = new AbortController();
    const running = runReview({...stopped.ctx, signal: life.signal}, {baseSha: BASE, treeId: 'f'.repeat(40)});
    setTimeout(() => life.abort(), 30);
    expect(await running).toMatchObject({outcome: 'review_interrupted'});
    expect(stopped.events).toEqual(expect.arrayContaining(['container-kill:c-reviewer', 'container-rm:c-review-relay', 'network-rm']));
    const before = reviewWorld();
    const aborted = new AbortController();
    aborted.abort();
    expect(await runReview({...before.ctx, signal: aborted.signal}, {baseSha: BASE, treeId: 'f'.repeat(40)})).toMatchObject({outcome: 'review_interrupted'});
    expect(before.events).not.toContain('create:reviewer');
  });
});

import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {AttemptFsRecord, AttemptFsSystem} from './attemptFilesystem.js';
import {buildReceipt} from '../review/receipt.js';
import {judgeReview, type ReviewContext, reviewEnvelope, type ReviewRecord, runReview} from './attemptReview.js';
import type {HelperRole} from './attemptWorkspace.js';
import type {Attach} from './machineQualify.js';
import {MODEL_PATHS, QUESTION_PATHS} from './relaySidecar.js';

const IMAGE = `registry.example/sift-reviewer@sha256:${'a'.repeat(64)}`;
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const HEAD = 'e'.repeat(40);
const BASE = 'c'.repeat(40);
const line = (receipt: object) => JSON.stringify({version: 'sift.review-result/v1', ok: true, receipt});
const COVERAGE = {filesInScope: 1, filesReviewed: 1, filesSkipped: [], stages: {}, candidates: {}};
const VERDICTS = {
  complete: (sha: string) => ({kind: 'complete', reviewedSha: sha, blocking: 0, advisory: 1, coverage: COVERAGE}),
  blocked: (sha: string) => ({kind: 'complete', reviewedSha: sha, blocking: 2, advisory: 1, coverage: COVERAGE}),
  incomplete: (sha: string) => ({kind: 'incomplete', reviewedSha: sha, coverage: COVERAGE, reason: 'budget'}),
  skipped: (sha: string) => ({kind: 'skipped', reviewedSha: sha, reason: 'no_changes'}),
  failed: (sha: string) => ({kind: 'failed', reviewedSha: sha, reason: 'pre-pass failed'}),
};
/** A receipt as `sift review` actually writes it (Release R14): built by the real producer, digest and all. */
const receiptOf = (kind: keyof typeof VERDICTS, head = HEAD, base = BASE) => buildReceipt({head, base, mergeBase: base, baseRef: base,
  worktreeDirty: false, policy: {name: 'default', revision: 'p1'}, model: 'gpt-6.1-sol', provider: 'codex-proxy', finderPasses: 2, problems: [],
  startedAt: new Date(0), finishedAt: new Date(0)}, VERDICTS[kind](head) as never, []);

describe('review verdicts (R-D5, R8, R14)', () => {
  it('fails a complete verdict with blocking findings, keeping its receipt; advisory findings alone pass', () => {
    expect(judgeReview(HEAD, line(receiptOf('blocked')), BASE)).toMatchObject({outcome: 'review_blocked', detail: '2 blocking, 1 advisory',
      receipt: {completion: 'complete', status: 'findings', verdict: {blocking: 2}}});
    expect(judgeReview(HEAD, line(receiptOf('complete')), BASE).outcome).toBe('passed');
  });

  it('passes only a complete verdict for exactly the result head, keeping every receipt', () => {
    expect(judgeReview(HEAD, line(receiptOf('complete')), BASE)).toMatchObject({outcome: 'passed', receipt: {completion: 'complete', revision: {head: HEAD}}});
    for (const kind of ['skipped', 'incomplete', 'failed'] as const) {
      expect(judgeReview(HEAD, line(receiptOf(kind)), BASE), kind).toMatchObject({outcome: 'review_failed', detail: `verdict ${kind}`,
        receipt: {completion: kind}});
    }
    expect(judgeReview(HEAD, line(receiptOf('complete', BASE)), BASE)).toMatchObject({outcome: 'review_head_mismatch'});
    expect(judgeReview(HEAD, line(receiptOf('complete', HEAD, 'a'.repeat(40))), BASE)).toMatchObject({outcome: 'review_head_mismatch'});
    // An edited receipt no longer matches its digest.
    expect(judgeReview(HEAD, line({...receiptOf('incomplete'), completion: 'complete', verdict: {...receiptOf('incomplete').verdict, kind: 'complete'}}), BASE))
      .toMatchObject({outcome: 'review_failed', detail: 'the receipt digest does not match its content'});
    expect(judgeReview(HEAD, 'not json').outcome).toBe('review_failed');
    expect(judgeReview(HEAD, JSON.stringify({version: 'sift.review-result/v1', ok: false, code: 'review_failed', detail: 'no codex'})))
      .toMatchObject({outcome: 'review_failed', detail: 'no codex'});
    expect(judgeReview(HEAD, JSON.stringify({version: 'other/v1', ok: true, receipt: receiptOf('complete')})).outcome).toBe('review_failed');
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

interface World {result?: object | 'hang'; questionToo?: boolean;
  /** The reviewer makes one model call and then never exits; the relay answers as told. */
  callThenHang?: 'abortable' | 'ignores-abort'}

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
        if (world.callThenHang) {
          sidecarOut?.write(`${JSON.stringify({id: 1, method: 'POST', path: MODEL_PATHS.openai, body: Buffer.from('{}').toString('base64')})}\n`);
          return new Promise<number>(() => {});
        }
        events.push(`model:${await call(1, MODEL_PATHS.openai)}`);
        if (world.questionToo) events.push(`question:${await call(2, QUESTION_PATHS.ask)}`);
        stdout.end(`${typeof world.result === 'object' ? JSON.stringify(world.result) : line(receiptOf('complete'))}\n`);
        return 0;
      }
      stdout.end('{"ok":true}\n');
      return 0;
    })();
    return {stdin, stdout, exited, kill: () => { events.push(`detach:${id}`); }};
  };
  let release: () => void = () => undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    relayed.push({role: headers.get('X-Sift-Model-Role'), key: headers.get('Idempotency-Key')});
    if (world.callThenHang === 'abortable') {
      // An aborted request takes a moment to wind down, as a real socket does.
      await new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => setTimeout(() => reject(new Error('aborted')), 10), {once: true}));
    }
    if (world.callThenHang === 'ignores-abort') await new Promise<void>((resolve) => { release = resolve; });
    return new Response('event: done\n\n', {status: 200, headers: {'x-sift-call-id': `call-${relayed.length}`}});
  }) as unknown as typeof fetch;
  const record: AttemptFsRecord = {image: path.join(root, 'r1.img'), mountPoint: path.join(root, 'm'), imageDev: 2, imageIno: 2,
    loop: '/dev/loop0', uuid: 'uuid-1', state: 'mounted'};
  let seq = 0;
  const journaled: ReviewRecord[] = [];
  const ctx: ReviewContext = {
    runId: 'r1', attemptId: 'a1', imageRef: IMAGE, imageId: IMAGE_ID, slice: 'siftable-a1.slice',
    checkout: {repositoryUrl: 'https://github.com/acme/widgets', baseSha: BASE, writeScope: ['lib']},
    helperAsset: '/usr/lib/sift/checkoutHelper.js', docker, attach, create, fsSystem: {} as AttemptFsSystem, attemptRoot: root,
    persistFs: async () => undefined, record, reviewImageRef: IMAGE, reviewImageId: IMAGE_ID, model: 'gpt-6.1-sol',
    sidecarAsset: '/usr/lib/sift/relaySidecar.js', fetch: fetchImpl, hostAddresses: ['10.0.0.4'],
    relay: {apiUrl: 'https://api.example', token: 'pat', workspaceId: null, workItemId: 'w1', attemptId: 'a1', claimToken: 'claim'},
    nextCallId: async () => `a1:${++seq}`, timeoutMs: 2000,
    journal: async (record) => { journaled.push(structuredClone(record)); events.push(`journal:${record.calls.length}`); },
  };
  return {ctx, events, created, relayed, journaled, call: (n: number) => call(n, MODEL_PATHS.openai), release: () => release()};
}

describe('review phase', () => {
  it('commits the result, reviews it as the reviewer through its own sidecar, and removes everything it made', async () => {
    const {ctx, events, created, relayed, journaled, call} = reviewWorld({questionToo: true});
    const outcome = await runReview(ctx, {baseSha: BASE, treeId: 'f'.repeat(40)});
    expect(outcome).toMatchObject({head: HEAD, outcome: 'passed', receipt: {completion: 'complete', revision: {head: HEAD}},
      calls: [{key: 'a1:1', status: 200, callId: 'call-1'}]});
    // Release R15: the head is durable before the first call, and each call as it is forwarded.
    // The key is recorded as unknown before the call is sent (R17), then its answer replaces it; once more as the phase
    // closes, after every in-flight call has been recorded.
    const done = {head: HEAD, calls: [{key: 'a1:1', status: 200, callId: 'call-1'}]};
    expect(journaled).toEqual([{head: HEAD, calls: []}, {head: HEAD, calls: [{key: 'a1:1', status: 0}]}, done, done]);
    expect(events.indexOf('journal:0')).toBeLessThan(events.indexOf('start:c-reviewer'));
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

  // Release R16: a relay call still running when the phase ends is aborted and recorded before return; nothing it does
  // afterwards reaches the journal.
  it('aborts and records an in-flight relay call when the phase ends, and never journals after returning', async () => {
    const aborted = reviewWorld({callThenHang: 'abortable'});
    const outcome = await runReview({...aborted.ctx, timeoutMs: 100}, {baseSha: BASE, treeId: 'f'.repeat(40)});
    expect(outcome).toMatchObject({outcome: 'review_timeout', calls: [{key: 'a1:1', status: 0}]});
    expect(aborted.journaled.at(-1)).toEqual({head: HEAD, calls: [{key: 'a1:1', status: 0}]});
    const late = reviewWorld({callThenHang: 'ignores-abort'});
    const returned = await runReview({...late.ctx, timeoutMs: 100, drainMs: 20}, {baseSha: BASE, treeId: 'f'.repeat(40)});
    // Release R17: a call still running past the drain window is in the result and the last journal write as unknown.
    expect(returned).toMatchObject({outcome: 'review_timeout', calls: [{key: 'a1:1', status: 0}]});
    expect(late.journaled.at(-1)).toEqual({head: HEAD, calls: [{key: 'a1:1', status: 0}]});
    const envelope = reviewEnvelope({attemptId: 'a1', baseSha: BASE, treeId: 'f'.repeat(40), patchSha256: '9'.repeat(64), runs: [], model: 'm'}, returned);
    const frozen = JSON.stringify(envelope);
    expect(envelope.calls).toEqual([{key: 'a1:1', status: 0}]);
    const writes = late.journaled.length;
    // The relay answers long after the phase returned: nothing changes, neither the journal nor the returned record.
    late.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(late.journaled).toHaveLength(writes);
    expect(returned.calls).toEqual([{key: 'a1:1', status: 0}]);
    expect(JSON.stringify(reviewEnvelope({attemptId: 'a1', baseSha: BASE, treeId: 'f'.repeat(40), patchSha256: '9'.repeat(64), runs: [], model: 'm'},
      returned))).toBe(frozen);
  });

  it('fails a non-complete verdict but keeps its receipt', async () => {
    const {ctx} = reviewWorld({result: {version: 'sift.review-result/v1', ok: true, receipt: receiptOf('incomplete')}});
    expect(await runReview(ctx, {baseSha: BASE, treeId: 'f'.repeat(40)})).toMatchObject({outcome: 'review_failed', receipt: {completion: 'incomplete'}});
  });

  it('binds the raw receipt to the attempt, head, tree, patch, runs, model and relay calls (R-D4, R15)', () => {
    const runs = [{role: 'base' as const, exitCode: 1, treeId: 'd'.repeat(40), counts: {collected: 1, passed: 0, failed: 1, skipped: 0},
      reportSha256: '1'.repeat(64), report: '<testsuites/>', output: ''}];
    const envelope = reviewEnvelope({attemptId: 'a1', baseSha: BASE, treeId: 'f'.repeat(40), patchSha256: '9'.repeat(64), runs, model: 'gpt-6.1-sol'},
      {head: HEAD, outcome: 'passed', calls: [{key: 'a1:7', status: 200, callId: 'call-7'}], receipt: receiptOf('complete') as never});
    expect(envelope).toMatchObject({version: 'sift.review-receipt/v1', attemptId: 'a1', baseSha: BASE, head: HEAD, treeId: 'f'.repeat(40),
      patchSha256: '9'.repeat(64), model: 'gpt-6.1-sol', calls: [{key: 'a1:7', callId: 'call-7'}], outcome: 'passed', receipt: {format: 'taster.local-receipt/v1'}});
    expect(envelope.runsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(reviewEnvelope({attemptId: 'a1', baseSha: BASE, treeId: 'f'.repeat(40), patchSha256: '9'.repeat(64), runs: [], model: 'm'}, {outcome: 'passed'}).runsSha256)
      .not.toBe(envelope.runsSha256);
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

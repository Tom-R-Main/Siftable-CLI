import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {type AttemptFsRecord, type AttemptFsSystem} from './attemptFilesystem.js';
import {
  canonicalJson, checkSummary, freezeVerifierLog, identityOf, judgeBase, judgeRegression, judgeSelected, type VerifyContext, VerifyFailed,
  verifyBase, verifyResult,
} from './attemptVerify.js';
import type {HelperRole} from './attemptWorkspace.js';
import {parseJUnit, type ReportSummary} from './junitReport.js';
import type {Attach} from './machineQualify.js';

const IMAGE = `registry.example/sift-agent@sha256:${'a'.repeat(64)}`;
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const BASE_TREE = 'd'.repeat(40);

const summaryOf = (cases: Array<[string, 'passed' | 'failed' | 'skipped']>): ReportSummary => {
  const testcases = cases.map(([name, outcome]) => ({suite: [], classname: 'test', name, outcome}));
  const count = (o: string) => testcases.filter((t) => t.outcome === o).length;
  return {testcases, counts: {collected: testcases.length, passed: count('passed'), failed: count('failed'), skipped: count('skipped')}};
};
const ids = (...names: string[]) => names.map((name) => identityOf({suite: [], classname: 'test', name}));

describe('verification rules', () => {
  it('base: collected, failing, and a nonzero exit; anything else is named', () => {
    expect(judgeBase(1, summaryOf([['a', 'failed'], ['b', 'passed']]))).toEqual({selected: ids('a', 'b'), failing: ids('a')});
    expect(judgeBase(1, summaryOf([])).code).toBe('no_tests_collected');
    expect(judgeBase(0, summaryOf([['a', 'passed']])).code).toBe('base_test_passes');
    expect(judgeBase(1, summaryOf([['a', 'skipped']])).code).toBe('base_test_passes');
    expect(judgeBase(0, summaryOf([['a', 'failed']])).code).toBe('report_inconsistent');
  });

  it('selected: same identities, base failures now passing, nothing failing, exit 0', () => {
    const selected = ids('a', 'b');
    const failing = ids('a');
    expect(judgeSelected(0, summaryOf([['a', 'passed'], ['b', 'passed']]), selected, failing)).toBeUndefined();
    expect(judgeSelected(0, summaryOf([['a', 'passed']]), selected, failing)).toBe('test_identity_changed');
    expect(judgeSelected(0, summaryOf([['a', 'passed'], ['b', 'passed'], ['c', 'passed']]), selected, failing)).toBe('test_identity_changed');
    expect(judgeSelected(0, summaryOf([['a', 'passed'], ['renamed', 'passed']]), selected, failing)).toBe('test_identity_changed');
    expect(judgeSelected(0, summaryOf([['a', 'skipped'], ['b', 'passed']]), selected, failing)).toBe('selected_test_failed');
    expect(judgeSelected(0, summaryOf([['a', 'passed'], ['b', 'failed']]), selected, failing)).toBe('selected_test_failed');
    // A passing report with a failing exit does not pass.
    expect(judgeSelected(2, summaryOf([['a', 'passed'], ['b', 'passed']]), selected, failing)).toBe('selected_test_failed');
  });

  it('regression: something executed, nothing failed, exit 0; all skipped does not pass', () => {
    expect(judgeRegression(0, summaryOf([['a', 'passed'], ['b', 'skipped']]))).toBeUndefined();
    expect(judgeRegression(0, summaryOf([['a', 'skipped']]))).toBe('no_tests_collected');
    expect(judgeRegression(0, summaryOf([]))).toBe('no_tests_collected');
    expect(judgeRegression(0, summaryOf([['a', 'failed']]))).toBe('regression_failed');
    expect(judgeRegression(1, summaryOf([['a', 'passed']]))).toBe('regression_failed');
  });

  it('checks the helper summary field by field and recounts it', () => {
    const good = summaryOf([['a', 'passed']]);
    expect(checkSummary(good)).toEqual(good);
    expect(() => checkSummary({...good, counts: {...good.counts, passed: 5}})).toThrow(/counts/);
    expect(() => checkSummary({testcases: [{suite: [], classname: 'test', name: 'a', outcome: 'maybe'}], counts: good.counts})).toThrow(/malformed/);
    expect(() => checkSummary({testcases: [good.testcases[0], good.testcases[0]], counts: {...good.counts, collected: 2, passed: 2}})).toThrow(/duplicate/);
    expect(() => checkSummary(undefined)).toThrow();
  });

  it('writes one canonical verifier log, the same bytes for the same content', async () => {
    expect(canonicalJson({b: 1, a: [{d: 2, c: 3}]})).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'sift-vlog-'));
    const run = {role: 'base' as const, exitCode: 1, treeId: BASE_TREE, counts: summaryOf([]).counts, reportSha256: 'e'.repeat(64),
      report: '<testsuites/>', output: 'x'};
    const one = await freezeVerifierLog(dir, {runs: [run], frozen: [], outcome: 'passed'});
    const two = await freezeVerifierLog(dir, {outcome: 'passed', frozen: [], runs: [run]});
    expect(two.sha256).toBe(one.sha256);
    expect(one).toMatchObject({kind: 'verifier_log', contentType: 'application/json'});
    expect(JSON.parse(await fs.readFile(one.path, 'utf8'))).toMatchObject({version: 1, outcome: 'passed', runs: [{role: 'base'}]});
  });
});

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(tmpdir(), 'sift-verify-')); });
afterEach(async () => { await fs.rm(root, {recursive: true, force: true}); });

const flag = (args: string[], name: string) => args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : []));
const junit = (cases: Array<[string, 'passed' | 'failed' | 'skipped']>) => `<testsuites>${cases.map(([name, outcome]) =>
  `<testcase name="${name}" classname="test">${outcome === 'failed' ? '<failure/>' : outcome === 'skipped' ? '<skipped/>' : ''}</testcase>`).join('')}</testsuites>`;

interface Run {cases?: Array<[string, 'passed' | 'failed' | 'skipped']>; exit?: number; noReport?: boolean; changed?: string[]}
let contexts = 0;
interface Scenario {base?: Run; selected?: Run; regression?: Run; frozen?: Array<{path: string; kind: 'file' | 'dir'}>; applyFails?: boolean}

/** A Docker where each helper answers as the real one would, and the test container writes the scenario's report. */
function verifyContext(scenario: Scenario, test: VerifyContext['test'] = {command: 'node --test $SIFT_TEST_SELECTOR', selector: 'test/a.test.js'}) {
  const events: string[] = [];
  const created = new Map<string, string[]>();
  contexts += 1;
  const record: AttemptFsRecord = {image: path.join(root, 'r1.img'), mountPoint: path.join(root, `m${contexts}`), imageDev: 2, imageIno: 2,
    loop: '/dev/loop0', uuid: 'uuid-1', state: 'mounted'};
  let current: 'base' | 'selected' | 'regression' = 'base';
  const docker: VerifyContext['docker'] = async (args) => {
    const ok = (stdout = '') => ({code: 0, stdout, stderr: ''});
    if (args[0] === 'container' && args[1] === 'inspect') {
      const made = created.get(args[2])!;
      const mounts = flag(made, '--mount').map((m) => Object.fromEntries(m.split(',').map((p) => (p.includes('=') ? p.split('=') : [p, 'true']))));
      const memory = Number(flag(made, '--memory')[0].replace('m', ''));
      return ok(JSON.stringify([{Id: args[2], Image: IMAGE_ID,
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
        NetworkSettings: {Networks: {}}}]));
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return ok(JSON.stringify([{Name: 'sift-a-r1-fs', Driver: 'local', Labels: {'sift.machine.run': 'r1', 'sift.machine.role': 'volume',
        'sift.machine.attempt': 'a1'}, Options: {type: 'ext4', device: '/dev/loop0', o: 'nodev,nosuid,nodiscard'}}]));
    }
    return ok();
  };
  const create = async (role: HelperRole, args: string[]) => {
    events.push(`create:${role}`);
    created.set(`c-${role}`, args);
    return `c-${role}`;
  };
  const attach: Attach = (args) => {
    const id = args.at(-1)!;
    const made = created.get(id)!;
    events.push(`start:${id}`);
    const stdout = new PassThrough();
    const exited = (async () => {
      const subpath = flag(made, '--mount').map((m) => /volume-subpath=verify\/(\w+)/.exec(m)?.[1]).find(Boolean) as typeof current | undefined;
      if (subpath) current = subpath;
      const run = scenario[current] ?? {};
      const reportDir = path.join(record.mountPoint, 'verify', current, 'report');
      if (id === 'c-verify-checkout') {
        if (current !== 'base' && scenario.applyFails) { stdout.end('{"ok":false,"code":"patch_apply_failed","detail":"no"}\n'); return 2; }
        stdout.end(`${JSON.stringify({ok: true, treeId: current === 'base' ? BASE_TREE : 'f'.repeat(40)})}\n`);
        return 0;
      }
      if (id === 'c-verifier') {
        expect(flag(made, '--network')).toEqual(['none']);
        if (!run.noReport) await fs.writeFile(path.join(reportDir, 'junit.xml'), junit(run.cases ?? []));
        stdout.end('test output\n');
        return run.exit ?? 0;
      }
      if (id === 'c-report') {
        const file = path.join(reportDir, 'junit.xml');
        const exists = await fs.stat(file).then(() => true, () => false);
        stdout.end(`${JSON.stringify(exists ? {ok: true, summary: parseJUnit(await fs.readFile(file))} : {ok: false, code: 'report_missing', message: 'none'})}\n`);
        return exists ? 0 : 1;
      }
      if (id === 'c-tree-check') {
        const frozenAsked = JSON.parse(flag(made, '--env').find((e) => e.startsWith('SIFT_VERIFY='))!.slice('SIFT_VERIFY='.length)).frozen;
        stdout.end(`${JSON.stringify({ok: true, changed: run.changed ?? [], ...(frozenAsked ? {frozen: scenario.frozen ?? [{path: 'test/a.test.js', kind: 'file'}]} : {})})}\n`);
        return 0;
      }
      stdout.end('{"ok":true}\n');
      return 0;
    })();
    return {stdin: new PassThrough(), stdout, exited, kill: () => undefined};
  };
  const fsSystem = {mkdir: async (dir: string) => { await fs.mkdir(dir, {recursive: true}); }, chown: async () => undefined} as unknown as AttemptFsSystem;
  const ctx: VerifyContext = {
    runId: 'r1', attemptId: 'a1', imageRef: IMAGE, imageId: IMAGE_ID, slice: 'siftable-a1.slice',
    checkout: {repositoryUrl: 'https://github.com/acme/widgets', baseSha: 'c'.repeat(40), writeScope: ['lib']},
    helperAsset: '/usr/lib/sift/checkoutHelper.js', reportAsset: '/usr/lib/sift/junitReport.js',
    docker, attach, create, fsSystem, attemptRoot: root, persistFs: async () => undefined,
    record, test, dependencies: true, verifyTimeouts: {testMs: 2000, helperMs: 2000},
  };
  return {ctx, events, created};
}

const codeOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => {
  expect(error).toBeInstanceOf(VerifyFailed);
  return (error as VerifyFailed).code;
});

describe('verification runs', () => {
  const failing: Run = {cases: [['adds', 'failed'], ['subtracts', 'passed']], exit: 1};
  const fixed: Run = {cases: [['adds', 'passed'], ['subtracts', 'passed']], exit: 0};

  it('runs base, selected and regression on fresh trees, with the selector only in the environment', async () => {
    const {ctx, created, events} = verifyContext({base: failing, selected: fixed, regression: {cases: [['adds', 'passed'], ['other', 'passed']]}});
    const base = await verifyBase(ctx);
    expect(base).toMatchObject({failing: [identityOf({suite: [], classname: 'test', name: 'adds'})], frozen: [{path: 'test/a.test.js'}]});
    const verifier = created.get('c-verifier')!;
    expect(verifier.slice(-2)).toEqual(['-c', 'exec 2>&1\nnode --test $SIFT_TEST_SELECTOR']);
    expect(flag(verifier, '--env')).toEqual(expect.arrayContaining(['SIFT_TEST_SELECTOR=test/a.test.js', 'SIFT_TEST_REPORT=/sift/report/junit.xml']));
    expect(flag(verifier, '--mount')).toEqual(expect.arrayContaining([
      'type=volume,source=sift-a-r1-fs,target=/workspace,volume-subpath=verify/base/src',
      'type=volume,source=sift-a-r1-fs,target=/workspace/node_modules,volume-subpath=deps/node_modules,readonly']));
    const runs = await verifyResult(ctx, base, {sha256: '9'.repeat(64), changed: ['lib/add.js']});
    expect(runs.map((run) => [run.role, run.exitCode, run.counts.failed])).toEqual([['base', 1, 1], ['selected', 0, 0], ['regression', 0, 0]]);
    expect(flag(created.get('c-verifier')!, '--env')).toContain('SIFT_TEST_SELECTOR=');
    const checkout = created.get('c-verify-checkout')!;
    expect(JSON.parse(flag(checkout, '--env').find((e) => e.startsWith('SIFT_VERIFY='))!.slice(12))).toMatchObject({patchSha256: '9'.repeat(64)});
    expect(flag(checkout, '--network')).toEqual(['none']);
    // Each run's helpers in order: checkout, tests, report, tree check.
    expect(events.filter((e) => e.startsWith('create:')).slice(0, 4)).toEqual(['create:verify-checkout', 'create:verifier', 'create:report', 'create:tree-check']);
    expect(await fs.readdir(path.join(ctx.record.mountPoint, 'verify'))).toEqual(['base', 'regression', 'selected']);
  });

  it('blocks a base whose selected test passes, and one that collects nothing', async () => {
    expect(await codeOf(verifyBase(verifyContext({base: fixed}).ctx))).toBe('base_test_passes');
    expect(await codeOf(verifyBase(verifyContext({base: {cases: [], exit: 1}}).ctx))).toBe('no_tests_collected');
    expect(await codeOf(verifyBase(verifyContext({base: {noReport: true, exit: 1}}).ctx))).toBe('report_missing');
    expect(await codeOf(verifyBase(verifyContext({base: {cases: [['adds', 'failed']], exit: 0}}).ctx))).toBe('report_inconsistent');
  });

  it('fails a patch touching a frozen file before any run, keeping the base run', async () => {
    const {ctx} = verifyContext({base: failing, selected: fixed});
    const base = await verifyBase(ctx);
    const failure = await verifyResult(ctx, base, {sha256: '9'.repeat(64), changed: ['lib/add.js', 'test/a.test.js']}).catch((e: unknown) => e as VerifyFailed);
    expect(failure).toMatchObject({code: 'frozen_test_changed', runs: [{role: 'base'}]});
  });

  it('fails a changed identity, a still-failing test, a mutated tree, an unapplied patch and a failing regression', async () => {
    const run = async (scenario: Scenario) => {
      const {ctx} = verifyContext({base: failing, ...scenario});
      return codeOf(verifyResult(ctx, await verifyBase(ctx), {sha256: '9'.repeat(64), changed: ['lib/add.js']}));
    };
    expect(await run({selected: {cases: [['adds', 'passed']], exit: 0}})).toBe('test_identity_changed');
    expect(await run({selected: {cases: [['adds', 'failed'], ['subtracts', 'passed']], exit: 1}})).toBe('selected_test_failed');
    expect(await run({selected: {...fixed, exit: 2}})).toBe('selected_test_failed');
    expect(await run({selected: {...fixed, changed: ['test/a.test.js']}})).toBe('tree_mutated');
    expect(await run({applyFails: true})).toBe('patch_apply_failed');
    expect(await run({selected: fixed, regression: {cases: [['x', 'skipped']]}})).toBe('no_tests_collected');
    expect(await run({selected: fixed, regression: {cases: [['x', 'failed']], exit: 1}})).toBe('regression_failed');
  });

  // Release U3-R5: a refusal after the tests reported keeps that run's record, with the refusal's own code.
  it('keeps a completed run when its tree check refuses, for base, selected and regression', async () => {
    const baseRefused = await verifyBase(verifyContext({base: {...failing, changed: ['lib/add.js']}}).ctx).catch((e: unknown) => e as VerifyFailed);
    expect(baseRefused).toMatchObject({code: 'tree_mutated', runs: [{role: 'base', exitCode: 1, counts: {failed: 1}}]});
    expect((baseRefused as VerifyFailed).runs[0].report).toContain('<testcase name="adds"');
    for (const [scenario, roles] of [[{selected: {...fixed, changed: ['lib/add.js']}}, ['base', 'selected']],
      [{selected: fixed, regression: {cases: [['x', 'passed']], changed: ['lib/x.js']}}, ['base', 'selected', 'regression']]] as const) {
      const {ctx} = verifyContext({base: failing, ...scenario});
      const refused = await verifyResult(ctx, await verifyBase(ctx), {sha256: '9'.repeat(64), changed: ['lib/add.js']}).catch((e: unknown) => e as VerifyFailed);
      expect(refused).toMatchObject({code: 'tree_mutated'});
      expect((refused as VerifyFailed).runs.map((r) => r.role)).toEqual(roles);
    }
  });

  it('without a selector, one run is held to both rules', async () => {
    const {ctx, events} = verifyContext({base: failing, selected: {cases: [['adds', 'passed'], ['subtracts', 'skipped']]}},
      {command: 'npm test', files: ['test']});
    const base = await verifyBase(ctx);
    const runs = await verifyResult(ctx, base, {sha256: '9'.repeat(64), changed: ['lib/add.js']}).catch((e: unknown) => e as VerifyFailed);
    // subtracts passed on base and is skipped now: the identity is the same, nothing failed, something executed.
    expect(Array.isArray(runs) ? runs.map((r) => r.role) : runs).toEqual(['base', 'selected']);
    expect(events.filter((e) => e === 'create:verifier')).toHaveLength(2);
  });
});

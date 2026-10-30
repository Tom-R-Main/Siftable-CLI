/**
 * Verification of an attempt's result (first-run U3-1, verification contract
 * rev 2, `.context/first-run-u3/u3-verify-contract.md`). Every test run gets
 * a fresh tree on the attempt volume (`verify/<run>/src`) made by the checkout
 * helper; the plan's test command runs there in the plan image with no
 * network, writing JUnit XML to $SIFT_TEST_REPORT; the report is parsed by
 * the report helper, never here; afterwards the helper checks that no tracked
 * file changed. A run passes only on its exit code and its report together.
 *
 * Base (before the writer): the selected tests must be collected and must
 * fail. Selected and regression (after the patch is frozen): the patch is
 * applied by its digest, the selected identities must equal the base's, the
 * base failures must pass, and nothing may fail.
 */
import {createHash} from 'node:crypto';
import {constants, promises as fs} from 'node:fs';
import path from 'node:path';
import {attemptVolumeName, type AttemptFsRecord, SANDBOX_UID} from './attemptFilesystem.js';
import type {FrozenArtifact} from './attemptEvidence.js';
import {checkAttemptVolume, gone, helperSpec, labels, runHelper, stopped, type WorkspaceContext, WorkspaceRefused} from './attemptWorkspace.js';
import {type FrozenPath, type FrozenSource, frozenChanges} from './checkoutHelper.js';
import {evaluateSandboxInspect, type SandboxContainerSpec, sandboxCreateArgs} from './containerSandbox.js';
import {MAX_REPORT_BYTES, REPORT_FILE, type ReportSummary, type TestCase, type TestOutcome} from './junitReport.js';

export const TEST_TIMEOUT_MS = 600_000;
export const VERIFY_HELPER_TIMEOUT_MS = 180_000;
export const MAX_TEST_OUTPUT_BYTES = 256 * 1024;
const REPORT_RESULT_LIMIT = 32 * 1024 * 1024;
export const VERIFIER_LOG = 'verifier.json';
export const VERIFIER_LOG_CONTENT_TYPE = 'application/json';

export type VerifyRun = 'base' | 'selected' | 'regression';
export interface TestPlan {command: string; selector?: string; files?: string[]}

export interface RunRecord {
  role: VerifyRun;
  exitCode: number;
  treeId: string;
  counts: ReportSummary['counts'];
  reportSha256: string;
  /** The report's XML text, as written. */
  report: string;
  /** The end of the command's combined output, at most MAX_TEST_OUTPUT_BYTES. */
  output: string;
}

export interface VerifyContext extends WorkspaceContext {
  record: AttemptFsRecord;
  test: TestPlan;
  /** The shipped JUnit report reader, bind-mounted read-only into the report helper. */
  reportAsset: string;
  /** Installed dependencies are mounted read-only at node_modules. */
  dependencies: boolean;
  verifyTimeouts?: {testMs?: number; helperMs?: number};
}

/** A verification failure, with every run that completed before it. */
export class VerifyFailed extends Error {
  constructor(readonly code: string, detail: string, readonly runs: RunRecord[]) {
    super(`${code}: ${detail}`);
  }
}

export const identityOf = (testcase: Pick<TestCase, 'suite' | 'classname' | 'name' | 'file'>) =>
  JSON.stringify([testcase.suite, testcase.classname, testcase.name, testcase.file ?? null]);

/** Base rule: selected tests collected, at least one failing, and the command's exit code saying so. */
export function judgeBase(exitCode: number, summary: ReportSummary): {code?: string; selected: string[]; failing: string[]} {
  const selected = summary.testcases.map(identityOf);
  const failing = summary.testcases.filter((testcase) => testcase.outcome === 'failed').map(identityOf);
  if (summary.counts.collected === 0) return {code: 'no_tests_collected', selected, failing};
  if (failing.length === 0) return {code: 'base_test_passes', selected, failing};
  if (exitCode === 0) return {code: 'report_inconsistent', selected, failing};
  return {selected, failing};
}

/** Selected rule: the same identities as the base, every base failure passing, nothing failing, exit 0. */
export function judgeSelected(exitCode: number, summary: ReportSummary, selected: string[], failing: string[]): string | undefined {
  const now = new Map(summary.testcases.map((testcase) => [identityOf(testcase), testcase.outcome] as [string, TestOutcome]));
  if (now.size !== selected.length || selected.some((identity) => !now.has(identity))) return 'test_identity_changed';
  if (failing.some((identity) => now.get(identity) !== 'passed')) return 'selected_test_failed';
  if (summary.counts.failed > 0 || exitCode !== 0) return 'selected_test_failed';
  return undefined;
}

/** Regression rule: at least one executed test, none failing, exit 0. An all-skipped suite does not pass. */
export function judgeRegression(exitCode: number, summary: ReportSummary): string | undefined {
  if (summary.counts.passed + summary.counts.failed === 0) return 'no_tests_collected';
  if (summary.counts.failed > 0 || exitCode !== 0) return 'regression_failed';
  return undefined;
}

const OUTCOMES = new Set(['passed', 'failed', 'skipped']);
const isString = (value: unknown): value is string => typeof value === 'string';

/** The report helper's summary, checked field by field and recounted; anything else is refused. */
export function checkSummary(value: unknown): ReportSummary {
  const summary = value as {testcases?: unknown; counts?: unknown};
  if (!Array.isArray(summary?.testcases)) throw new Error('no testcases');
  const testcases = summary.testcases.map((entry: unknown) => {
    const testcase = entry as Record<string, unknown>;
    if (!Array.isArray(testcase.suite) || !testcase.suite.every(isString) || !isString(testcase.classname) || !isString(testcase.name)
      || (testcase.file !== undefined && !isString(testcase.file)) || !OUTCOMES.has(testcase.outcome as string)) {
      throw new Error('a testcase is malformed');
    }
    return {suite: testcase.suite as string[], classname: testcase.classname, name: testcase.name,
      ...(testcase.file === undefined ? {} : {file: testcase.file as string}), outcome: testcase.outcome as TestOutcome};
  });
  if (new Set(testcases.map(identityOf)).size !== testcases.length) throw new Error('duplicate identities');
  const count = (outcome: TestOutcome) => testcases.filter((testcase) => testcase.outcome === outcome).length;
  const counts = {collected: testcases.length, passed: count('passed'), failed: count('failed'), skipped: count('skipped')};
  if (JSON.stringify(summary.counts) !== JSON.stringify(counts)) throw new Error('the counts do not match the testcases');
  return {testcases, counts};
}

const volumeOf = (ctx: VerifyContext) => attemptVolumeName(ctx.runId);
const helperMs = (ctx: VerifyContext) => ctx.verifyTimeouts?.helperMs ?? VERIFY_HELPER_TIMEOUT_MS;

/** `verify/<run>` and its report directory, made fresh by the supervisor and owned by the sandbox user. */
async function prepareRunDir(ctx: VerifyContext, run: VerifyRun): Promise<void> {
  const dir = path.join(ctx.record.mountPoint, 'verify', run);
  for (const target of [dir, path.join(dir, 'report')]) {
    if (await fs.lstat(target).then(() => true, () => false)) throw new WorkspaceRefused('verify_failed', `${target} already exists`);
    await ctx.fsSystem.mkdir(target, 0o700);
    await ctx.fsSystem.chown(target, SANDBOX_UID, SANDBOX_UID);
  }
}

async function checkoutRun(ctx: VerifyContext, run: VerifyRun, patchSha256?: string): Promise<string> {
  const volume = volumeOf(ctx);
  const result = await runHelper(ctx, 'verify-checkout', helperSpec(ctx, 'verify-checkout', 'none', [
    {volume, target: '/workspace', readonly: true, subpath: 'work'},
    {volume, target: '/out', readonly: true, subpath: 'src'},
    {volume, target: '/verify', readonly: false, subpath: `verify/${run}`},
  ], {HOME: '/tmp/h', SIFT_MODE: 'verify-checkout', SIFT_VERIFY: JSON.stringify({baseSha: ctx.checkout.baseSha,
    dependencies: ctx.dependencies, ...(patchSha256 ? {patchSha256} : {})})}), helperMs(ctx));
  const treeId = (result as {treeId?: unknown}).treeId;
  if (!isString(treeId) || !/^[0-9a-f]{40}$/.test(treeId)) throw new WorkspaceRefused('verify_failed', 'no tree id from the verify checkout');
  return treeId;
}

/** Runs the plan's test command in the run's tree; returns its exit code and the end of its output. */
async function testRun(ctx: VerifyContext, run: VerifyRun, selector: string): Promise<{exitCode: number; output: string}> {
  stopped(ctx);
  const volume = volumeOf(ctx);
  const spec: SandboxContainerSpec = {
    name: `sift-a-${ctx.runId}-verifier`, imageRef: ctx.imageRef, networkId: 'none', labels: labels(ctx, 'verifier'),
    // stderr joins stdout so the output is one stream; the command itself is passed as written.
    entrypoint: 'sh', command: ['-c', `exec 2>&1\n${ctx.test.command}`], mounts: [],
    volumes: [{volume, target: '/workspace', readonly: false, subpath: `verify/${run}/src`},
      ...(ctx.dependencies ? [{volume, target: '/workspace/node_modules', readonly: true, subpath: 'deps/node_modules'}] : []),
      {volume, target: '/sift/report', readonly: false, subpath: `verify/${run}/report`}],
    tmpfs: ['/tmp'], workdir: '/workspace',
    env: {HOME: '/tmp/h', CI: '1', SIFT_TEST_REPORT: `/sift/report/${REPORT_FILE}`, SIFT_TEST_SELECTOR: selector},
    limits: {cpus: 2, memoryMb: 4096, pidsLimit: 512}, cgroupParent: ctx.slice,
  };
  const id = await ctx.create('verifier', sandboxCreateArgs(spec));
  try {
    const inspected = await ctx.docker(['container', 'inspect', id]);
    const [entry] = inspected.code === 0 ? JSON.parse(inspected.stdout) as unknown[] : [];
    const problems = evaluateSandboxInspect(entry, {containerId: id, imageRef: ctx.imageRef, imageId: ctx.imageId,
      networkId: spec.networkId, spec, phase: 'created'}).problems;
    if (problems.length > 0) throw new WorkspaceRefused('verifier_sandbox', problems.join(', '));
    const attached = ctx.attach(['start', '--attach', id]);
    let tail = Buffer.alloc(0);
    attached.stdout.on('data', (chunk: Buffer | string) => {
      tail = Buffer.concat([tail, Buffer.from(chunk)]);
      if (tail.length > MAX_TEST_OUTPUT_BYTES) tail = tail.subarray(tail.length - MAX_TEST_OUTPUT_BYTES);
    });
    const ended = new Promise<void>((resolve) => { attached.stdout.once('end', resolve); attached.stdout.once('close', resolve); });
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const limit = ctx.verifyTimeouts?.testMs ?? TEST_TIMEOUT_MS;
    const exit = await Promise.race([Promise.all([attached.exited, ended]).then(([code]) => code),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), limit); }),
      new Promise<'stopped'>((resolve) => {
        onAbort = () => resolve('stopped');
        if (ctx.signal?.aborted) onAbort();
        else ctx.signal?.addEventListener('abort', onAbort, {once: true});
      })]);
    clearTimeout(timer);
    if (onAbort) ctx.signal?.removeEventListener('abort', onAbort);
    if (exit === null || exit === 'stopped') {
      await ctx.docker(['container', 'kill', '--signal', 'KILL', id]);
      attached.kill();
      throw exit === null ? new WorkspaceRefused('test_timeout', `the ${run} tests ran past ${limit} ms`)
        : new WorkspaceRefused('interrupted', `the attempt stopped while the ${run} tests ran`);
    }
    return {exitCode: exit, output: tail.toString('utf8')};
  } finally {
    const removed = await ctx.docker(['container', 'rm', '--force', id]);
    if (!gone(removed)) ctx.held?.(`container:${id}`);
  }
}

/** The run's report: parsed by the report helper, then read here as data for the verifier log. */
async function readRunReport(ctx: VerifyContext, run: VerifyRun): Promise<{summary: ReportSummary; text: string; sha256: string}> {
  const result = await runHelper(ctx, 'report', helperSpec(ctx, 'report', 'none',
    [{volume: volumeOf(ctx), target: '/report', readonly: true, subpath: `verify/${run}/report`}], {SIFT_REPORT_DIR: '/report'},
    {source: ctx.reportAsset, target: '/sift/junitReport.js'}), helperMs(ctx), REPORT_RESULT_LIMIT);
  let summary: ReportSummary;
  try {
    summary = checkSummary((result as {summary?: unknown}).summary);
  } catch (error) {
    throw new WorkspaceRefused('report_invalid', `the report summary was refused: ${(error as Error).message}`);
  }
  const handle = await fs.open(path.join(ctx.record.mountPoint, 'verify', run, 'report', REPORT_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) throw new WorkspaceRefused('report_invalid', 'the report is not a bounded regular file');
    const bytes = await handle.readFile();
    return {summary, text: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex')};
  } finally {
    await handle.close();
  }
}

/** After the run: no tracked path changed. For the base run, the frozen set is resolved in the same step. */
async function treeCheck(ctx: VerifyContext, run: VerifyRun, treeId: string,
  frozen?: Array<{path: string; source: FrozenSource}>): Promise<FrozenPath[] | undefined> {
  const volume = volumeOf(ctx);
  const result = await runHelper(ctx, 'tree-check', helperSpec(ctx, 'tree-check', 'none', [
    {volume, target: '/workspace', readonly: true, subpath: 'work'},
    {volume, target: '/verify', readonly: true, subpath: `verify/${run}`},
  ], {HOME: '/tmp/h', SIFT_MODE: 'tree-check', SIFT_VERIFY: JSON.stringify({treeId, baseSha: ctx.checkout.baseSha,
    ...(frozen ? {frozen} : {})})}), helperMs(ctx)) as {changed?: unknown; frozen?: unknown};
  if (!Array.isArray(result.changed) || !result.changed.every(isString)) throw new WorkspaceRefused('verify_failed', 'no tree check result');
  if (result.changed.length > 0) throw new WorkspaceRefused('tree_mutated', `tracked paths changed during the run: ${result.changed.join(', ')}`);
  if (!frozen) return undefined;
  const resolved = result.frozen as FrozenPath[] | undefined;
  if (!Array.isArray(resolved) || resolved.length === 0
    || !resolved.every((entry) => isString(entry?.path) && (entry.kind === 'file' || entry.kind === 'dir'))) {
    throw new WorkspaceRefused('frozen_tests_unknown', 'no frozen set from the base tree');
  }
  return resolved.map((entry) => ({path: entry.path, kind: entry.kind}));
}

async function oneRun(ctx: VerifyContext, run: VerifyRun, selector: string, patchSha256?: string,
  frozen?: Array<{path: string; source: FrozenSource}>): Promise<{record: RunRecord; summary: ReportSummary; frozen?: FrozenPath[]}> {
  await checkAttemptVolume(ctx, ctx.record);
  await prepareRunDir(ctx, run);
  const treeId = await checkoutRun(ctx, run, patchSha256);
  const tested = await testRun(ctx, run, selector);
  const report = await readRunReport(ctx, run);
  // Report file attributes join the frozen set only now that the base report exists.
  const frozenFromReport = frozen ? [...frozen, ...report.summary.testcases.flatMap((testcase) =>
    (testcase.file === undefined ? [] : [{path: testcase.file, source: 'report' as const}]))] : undefined;
  const resolved = await treeCheck(ctx, run, treeId, frozenFromReport);
  return {record: {role: run, exitCode: tested.exitCode, treeId, counts: report.summary.counts, reportSha256: report.sha256,
    report: report.text, output: tested.output}, summary: report.summary, ...(resolved ? {frozen: resolved} : {})};
}

const failed = (error: unknown, runs: RunRecord[]): VerifyFailed => (error instanceof VerifyFailed ? error
  : error instanceof WorkspaceRefused ? new VerifyFailed(error.code, error.message, runs)
    : new VerifyFailed('verify_failed', (error as Error).message, runs));

export interface BaseVerification {run: RunRecord; selected: string[]; failing: string[]; frozen: FrozenPath[]}

/** Before the writer: the selected tests on the base must be collected and must fail; the frozen set is fixed. */
export async function verifyBase(ctx: VerifyContext): Promise<BaseVerification> {
  const candidates = [...(ctx.test.files ?? []).map((file) => ({path: file, source: 'files' as const})),
    ...(ctx.test.selector ?? '').split(/\s+/).filter(Boolean).map((token) => ({path: token, source: 'selector' as const}))];
  let record: RunRecord | undefined;
  try {
    const base = await oneRun(ctx, 'base', ctx.test.selector ?? '', undefined, candidates);
    record = base.record;
    const judged = judgeBase(base.record.exitCode, base.summary);
    if (judged.code) throw new VerifyFailed(judged.code, `base: ${JSON.stringify(base.record.counts)}, exit ${base.record.exitCode}`, [base.record]);
    return {run: base.record, selected: judged.selected, failing: judged.failing, frozen: base.frozen ?? []};
  } catch (error) {
    throw failed(error, record ? [record] : []);
  }
}

/**
 * After the patch is frozen: no frozen path changed, then the selected run and the regression run on fresh trees
 * with the patch applied. Without a selector the two are one run, held to both rules. Returns every run.
 */
export async function verifyResult(ctx: VerifyContext, base: BaseVerification, patch: {sha256: string; changed: string[]}): Promise<RunRecord[]> {
  const runs: RunRecord[] = [base.run];
  try {
    const touched = frozenChanges(patch.changed, base.frozen);
    if (touched.length > 0) throw new VerifyFailed('frozen_test_changed', `the patch changes ${touched.join(', ')}`, runs);
    const selected = await oneRun(ctx, 'selected', ctx.test.selector ?? '', patch.sha256);
    runs.push(selected.record);
    const selectedCode = judgeSelected(selected.record.exitCode, selected.summary, base.selected, base.failing)
      ?? (ctx.test.selector ? undefined : judgeRegression(selected.record.exitCode, selected.summary));
    if (selectedCode) throw new VerifyFailed(selectedCode, `selected: ${JSON.stringify(selected.record.counts)}, exit ${selected.record.exitCode}`, runs);
    if (ctx.test.selector) {
      const regression = await oneRun(ctx, 'regression', '', patch.sha256);
      runs.push(regression.record);
      const code = judgeRegression(regression.record.exitCode, regression.summary);
      if (code) throw new VerifyFailed(code, `regression: ${JSON.stringify(regression.record.counts)}, exit ${regression.record.exitCode}`, runs);
    }
    return runs;
  } catch (error) {
    throw failed(error, runs);
  }
}

/** JSON with object keys sorted at every level, so the same content always has the same bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The one verifier log (rev 2, R2): every run with its report, the frozen set and the outcome, written and frozen. */
export async function freezeVerifierLog(outDir: string, input: {runs: RunRecord[]; frozen: FrozenPath[]; outcome: string}): Promise<FrozenArtifact> {
  const content = Buffer.from(`${canonicalJson({version: 1, runs: input.runs, frozen: input.frozen, outcome: input.outcome})}\n`);
  await fs.mkdir(outDir, {recursive: true, mode: 0o755});
  const target = path.join(outDir, VERIFIER_LOG);
  await fs.writeFile(target, content, {mode: 0o600});
  return {kind: 'verifier_log', contentType: VERIFIER_LOG_CONTENT_TYPE, path: target, bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex')};
}

// `sift review` on fixture repositories with the packaged Taster runtime
// (dist/lib/vendor/taster, built by `npm run build`), the real trusted
// pre-pass and a scripted model session in place of codex.

import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ModelClient, ModelRequest, ModelResponse} from '@siftable/taster';
import Review, {reviewExitCode} from '../../commands/review/index.js';
import {createGitExec, findOnPath, childPath, runLocalReview, DEFAULT_BUDGET, type LocalReviewDeps, type ModelSession} from './localReview.js';
import {renderReport, verifyReceipt, evidenceOutcome, type Receipt} from './receipt.js';
import {loadTasterRuntime} from './runtime.js';

const runtime = loadTasterRuntime();
const gitBin = findOnPath('git') ?? '/usr/bin/git';
const path = childPath([gitBin]);

const PAGING_BASE = [
  'export function pages(rows: number[], size: number): number[][] {',
  '  const out: number[][] = [];',
  '  for (let i = 0; i < rows.length; i += size) {',
  '    out.push(rows.slice(i, i + size));',
  '  }',
  '  return out;',
  '}',
  '',
].join('\n');
const PAGING_HEAD = PAGING_BASE.replace('i < rows.length;', 'i < rows.length - size;');

let root: string;
let base: string;
let head: string;

function git(...args: string[]): string {
  return execFileSync(gitBin, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: path,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trim();
}

function commit(files: Record<string, string>, message: string): string {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), {recursive: true});
    writeFileSync(join(root, rel), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sift-review-fixture-'));
  git('init', '-q', '-b', 'main');
  base = commit({'src/paging.ts': PAGING_BASE, 'README.md': '# demo\n'}, 'base');
  git('checkout', '-q', '-b', 'feature');
  head = commit({'src/paging.ts': PAGING_HEAD}, 'drop the last page');
});

afterEach(() => {
  rmSync(root, {recursive: true, force: true});
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

type Handler = (request: ModelRequest) => Promise<unknown>;

class ScriptedModels implements ModelClient {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly handlers: Partial<Record<ModelRequest['role'], Handler>>) {}
  async run(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const handler = this.handlers[request.role];
    if (!handler) throw Object.assign(new Error('no handler'), {code: 'turn_failed'});
    return {output: await handler(request), model: 'scripted-sol'};
  }
}

async function readId(request: ModelRequest, file: string, start?: number, end?: number): Promise<string> {
  const args: Record<string, unknown> = {path: file};
  if (start !== undefined) args.start = start;
  if (end !== undefined) args.end = end;
  const result = await request.toolHost.call({tool: 'read_file', args});
  if (!result.ok) throw new Error(`read failed: ${result.error}`);
  return result.evidenceId;
}

const bugFinder: Handler = async request => {
  const id = await readId(request, 'src/paging.ts', 1, 7);
  return {
    findings: [{
      title: '[P1] Last page is dropped',
      body: 'The loop bound `rows.length - size` skips the final page whenever rows remain after the last full page.',
      priority: 1,
      confidence: 0.9,
      location: {path: 'src/paging.ts', start: 3, end: 3, side: 'RIGHT'},
      evidenceIds: [id],
    }],
  };
};

const quietFinder: Handler = async request => {
  await readId(request, 'src/paging.ts');
  return {findings: []};
};

/** Answers without reading anything: coverage is not proven. */
const blindFinder: Handler = async () => ({findings: []});

const confirmingValidator: Handler = async request => ({
  outcome: 'confirmed',
  rationale: 'Bound excludes the tail.',
  evidenceIds: [await readId(request, 'src/paging.ts', 1, 7)],
});

function deps(models: ModelClient, sessionProblems: string[] = []): LocalReviewDeps {
  return {
    runtime,
    gitBin,
    path,
    git: createGitExec({gitBin, path, home: tmpdir()}),
    modelSession: async (): Promise<ModelSession> => ({models, close: async () => undefined, problems: () => sessionProblems}),
  };
}

const options = (over: Partial<Parameters<typeof runLocalReview>[0]> = {}) => ({
  cwd: root,
  model: 'scripted-sol',
  finderPasses: 2 as const,
  budget: {...DEFAULT_BUDGET, callTimeoutMs: 10_000},
  ...over,
});

describe('sift review local runs', () => {
  it('prints a confirmed finding and a complete receipt bound to revision and policy', async () => {
    const models = new ScriptedModels({finder: bugFinder, validator: confirmingValidator});
    const {receipt, result} = await runLocalReview(options(), deps(models));

    expect(receipt.completion).toBe('complete');
    expect(receipt.status).toBe('findings');
    expect(receipt.revision).toEqual({head, base, mergeBase: base, baseRef: 'main', worktreeDirty: false});
    const policy = runtime.loadDefaultPolicyBundle();
    expect(receipt.policy).toEqual({name: policy.name, revision: policy.revisionId});
    expect(receipt.verdict).toMatchObject({kind: 'complete', blocking: 1, advisory: 0, filesInScope: 1, filesReviewed: 1});
    expect(receipt.findings).toEqual([expect.objectContaining({priority: 1, path: 'src/paging.ts', start: 3, end: 3})]);
    expect(verifyReceipt(receipt)).toBe(true);
    expect(evidenceOutcome(receipt)).toBe('failed');
    expect(reviewExitCode(receipt)).toBe(1);
    // The real pre-pass ran from the packaged copy and every trusted tool reported.
    expect(receipt.problems).toEqual([]);
    expect(result?.verdict.kind === 'complete' && result.verdict.coverage.stages.prepass).toBe('complete');

    const text = renderReport(receipt, result);
    expect(text).toContain('[P1] Last page is dropped');
    expect(text).not.toContain('[P1] [P1]');
    expect(text).toContain('src/paging.ts:3');
    expect(text).toContain('COMPLETE: findings reported');
    expect(text).toContain(`policy default ${policy.revisionId}`);
    expect(text).toContain(`digest ${receipt.digest}`);
  });

  it('reports a complete review with no findings as clean', async () => {
    const {receipt} = await runLocalReview(options(), deps(new ScriptedModels({finder: quietFinder, validator: confirmingValidator})));
    expect(receipt).toMatchObject({status: 'clean', completion: 'complete', findings: []});
    expect(evidenceOutcome(receipt)).toBe('passed');
    expect(reviewExitCode(receipt)).toBe(0);
  });

  it('prints a review without proven coverage as incomplete, never clean', async () => {
    const {receipt, result} = await runLocalReview(options(), deps(new ScriptedModels({finder: blindFinder, validator: confirmingValidator})));
    expect(result?.findings).toEqual([]);
    expect(receipt.completion).toBe('incomplete');
    expect(receipt.status).toBe('incomplete');
    expect(receipt.verdict.reason).toBeTruthy();
    expect(evidenceOutcome(receipt)).toBe('error');
    expect(reviewExitCode(receipt)).toBe(2);
    const text = renderReport(receipt, result ?? null);
    expect(text).toContain('INCOMPLETE: this is not a clean review');
    expect(text).not.toContain('COMPLETE: no findings');
  });

  it('keeps the verdict incomplete when model calls fail, and explains why', async () => {
    const failing = new ScriptedModels({});
    const {receipt} = await runLocalReview(options(), deps(failing, ['model call failed (finder turn_failed) x2']));
    expect(receipt.status).toBe('incomplete');
    expect(receipt.problems).toContain('model call failed (finder turn_failed) x2');
  });

  it('keeps the verdict incomplete when the trusted pre-pass cannot run', async () => {
    const broken = {...runtime, runTrustedPrepass: () => {
      throw new Error('typescript is not installed');
    }};
    const {receipt} = await runLocalReview(options(), {...deps(new ScriptedModels({finder: quietFinder, validator: confirmingValidator})), runtime: broken});
    expect(receipt.status).toBe('incomplete');
    expect(receipt.verdict.stages).toMatchObject({prepass: 'failed'});
    expect(receipt.problems[0]).toContain('pre-pass did not run');
  });

  it('turns a runtime error into a failed receipt, not a clean one', async () => {
    const throwing = {...runtime, review: async () => {
      throw new Error('engine exploded');
    }};
    const {receipt, result} = await runLocalReview(options(), {...deps(new ScriptedModels({})), runtime: throwing});
    expect(result).toBeNull();
    expect(receipt).toMatchObject({status: 'failed', completion: 'failed'});
    expect(reviewExitCode(receipt)).toBe(2);
    expect(verifyReceipt(receipt)).toBe(true);
  });

  it('records uncommitted changes and detects a tampered receipt', async () => {
    writeFileSync(join(root, 'src/paging.ts'), `${PAGING_HEAD}// local edit\n`);
    const {receipt} = await runLocalReview(options(), deps(new ScriptedModels({finder: quietFinder, validator: confirmingValidator})));
    expect(receipt.revision.worktreeDirty).toBe(true);
    expect(renderReport(receipt, null)).toContain('only the committed head was reviewed');
    const tampered: Receipt = {...receipt, status: 'clean', completion: 'complete'};
    tampered.verdict = {...receipt.verdict};
    expect(verifyReceipt({...receipt})).toBe(true);
    expect(verifyReceipt({...tampered, revision: {...receipt.revision, head: base}})).toBe(false);
  });

  it('rejects a base ref that does not exist with a recovery hint', async () => {
    await expect(runLocalReview(options({baseRef: 'origin/nope'}), deps(new ScriptedModels({})))).rejects.toThrow(/--base origin\/nope does not name a commit/u);
  });
});

describe('sift review command', () => {
  function command(models: ModelClient, flags: Record<string, unknown> = {}) {
    const instance = Object.create(Review.prototype) as Review;
    const logs: string[] = [];
    (instance as any).parse = vi.fn().mockResolvedValue({flags: {model: 'scripted-sol', 'finder-passes': 2, 'max-model-calls': 40, concurrency: 2, 'max-files': 60, ...flags}});
    (instance as any).loadDeps = () => deps(models);
    (instance as any).log = (line: string) => logs.push(line);
    return {instance, logs};
  }

  it('prints findings and the receipt, writes the receipt file and sets exit status 1 for blocking findings', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const receiptPath = join(root, '..', `${root.split('/').pop()}-receipt.json`);
    const {instance, logs} = command(new ScriptedModels({finder: bugFinder, validator: confirmingValidator}), {receipt: receiptPath});
    (instance as any).jsonEnabled = () => false;
    const output = await instance.run() as {receipt: Receipt; evidence: {outcome: string}};
    expect(output.receipt.status).toBe('findings');
    expect(output.evidence.outcome).toBe('failed');
    expect(process.exitCode).toBe(1);
    const printed = logs.join('\n');
    expect(printed).toContain('[P1] Last page is dropped');
    expect(printed).toContain('Receipt');
    const written = JSON.parse(execFileSync('cat', [receiptPath], {encoding: 'utf8'})) as Receipt;
    expect(written).toEqual(output.receipt);
    expect(verifyReceipt(written)).toBe(true);
    rmSync(receiptPath, {force: true});
  });

  it('returns an incomplete receipt in JSON mode with exit status 2', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const {instance, logs} = command(new ScriptedModels({finder: blindFinder, validator: confirmingValidator}));
    (instance as any).jsonEnabled = () => true;
    const output = await instance.run() as {receipt: Receipt; evidence: {outcome: string; exitCode: number}};
    expect(output.receipt.status).toBe('incomplete');
    expect(output.evidence).toEqual({outcome: 'error', exitCode: 2});
    expect(process.exitCode).toBe(2);
    expect(logs).toEqual([]);
  });
});

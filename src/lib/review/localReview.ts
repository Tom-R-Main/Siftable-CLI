// One local review: resolve the revisions, run the trusted pre-pass, run the
// engine with codexClient through the user's own Codex login (mode `local`),
// and build the receipt (docs/architecture/taster-review.md section 9).
//
// Every way a run can fall short ends in an incomplete or failed receipt; a
// clean status is possible only from a complete engine verdict.

import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, dirname, isAbsolute, join} from 'node:path';
import {existsSync} from 'node:fs';
import type {ModelClient, ReviewBudget, ReviewResult, Verdict} from '@siftable/taster';
import {buildReceipt, failedVerdict, type Receipt} from './receipt.js';
import {createGitExec, loopbackMcpEndpoint, processRunner} from './ports.js';
import type {GitExec, TasterRuntime} from './runtime.js';

export const DEFAULT_MODEL = 'gpt-6.1-sol';
export const DEFAULT_BUDGET: ReviewBudget = {maxModelCalls: 40, concurrency: 2, callTimeoutMs: 900_000, maxFiles: 60};

export interface LocalReviewOptions {
  /** Any directory inside the checkout to review. */
  cwd: string;
  /** Base ref; default: origin/main, then main. */
  baseRef?: string;
  model: string;
  finderPasses: 2 | 3;
  budget: ReviewBudget;
}

export interface ModelSession {
  models: ModelClient;
  close(): Promise<void>;
  /** Diagnostics appended to the receipt's problems on a non-clean result. */
  problems(): string[];
}

/** Creates the model client for a checkout; the real one runs codex through the login relay. */
export type ModelSessionFactory = (context: {checkoutRoot: string; workDir: string}) => Promise<ModelSession>;

export interface LocalReviewDeps {
  runtime: TasterRuntime;
  git: GitExec;
  /** Absolute git binary, for revision resolution outside the engine. */
  gitBin: string;
  /** PATH for git and the trusted pre-pass. */
  path: string;
  modelSession: ModelSessionFactory;
  now?: () => Date;
}

export interface LocalReviewOutcome {
  receipt: Receipt;
  result: ReviewResult | null;
}

export class LocalReviewSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalReviewSetupError';
  }
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** git with the user's own repository configuration, for resolving refs only. */
async function gitText(deps: LocalReviewDeps, cwd: string, args: string[], env: Record<string, string> = {}): Promise<{code: number; text: string}> {
  const result = await deps.git(['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd,
    env: {GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...env},
    maxBytes: 4 * 1024 * 1024,
  });
  return {code: result.code, text: result.stdout.toString('utf8').trim()};
}

async function resolveCommit(deps: LocalReviewDeps, root: string, ref: string): Promise<string | null> {
  if (ref.startsWith('-')) return null;
  const result = await gitText(deps, root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  return result.code === 0 && OBJECT_ID.test(result.text) ? result.text : null;
}

export interface Revisions {
  root: string;
  head: string;
  base: string;
  baseRef: string;
  mergeBase: string;
  worktreeDirty: boolean;
}

export async function resolveRevisions(deps: LocalReviewDeps, cwd: string, baseRef?: string): Promise<Revisions> {
  const top = await gitText(deps, cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.text) throw new LocalReviewSetupError(`${cwd} is not inside a git checkout.`);
  const root = await realpath(top.text);
  const head = await resolveCommit(deps, root, 'HEAD');
  if (!head) throw new LocalReviewSetupError('HEAD does not name a commit; commit your change before running sift review.');
  const candidates = baseRef ? [baseRef] : ['origin/main', 'main'];
  let base: string | null = null;
  let chosen = candidates[0] ?? 'main';
  for (const candidate of candidates) {
    base = await resolveCommit(deps, root, candidate);
    if (base) {
      chosen = candidate;
      break;
    }
  }
  if (!base) {
    throw new LocalReviewSetupError(baseRef
      ? `--base ${baseRef} does not name a commit in this checkout. Fetch it first (git fetch origin) or pass another ref.`
      : 'Neither origin/main nor main exists in this checkout. Pass --base <ref>.');
  }
  const mergeBase = await gitText(deps, root, ['merge-base', base, head]);
  if (mergeBase.code !== 0 || !OBJECT_ID.test(mergeBase.text)) {
    throw new LocalReviewSetupError(`${chosen} and HEAD have no merge base; fetch more history or pass another --base.`);
  }
  const status = await gitText(deps, root, ['status', '--porcelain', '--untracked-files=no']);
  return {root, head, base, baseRef: chosen, mergeBase: mergeBase.text, worktreeDirty: status.code !== 0 || status.text.length > 0};
}

/** Bytes of the changed-file list as the engine renders it, for the prompt budget. */
async function changedFileListBytes(deps: LocalReviewDeps, root: string, from: string, to: string): Promise<number | null> {
  const result = await deps.git(['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', from, to], {
    cwd: root,
    env: {...deps.runtime.GIT_ENV},
    maxBytes: 16 * 1024 * 1024,
  });
  if (result.code !== 0 || result.truncated) return null;
  return deps.runtime.fileListBytes(result.stdout.toString('utf8'));
}

export async function runLocalReview(options: LocalReviewOptions, deps: LocalReviewDeps): Promise<LocalReviewOutcome> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const revisions = await resolveRevisions(deps, options.cwd, options.baseRef);
  const policy = deps.runtime.loadDefaultPolicyBundle();
  const problems: string[] = [];

  const finish = (verdict: Verdict, result: ReviewResult | null): LocalReviewOutcome => ({
    receipt: buildReceipt({
      head: revisions.head,
      base: revisions.base,
      mergeBase: revisions.mergeBase,
      baseRef: revisions.baseRef,
      worktreeDirty: revisions.worktreeDirty,
      policy: {name: policy.name, revision: policy.revisionId},
      model: options.model,
      finderPasses: options.finderPasses,
      problems,
      startedAt,
      finishedAt: now(),
    }, verdict, result?.findings ?? []),
    result,
  });

  // Trusted pre-pass from the CLI's own copy of the tools, never from the checkout.
  let reports: unknown[] = [];
  try {
    const prepass = deps.runtime.runTrustedPrepass({
      repo: revisions.root,
      baseSha: revisions.base,
      mergeBase: revisions.mergeBase,
      head: revisions.head,
      ratchetGrowth: deps.runtime.ratchetGrowthScript,
      envPath: deps.path,
    });
    reports = prepass.reports;
    problems.push(...prepass.problems.map(problem => `pre-pass: ${problem}`));
  } catch (error) {
    // No reports: the engine marks the pre-pass failed and the verdict incomplete.
    problems.push(`pre-pass did not run: ${String((error as Error).message).slice(0, 200)}`);
  }

  const fileList = await changedFileListBytes(deps, revisions.root, revisions.mergeBase, revisions.head);
  if (fileList === null) {
    problems.push('changed files could not be listed');
    return finish(failedVerdict(revisions.head, 'changed files could not be listed'), null);
  }
  const maxDiffBytes = deps.runtime.diffAllowance({
    fileListBytes: fileList,
    checkpointListBytes: 0,
    summaryBytes: deps.runtime.summaryBytes(reports),
    prTextBytes: 0,
    trustedBytes: Buffer.byteLength(policy.prompts.finder.text) + Buffer.byteLength(policy.rubric.text) + Buffer.byteLength(JSON.stringify(policy.rules)),
  });

  const workDir = await mkdtemp(join(tmpdir(), 'sift-review-'));
  let session: ModelSession | undefined;
  try {
    session = await deps.modelSession({checkoutRoot: revisions.root, workDir});
    const result = await deps.runtime.review({
      checkout: {
        root: revisions.root,
        base: {sha: revisions.base, mergeBase: revisions.mergeBase},
        head: {sha: revisions.head},
        focus: {kind: 'full'},
      },
      policy,
      prior: [],
      evidence: {reports},
      models: session.models,
      budget: options.budget,
      mode: 'local',
      git: deps.git,
      finderPasses: options.finderPasses,
      limits: {maxDiffBytes},
    });
    if (result.verdict.kind !== 'complete') problems.push(...session.problems());
    return finish(result.verdict, result);
  } catch (error) {
    const reason = `review runtime error: ${String((error as Error).message).slice(0, 200)}`;
    problems.push(reason);
    if (session) problems.push(...session.problems());
    return finish(failedVerdict(revisions.head, reason), null);
  } finally {
    await session?.close().catch(() => undefined);
    await rm(workDir, {recursive: true, force: true, maxRetries: 3}).catch(() => undefined);
  }
}

/** First executable named `name` on PATH, as an absolute path. */
export function findOnPath(name: string, pathValue = process.env.PATH ?? ''): string | null {
  for (const entry of pathValue.split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    const candidate = join(entry, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** PATH for child processes: the binaries' own directories, node, then the system. */
export function childPath(binaries: string[]): string {
  const dirs = [...binaries.map(bin => dirname(bin)), dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];
  return [...new Set(dirs.filter(dir => isAbsolute(dir)))].join(':');
}

export {createGitExec, loopbackMcpEndpoint, processRunner};

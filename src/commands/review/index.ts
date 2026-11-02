import {Flags} from '@oclif/core';
import {realpathSync, rmSync, statSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {BaseCommand} from '../../lib/base-command.js';
import {codexSessionFactory} from '../../lib/review/codexSession.js';
import {
  childPath, cleanupInterruptedReview, createGitExec, DEFAULT_BUDGET, DEFAULT_MODEL,
  findOnPath, LocalReviewSetupError, runLocalReview,
  type LocalReviewDeps, type LocalReviewOutcome,
} from '../../lib/review/localReview.js';
import {buildReceipt, evidenceOutcome, failedVerdict, renderReport, type Receipt, type ReceiptContext} from '../../lib/review/receipt.js';
import {buildReviewReport, fingerprintReviewRuntime, writeReviewReport, type ReviewReportMetadata} from '../../lib/review/report.js';
import {writeAtomicJson, type ReviewAttempt} from '../../lib/review/lifecycle.js';
import {preflightCodex} from '../../lib/review/preflight.js';
import {loadTasterRuntime, vendoredRuntimeRoot} from '../../lib/review/runtime.js';

export const DEFAULT_REVIEW_DEADLINE_MS = 1_800_000;

/** Exit status: 0 clean or advisory-only, 1 blocking findings, 2 incomplete, skipped or failed. */
export function reviewExitCode(receipt: Receipt): number {
  if (receipt.status === 'clean') return 0;
  if (receipt.status === 'findings') return receipt.verdict.blocking > 0 ? 1 : 0;
  return 2;
}

export function validateWorkspaceFlag(workspace?: string): void {
  if (workspace && (isAbsolute(workspace) || /^[.~]|[/\\]/u.test(workspace))) {
    throw new LocalReviewSetupError('--workspace selects an organization, not a checkout. Use --repo <path> to choose the repository to review.');
  }
}

export function canonicalOutputPath(path: string): string {
  const absolute = resolve(path);
  return join(realpathSync(dirname(absolute)), basename(absolute));
}

export default class Review extends BaseCommand {
  private runtimeIdentity?: ReviewReportMetadata['runtime'];
  static description = [
    'Review committed changes with Taster before opening a pull request.',
    'Runs locally through your Codex login. --repo selects the checkout; --expected-head asserts its full commit ID.',
    'Only committed changes are reviewed. An incomplete review is never reported as clean.',
    '--receipt also saves a full companion report and a durable attempt record, including failures and interruptions.',
    'Exit status: 0 clean or advisory findings only, 1 blocking (P0-P1) findings, 2 incomplete, skipped or failed.',
  ].join('\n');

  static examples = [
    '<%= config.bin %> review',
    '<%= config.bin %> review --repo /path/to/checkout --expected-head <full-sha> --base origin/main --receipt /tmp/taster-receipt.json',
    '<%= config.bin %> review --report /tmp/taster-report.json --json --no-input',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    repo: Flags.string({description: 'Repository checkout to review (default: current directory)'}),
    'expected-head': Flags.string({description: 'Require this full committed HEAD before starting review'}),
    base: Flags.string({description: 'Base ref to review against (default: origin/main, then main)'}),
    model: Flags.string({description: 'Model for finders and validators', default: DEFAULT_MODEL}),
    'codex-bin': Flags.string({description: 'Absolute path of the Codex binary (default: codex on PATH)'}),
    'finder-passes': Flags.integer({description: 'Finder passes with different file orderings (2 or 3)', default: 2, min: 2, max: 3}),
    'max-model-calls': Flags.integer({description: 'Model call ceiling for the whole review', default: DEFAULT_BUDGET.maxModelCalls, min: 1, max: 200}),
    concurrency: Flags.integer({description: 'Concurrent Codex runs', default: DEFAULT_BUDGET.concurrency, min: 1, max: 4}),
    'max-files': Flags.integer({description: 'Changed files to review; more are skipped and the review is incomplete', default: DEFAULT_BUDGET.maxFiles, min: 1, max: 300}),
    'deadline-ms': Flags.integer({description: 'Whole-review deadline, including setup and pre-pass, in milliseconds', default: DEFAULT_REVIEW_DEADLINE_MS, min: 1, max: 86_400_000}),
    receipt: Flags.string({description: 'Write the revision-bound receipt, plus <path>.report.json and <path>.attempt.json'}),
    report: Flags.string({description: 'Write the full review report to this path (overrides the companion report path)'}),
  };

  /** Seams for tests. */
  protected loadDeps(flags: {model: string; 'codex-bin'?: string; concurrency: number}): LocalReviewDeps {
    const runtimeRoot = vendoredRuntimeRoot();
    const runtime = loadTasterRuntime(runtimeRoot);
    if (runtimeRoot) this.runtimeIdentity = fingerprintReviewRuntime(runtimeRoot);
    const gitBin = findOnPath('git') ?? '/usr/bin/git';
    if (flags['codex-bin'] !== undefined && !isAbsolute(flags['codex-bin'])) throw new LocalReviewSetupError('--codex-bin must be an absolute path.');
    const codexBin = flags['codex-bin'] ?? findOnPath('codex');
    if (!codexBin) throw new LocalReviewSetupError('codex was not found on PATH. Install the Codex CLI or pass --codex-bin <absolute path>.');
    const path = childPath([gitBin, codexBin]);
    const deps: LocalReviewDeps = {
      runtime, gitBin, path,
      identity: {codexBin},
      git: createGitExec({gitBin, path, home: tmpdir()}),
      modelSession: context => codexSessionFactory({runtime, codexBin: deps.identity?.codexBin ?? codexBin, model: flags.model, path, concurrency: flags.concurrency, callTimeoutMs: DEFAULT_BUDGET.callTimeoutMs})(context),
      preflight: async signal => {
        const identity = await preflightCodex({codexBin, path, ...(signal ? {signal} : {})});
        deps.identity = identity;
        return identity;
      },
    };
    return deps;
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Review);
    const repository = resolve(flags.repo ?? process.cwd());
    const outputPath = (value: string): string => {
      try { return canonicalOutputPath(value); } catch (error) { this.error(`Cannot resolve review output path: ${String((error as Error).message)}`, {exit: 2}); }
    };
    const receiptPath = flags.receipt ? outputPath(flags.receipt) : undefined;
    const reportPath = flags.report ? outputPath(flags.report) : receiptPath ? `${receiptPath}.report.json` : undefined;
    const attemptPath = receiptPath ? `${receiptPath}.attempt.json` : reportPath ? `${reportPath}.attempt.json` : undefined;
    const outputPaths = [receiptPath, reportPath, attemptPath].filter((p): p is string => p !== undefined);
    if (new Set(outputPaths).size !== outputPaths.length) this.error('Receipt, report and attempt paths must be distinct.', {exit: 2});
    for (const path of outputPaths) {
      try {
        if (statSync(path).isDirectory()) throw new LocalReviewSetupError(`Review output path is a directory: ${path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.error(String((error as Error).message), {exit: 2});
      }
    }
    const attempt: ReviewAttempt = {
      format: 'taster.local-attempt/v1', status: 'running',
      requested: {repository, expectedHead: flags['expected-head'] ?? null, baseRef: flags.base ?? null},
      revision: null, runtime: null, startedAt: new Date().toISOString(), finishedAt: null, reason: null, receiptDigest: null,
    };
    const persistAttempt = () => { if (attemptPath) writeAtomicJson(attemptPath, attempt); };
    try { persistAttempt(); } catch (error) { this.error(`Cannot write review attempt: ${String((error as Error).message)}`, {exit: 2}); }
    const controller = new AbortController();
    const deadlineMs = flags['deadline-ms'] ?? DEFAULT_REVIEW_DEADLINE_MS;
    const budget = {maxModelCalls: flags['max-model-calls'], concurrency: flags.concurrency, callTimeoutMs: DEFAULT_BUDGET.callTimeoutMs, maxFiles: flags['max-files']};
    let deps: LocalReviewDeps | undefined;
    let context: ReceiptContext | undefined;
    let outcome: LocalReviewOutcome | undefined;
    let terminal = false;
    let timedOut = false;
    const persistOutcome = (value: LocalReviewOutcome) => {
      if (reportPath) writeReviewReport(reportPath, buildReviewReport({receipt: value.receipt, result: value.result, metadata: {
        repositoryRoot: attempt.revision?.root ?? repository,
        cliVersion: this.config?.version ?? 'unknown',
        ...(deps?.identity ?? {}), ...(this.runtimeIdentity ? {runtime: this.runtimeIdentity} : {}), budget, deadlineMs,
      }}));
      if (receiptPath) writeAtomicJson(receiptPath, value.receipt);
      attempt.receiptDigest = value.receipt.digest;
    };
    const failureOutcome = (reason: string): LocalReviewOutcome | undefined => context ? {
      receipt: buildReceipt({...context, problems: [...context.problems, reason], finishedAt: new Date()}, failedVerdict(context.head, reason), []), result: null,
    } : undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Whole-review deadline exceeded (${deadlineMs} ms)`));
      cleanupInterruptedReview();
    }, deadlineMs);
    const interrupted = (signal: NodeJS.Signals) => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timer);
      const reason = `Review interrupted (${signal})`;
      controller.abort(new Error(reason));
      try {
        outcome = failureOutcome(reason);
        if (outcome) {
          try { persistOutcome(outcome); } catch { process.stderr.write('Could not persist the interrupted review artifacts.\n'); }
        }
        attempt.status = 'interrupted'; attempt.reason = reason; attempt.finishedAt = new Date().toISOString();
        attempt.runtime = deps?.identity ?? null;
        try { persistAttempt(); } catch { process.stderr.write('Could not persist the interrupted attempt.\n'); }
      } finally {
        cleanupInterruptedReview();
      }
      process.stderr.write(`sift review interrupted (${signal}); ${attemptPath ? `attempt recorded at ${attemptPath}` : 'no output path requested'}.\n`);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
    try {
      // These requested outputs belong to this attempt, never a previous clean run.
      if (receiptPath) rmSync(receiptPath, {force: true});
      if (reportPath) rmSync(reportPath, {force: true});
      validateWorkspaceFlag(flags.workspace);
      deps = this.loadDeps(flags);
      const preflight = deps.preflight;
      if (preflight) deps.preflight = async signal => {
        const identity = await preflight(signal);
        attempt.runtime = identity; persistAttempt();
        return identity;
      };
      outcome = await runLocalReview({
        cwd: repository,
        ...(flags['expected-head'] ? {expectedHead: flags['expected-head']} : {}),
        ...(flags.base ? {baseRef: flags.base} : {}),
        model: flags.model, finderPasses: flags['finder-passes'] === 3 ? 3 : 2, budget, signal: controller.signal,
        onResolved: (revisions, receiptContext) => { attempt.revision = revisions; context = receiptContext; persistAttempt(); },
      }, deps);
      if (controller.signal.aborted) outcome = failureOutcome(String((controller.signal.reason as Error).message));
      if (!outcome) throw new Error('Review ended without an outcome');
      persistOutcome(outcome);
      attempt.status = timedOut ? 'timed_out' : outcome.receipt.completion === 'complete' ? 'completed' : 'failed';
      attempt.reason = timedOut ? `Whole-review deadline exceeded (${deadlineMs} ms)` : outcome.receipt.verdict.reason;
      attempt.runtime = deps.identity ?? null;
      attempt.finishedAt = new Date().toISOString();
      persistAttempt();
      terminal = true;
    } catch (error) {
      if (!terminal) {
        const reason = String((error as Error).message).slice(0, 500);
        outcome = failureOutcome(reason);
        let artifactError: unknown;
        if (outcome) {
          try { persistOutcome(outcome); } catch (writeError) { artifactError = writeError; }
        }
        attempt.status = timedOut ? 'timed_out' : 'failed'; attempt.reason = reason;
        attempt.runtime = deps?.identity ?? null; attempt.finishedAt = new Date().toISOString();
        persistAttempt();
        terminal = true;
        if (artifactError) this.error('Could not persist the requested review artifacts; the failed attempt was recorded.', {exit: 2});
      }
      if (!outcome) {
        this.error(String((error as Error).message), {exit: 2});
      }
    } finally {
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupted);
      process.removeListener('SIGTERM', interrupted);
    }
    const {receipt} = outcome;
    process.exitCode = reviewExitCode(receipt);
    if (!this.jsonEnabled()) {
      this.log(renderReport(receipt, outcome.result));
      if (receiptPath) this.log(`  written to ${receiptPath}`);
      if (reportPath) this.log(`  full report written to ${reportPath}`);
    }
    return {receipt, evidence: {outcome: evidenceOutcome(receipt), exitCode: reviewExitCode(receipt)}, findings: outcome.result?.findings ?? []};
  }
}

import {Flags} from '@oclif/core';
import {writeFileSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {BaseCommand} from '../../lib/base-command.js';
import {CodexLoginError} from '../../lib/review/codexLoginRelay.js';
import {codexSessionFactory} from '../../lib/review/codexSession.js';
import {
  childPath,
  createGitExec,
  DEFAULT_BUDGET,
  DEFAULT_MODEL,
  findOnPath,
  LocalReviewSetupError,
  runLocalReview,
  type LocalReviewDeps,
  type LocalReviewOutcome,
} from '../../lib/review/localReview.js';
import {evidenceOutcome, renderReport, type Receipt} from '../../lib/review/receipt.js';
import {loadTasterRuntime} from '../../lib/review/runtime.js';

/** Exit status: 0 clean or advisory-only, 1 blocking findings, 2 incomplete, skipped or failed. */
export function reviewExitCode(receipt: Receipt): number {
  if (receipt.status === 'clean') return 0;
  if (receipt.status === 'findings') return receipt.verdict.blocking > 0 ? 1 : 0;
  return 2;
}

export default class Review extends BaseCommand {
  static description = [
    'Review the committed changes of this checkout with Taster before opening a pull request.',
    'Runs the Taster engine locally (mode local) through your own Codex login and prints confirmed findings',
    'plus a receipt bound to the reviewed revision, the trusted policy revision and the completion state.',
    'An incomplete review is reported as incomplete, never as clean. Uncommitted changes are not reviewed.',
    'Exit status: 0 clean or advisory findings only, 1 blocking (P0-P1) findings, 2 incomplete, skipped or failed.',
  ].join('\n');

  static examples = [
    '<%= config.bin %> review',
    '<%= config.bin %> review --base origin/main --receipt /tmp/taster-receipt.json',
    '<%= config.bin %> review --json --no-input > /tmp/taster-review.json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    base: Flags.string({description: 'Base ref to review against (default: origin/main, then main)'}),
    model: Flags.string({description: 'Model for finders and validators', default: DEFAULT_MODEL}),
    'codex-bin': Flags.string({description: 'Absolute path of the codex binary (default: codex on PATH)'}),
    'finder-passes': Flags.integer({description: 'Finder passes with different file orderings (2 or 3)', default: 2, min: 2, max: 3}),
    'max-model-calls': Flags.integer({description: 'Model call ceiling for the whole review', default: DEFAULT_BUDGET.maxModelCalls, min: 1, max: 200}),
    concurrency: Flags.integer({description: 'Concurrent codex runs', default: DEFAULT_BUDGET.concurrency, min: 1, max: 4}),
    'max-files': Flags.integer({description: 'Changed files to review; more are skipped and the review is incomplete', default: DEFAULT_BUDGET.maxFiles, min: 1, max: 300}),
    receipt: Flags.string({description: 'Also write the receipt JSON to this path (attach it as Sift verification evidence)'}),
  };

  /** Seams for tests. */
  protected loadDeps(flags: {model: string; 'codex-bin'?: string; concurrency: number}): LocalReviewDeps {
    const runtime = loadTasterRuntime();
    const gitBin = findOnPath('git') ?? '/usr/bin/git';
    const codexBin = flags['codex-bin'] ?? findOnPath('codex');
    if (!codexBin || !isAbsolute(codexBin)) {
      throw new LocalReviewSetupError('codex was not found on PATH. Install the Codex CLI or pass --codex-bin <absolute path>.');
    }
    const path = childPath([gitBin, codexBin]);
    return {
      runtime,
      gitBin,
      path,
      git: createGitExec({gitBin, path, home: tmpdir()}),
      modelSession: codexSessionFactory({
        runtime,
        codexBin,
        model: flags.model,
        path,
        concurrency: flags.concurrency,
        callTimeoutMs: DEFAULT_BUDGET.callTimeoutMs,
      }),
    };
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Review);
    let outcome: LocalReviewOutcome;
    try {
      const deps = this.loadDeps(flags);
      outcome = await runLocalReview({
        cwd: process.cwd(),
        baseRef: flags.base,
        model: flags.model,
        finderPasses: flags['finder-passes'] === 3 ? 3 : 2,
        budget: {
          maxModelCalls: flags['max-model-calls'],
          concurrency: flags.concurrency,
          callTimeoutMs: DEFAULT_BUDGET.callTimeoutMs,
          maxFiles: flags['max-files'],
        },
      }, deps);
    } catch (error) {
      if (error instanceof LocalReviewSetupError || error instanceof CodexLoginError) this.error(error.message, {exit: 2});
      throw error;
    }

    const {receipt} = outcome;
    if (flags.receipt) {
      writeFileSync(resolve(flags.receipt), `${JSON.stringify(receipt, null, 2)}\n`, {mode: 0o600});
    }
    process.exitCode = reviewExitCode(receipt);
    if (!this.jsonEnabled()) {
      this.log(renderReport(receipt, outcome.result));
      if (flags.receipt) this.log(`  written to ${resolve(flags.receipt)}`);
    }
    return {
      receipt,
      evidence: {outcome: evidenceOutcome(receipt), exitCode: reviewExitCode(receipt)},
      findings: outcome.result?.findings ?? [],
    };
  }
}

import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class WorkVerify extends BaseCommand {
  static description =
    'Deprecated compatibility command. Hosted LLM verification is retired; use verification-command evidence.';

  static args = {
    id: Args.string({description: 'Work item ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    reps: Flags.integer({description: 'Deprecated; ignored because hosted verification is retired'}),
    model: Flags.string({description: 'Deprecated; ignored because hosted verification is retired'}),
    history: Flags.boolean({description: 'List historical verifier runs recorded before retirement'}),
  };

  private formatRun(run: Record<string, any>): void {
    this.log(`Verdict: ${run.verdict}  (aggregate ${Number(run.aggregateScore).toFixed(3)}, model ${run.verifierModel}, K=${run.repetitions})`);
    if (run.rationale) this.log(`Rationale: ${run.rationale}`);
    const scores: Array<Record<string, any>> = run.criterionScores ?? [];
    for (const score of scores) {
      const value = score.score === null ? 'no score' : Number(score.score).toFixed(3);
      const spread = Number(score.uncertainty) > 0 ? ` +/-${Number(score.uncertainty).toFixed(3)}` : '';
      this.log(`  ${score.passed ? 'PASS' : 'FAIL'}  ${value}${spread}  ${score.criterionText}`);
    }
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkVerify);

    if (flags.history) {
      const client = await this.client(flags);
      const response = await client.listWorkItemVerifierRuns(args.id);
      this.handleApiError(response);
      const runs = (response.data as {runs: Array<Record<string, any>>}).runs ?? [];
      if (!this.jsonEnabled()) {
        if (runs.length === 0) this.log('No verifier runs recorded for this work item.');
        for (const run of runs) {
          this.log(`--- ${run.createdAt}`);
          this.formatRun(run);
        }
      }
      return runs;
    }

    const notice = {
      status: 'retired',
      workItemId: args.id,
      message: 'Hosted LLM work verification has been retired and no model was invoked.',
      authoritativeGate: 'commands_passed',
      next: 'Submit immutable verification-command evidence with `sift work verification evidence`.',
      historyCommand: `sift work verify ${args.id} --history`,
    };
    if (!this.jsonEnabled()) {
      this.warn(notice.message);
      this.log(notice.next);
      this.log(`Historical runs: ${notice.historyCommand}`);
    }
    return notice;
  }
}

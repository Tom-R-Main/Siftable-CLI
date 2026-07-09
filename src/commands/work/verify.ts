import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class WorkVerify extends BaseCommand {
  static description =
    'Run the LLM verifier against a work item\'s acceptance criteria and record a verifier run. '
    + 'Promotion to verified requires passing verification-command evidence plus a verified verdict.';

  static args = {
    id: Args.string({description: 'Work item ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    reps: Flags.integer({description: 'Repeated evaluations per criterion (1-8, default 3)'}),
    model: Flags.string({description: 'Verifier model override'}),
    history: Flags.boolean({description: 'List prior verifier runs instead of running a new one'}),
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
    const client = await this.client(flags);

    if (flags.history) {
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

    const response = await client.verifyWorkItem(args.id, {
      repetitions: flags.reps,
      model: flags.model,
    });
    this.handleApiError(response);
    const run = this.unwrapOne(response, 'run') as Record<string, any>;
    if (!this.jsonEnabled()) this.formatRun(run);
    return run;
  }
}

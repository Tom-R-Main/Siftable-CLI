import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDatasetImportResult} from '../../../lib/dataset-import-render.js';

export default class EvidenceDiffApply extends BaseCommand {
  static description = 'Apply a reviewed Evidence Graph diff plan';

  static args = {
    id: Args.string({description: 'Persisted diff plan ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Confirm applying the reviewed diff plan without prompting'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(EvidenceDiffApply);
    const confirmed = await this.confirmAction(
      `Apply reviewed Evidence Graph diff plan ${args.id}?`,
      flags,
    );
    if (!confirmed) {
      this.log('Evidence diff apply cancelled.');
      return {ok: false, cancelled: true};
    }

    const client = await this.client(flags);
    const response = await client.applyDatasetDiffPlan(args.id);
    this.handleApiError(response);
    const data = response.data as Record<string, unknown>;
    const importResult = data.result && typeof data.result === 'object'
      ? data.result as Record<string, unknown>
      : data;
    const result = {
      ok: true,
      ...importResult,
      planId: args.id,
      persistedPlan: data.plan,
      evidence: {
        appliedReviewedDiff: true,
        agentsAppliedDurableAssertions: false,
      },
      next: [
        'Run `sift evidence verify --project <project-id> --json` before treating projected facts as trusted.',
        'Run `sift evidence proof report --project <project-id> --format markdown` after verification passes.',
      ],
    };

    if (!this.jsonEnabled()) {
      renderDatasetImportResult(result);
    }
    return result;
  }
}

import {Args, Flags} from '@oclif/core';
import {readFileSync} from 'node:fs';
import {BaseCommand} from '../../lib/base-command.js';
import {assertDatasetDiffPlan} from '../../lib/dataset-diff-plan.js';
import {renderDatasetImportResult} from '../../lib/dataset-import-render.js';

export default class DatasetsApplyDiff extends BaseCommand {
  static description = 'Apply a saved dataset diff plan';

  static args = {
    plan: Args.string({description: 'Path to a diff plan created by datasets diff --save-plan', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Confirm applying the saved diff plan without prompting'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsApplyDiff);
    let plan;
    try {
      plan = assertDatasetDiffPlan(JSON.parse(readFileSync(args.plan, 'utf8')));
    } catch (error) {
      this.error(error instanceof Error ? error.message : `Invalid diff plan: ${args.plan}`);
    }

    const confirmed = await this.confirmAction(
      `Apply ${plan.rows.length} planned rows to dataset ${plan.datasetId}?`,
      flags,
    );
    if (!confirmed) {
      this.log('Apply cancelled.');
      return {ok: false, cancelled: true};
    }

    const client = await this.client(flags);
    const response = await client.applyDatasetImport(plan.datasetId, {
      rows: plan.rows,
      template: plan.template,
      upsertBy: plan.upsertBy,
      batchSize: plan.batchSize,
    });
    this.handleApiError(response);
    const result = {
      ok: true,
      ...(response.data as Record<string, unknown>),
      planPath: args.plan,
      next: plan.template
        ? [`Run \`sift datasets validate ${plan.datasetId} --template ${plan.template} --json\`.`]
        : [`Run \`sift datasets profile ${plan.datasetId} --json\`.`],
    };

    if (!this.jsonEnabled()) {
      renderDatasetImportResult(result);
    }

    return result;
  }
}

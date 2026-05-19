import {Args, Flags} from '@oclif/core';
import {existsSync, readFileSync} from 'node:fs';
import {BaseCommand} from '../../lib/base-command.js';
import {assertDatasetDiffPlan} from '../../lib/dataset-diff-plan.js';
import {renderDatasetImportResult} from '../../lib/dataset-import-render.js';

export default class DatasetsApplyDiff extends BaseCommand {
  static description = 'Apply a saved dataset diff plan';

  static args = {
    plan: Args.string({description: 'Path to a local diff plan or persisted diff plan ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Confirm applying the saved diff plan without prompting'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsApplyDiff);
    const isLocalPlan = existsSync(args.plan);
    let plan;
    let prompt = `Apply persisted dataset diff plan ${args.plan}?`;
    if (isLocalPlan) {
      try {
        plan = assertDatasetDiffPlan(JSON.parse(readFileSync(args.plan, 'utf8')));
        prompt = `Apply ${plan.rows.length} planned rows to dataset ${plan.datasetId}?`;
      } catch (error) {
        this.error(error instanceof Error ? error.message : `Invalid diff plan: ${args.plan}`);
      }
    }

    const confirmed = await this.confirmAction(prompt, flags);
    if (!confirmed) {
      this.log('Apply cancelled.');
      return {ok: false, cancelled: true};
    }

    const client = await this.client(flags);
    const response = isLocalPlan
      ? await client.applyDatasetImport(plan!.datasetId, {
        rows: plan!.rows,
        template: plan!.template,
        upsertBy: plan!.upsertBy,
        batchSize: plan!.batchSize,
      })
      : await client.applyDatasetDiffPlan(args.plan);
    this.handleApiError(response);
    const data = response.data as Record<string, unknown>;
    const importResult = data.result && typeof data.result === 'object'
      ? data.result as Record<string, unknown>
      : data;
    const persistedPlan = data.plan;
    const datasetId = plan?.datasetId ?? (persistedPlan && typeof persistedPlan === 'object' ? (persistedPlan as Record<string, unknown>).datasetId : undefined);
    const template = plan?.template ?? (persistedPlan && typeof persistedPlan === 'object' ? (persistedPlan as Record<string, unknown>).template : undefined);
    const result = {
      ok: true,
      ...importResult,
      planPath: isLocalPlan ? args.plan : undefined,
      planId: isLocalPlan ? undefined : args.plan,
      persistedPlan,
      next: template && datasetId
        ? [`Run \`sift datasets validate ${datasetId} --template ${template} --json\`.`]
        : datasetId ? [`Run \`sift datasets profile ${datasetId} --json\`.`] : [],
    };

    if (!this.jsonEnabled()) {
      renderDatasetImportResult(result);
    }

    return result;
  }
}

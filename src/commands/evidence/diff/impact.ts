import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail, renderTable} from '../../../lib/output.js';
import {summarizeEvidenceDiff} from '../../../lib/evidence.js';

export default class EvidenceDiffImpact extends BaseCommand {
  static description = 'Explain Evidence Graph consequences for a persisted diff plan';

  static args = {
    id: Args.string({description: 'Persisted diff plan ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(EvidenceDiffImpact);
    const client = await this.client(flags);
    const planResponse = await client.getDatasetDiffPlan(args.id);
    this.handleApiError(planResponse);
    const planResult = planResponse.data as {ok: true; plan: Record<string, unknown>};
    const datasetId = String(planResult.plan.datasetId ?? '');
    if (!datasetId) {
      this.error(`Diff plan ${args.id} does not include a datasetId.`);
    }

    const impactResponse = await client.getDatasetImpact(datasetId, {planId: args.id});
    this.handleApiError(impactResponse);
    const impact = impactResponse.data as Record<string, unknown>;
    const evidenceSummary = summarizeEvidenceDiff(planResult.plan);
    const output = {
      ok: true,
      plan: planResult.plan,
      impact,
      evidenceSummary,
      projectionPreview: {
        dryRunOnly: true,
        graphStale: Boolean((impact.stale as Record<string, any> | undefined)?.graph?.stale),
        recommendedActions: impact.recommendedActions ?? [],
      },
    };

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Plan ID', args.id],
        ['Dataset ID', datasetId],
        ['Impact', String(impact.impactVersion ?? '')],
        ['Evidence operations', evidenceSummary.operations],
        ['Graph stale', output.projectionPreview.graphStale ? 'yes' : 'no'],
      ]);
      const actions = Array.isArray(impact.recommendedActions) ? impact.recommendedActions as Record<string, unknown>[] : [];
      if (actions.length > 0) {
        this.log('');
        renderTable(actions, [
          {key: 'name', header: 'Next Action'},
          {key: 'reason', header: 'Reason'},
        ]);
      }
    }

    return output;
  }
}

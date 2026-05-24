import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail, renderTable} from '../../../lib/output.js';
import {summarizeEvidenceDiff} from '../../../lib/evidence.js';

export default class EvidenceDiffShow extends BaseCommand {
  static description = 'Show an Evidence Graph diff plan with domain-aware summary';

  static args = {
    id: Args.string({description: 'Persisted diff plan ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(EvidenceDiffShow);
    const client = await this.client(flags);
    const response = await client.getDatasetDiffPlan(args.id);
    this.handleApiError(response);
    const result = response.data as {ok: true; plan: Record<string, unknown>};
    const evidenceSummary = summarizeEvidenceDiff(result.plan);
    const output = {
      ok: true,
      plan: result.plan,
      evidenceSummary,
      reviewRequired: true,
      trustPolicy: {
        appliesDurableAssertions: false,
        requiresExplicitApply: true,
      },
    };

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Plan ID', String(result.plan.id ?? '')],
        ['Dataset ID', String(result.plan.datasetId ?? '')],
        ['Status', String(result.plan.status ?? '')],
        ['Evidence operations', evidenceSummary.operations],
        ['Claims', evidenceSummary.claims],
        ['Events', evidenceSummary.events],
        ['Relationships', evidenceSummary.relationships],
        ['Contradictions', evidenceSummary.contradictions],
      ]);
      const operations = Array.isArray(result.plan.proposedOperations)
        ? result.plan.proposedOperations as Array<Record<string, unknown>>
        : [];
      if (operations.length > 0) {
        this.log('');
        renderTable(operations.slice(0, 25), [
          {key: 'op', header: 'Op'},
          {key: 'rowNumber', header: 'Row'},
          {key: 'existingRecordId', header: 'Record'},
        ]);
      }
    }

    return output;
  }
}

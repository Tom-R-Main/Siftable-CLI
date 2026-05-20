import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class DatasetsImpact extends BaseCommand {
  static description = 'Explain dataset formula, graph, view, quality, and materialization impact';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'from-plan': Flags.string({description: 'Persisted diff plan ID to inspect'}),
    operation: Flags.string({description: 'Committed dataset operation ID to inspect'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsImpact);
    if (!flags['from-plan'] && !flags.operation) {
      this.error('Provide --from-plan <plan-id> or --operation <operation-id>.');
    }
    if (flags['from-plan'] && flags.operation) {
      this.error('Use only one of --from-plan or --operation.');
    }

    const client = await this.client(flags);
    const response = await client.getDatasetImpact(args.id, {
      planId: flags['from-plan'],
      operationId: flags.operation,
    });
    this.handleApiError(response);
    const impact = response.data as Record<string, any>;

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Dataset ID', impact.datasetId],
        ['Impact', impact.impactVersion],
        ['Source', `${impact.source?.type ?? 'unknown'}:${impact.source?.id ?? 'unknown'}`],
        ['Changed Fields', impact.changed?.fields?.length ?? 0],
        ['Known Rows', impact.changed?.rows?.knownCount ?? 0],
        ['Formula Fields', impact.stale?.formulas?.length ?? 0],
        ['Materialized', impact.stale?.materializedDatasets?.length ?? 0],
        ['Graph Stale', impact.stale?.graph?.stale ? 'yes' : 'no'],
      ]);

      this.log('');
      renderTable((impact.changed?.fields ?? []) as Record<string, unknown>[], [
        {key: 'name', header: 'Changed Field'},
        {key: 'type', header: 'Type'},
        {key: 'resolved', header: 'Resolved', get: (row) => row.resolved ? 'yes' : 'no'},
      ]);

      const actions = impact.recommendedActions ?? [];
      if (Array.isArray(actions) && actions.length > 0) {
        this.log('');
        renderTable(actions as Record<string, unknown>[], [
          {key: 'name', header: 'Next Action'},
          {key: 'reason', header: 'Reason'},
        ]);
      }
    }

    return impact;
  }
}

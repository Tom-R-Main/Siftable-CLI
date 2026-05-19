import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

export default class DatasetsDiffPlansList extends BaseCommand {
  static description = 'List persisted dataset diff plans';

  static flags = {
    ...BaseCommand.baseFlags,
    'dataset-id': Flags.string({description: 'Filter by dataset ID'}),
    status: Flags.string({description: 'Filter by plan status', options: ['draft', 'validated', 'applied', 'rejected', 'expired']}),
    limit: Flags.integer({description: 'Maximum plans to return', default: 50}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(DatasetsDiffPlansList);
    const client = await this.client(flags);
    const response = await client.listDatasetDiffPlans({
      datasetId: flags['dataset-id'],
      status: flags.status,
      limit: flags.limit,
    });
    this.handleApiError(response);
    const result = response.data as { ok: true; plans: Array<Record<string, unknown>> };

    if (!this.jsonEnabled()) {
      renderTable(
        result.plans,
        [
          {key: 'id', header: 'ID'},
          {key: 'datasetId', header: 'Dataset'},
          {key: 'status', header: 'Status'},
          {key: 'summary', header: 'Summary', get: (plan) => JSON.stringify(plan.summary ?? {})},
          {key: 'createdAt', header: 'Created'},
        ],
      );
    }

    return result;
  }
}

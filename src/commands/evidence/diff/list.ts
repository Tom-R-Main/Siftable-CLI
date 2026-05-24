import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

export default class EvidenceDiffList extends BaseCommand {
  static description = 'List persisted Evidence Graph diff plans';

  static flags = {
    ...BaseCommand.baseFlags,
    'dataset-id': Flags.string({description: 'Filter by evidence dataset ID'}),
    project: Flags.string({description: 'Filter locally by Evidence Graph project ID when present on plans'}),
    status: Flags.string({description: 'Filter by plan status', options: ['draft', 'validated', 'applied', 'rejected', 'expired']}),
    limit: Flags.integer({description: 'Maximum plans to return', default: 50}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(EvidenceDiffList);
    const client = await this.client(flags);
    const response = await client.listDatasetDiffPlans({
      datasetId: flags['dataset-id'],
      status: flags.status,
      limit: flags.limit,
    });
    this.handleApiError(response);
    const result = response.data as {ok: true; plans: Array<Record<string, unknown>>};
    const plans = flags.project
      ? result.plans.filter((plan) => plan.projectId === flags.project || plan.evidenceGraphProjectId === flags.project)
      : result.plans;
    const output = {
      ok: true,
      plans,
      evidence: {
        projectFilter: flags.project,
        reviewRequired: true,
      },
    };

    if (!this.jsonEnabled()) {
      renderTable(plans, [
        {key: 'id', header: 'ID'},
        {key: 'datasetId', header: 'Dataset'},
        {key: 'status', header: 'Status'},
        {key: 'summary', header: 'Summary', get: (plan) => JSON.stringify(plan.summary ?? {})},
        {key: 'createdAt', header: 'Created'},
      ]);
    }

    return output;
  }
}

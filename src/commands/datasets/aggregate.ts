import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class DatasetsAggregate extends BaseCommand {
  static description = 'Aggregate dataset records with grouped metrics (count, avg, sum, min, max, median, stddev, percentile, ratio)';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'group-by': Flags.string({description: 'Comma-separated field names to group by'}),
    metrics: Flags.string({description: 'JSON array of metrics [{operation, field, as}]'}),
    filters: Flags.string({description: 'JSON array of filters'}),
    sorts: Flags.string({description: 'JSON array of sorts'}),
    having: Flags.string({description: 'JSON array of having clauses [{metric, operator, value}]'}),
    limit: Flags.integer({description: 'Max rows', default: 100}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsAggregate);
    const client = await this.client(flags);

    const options: Record<string, unknown> = {limit: flags.limit};
    if (flags['group-by']) options.groupBy = flags['group-by'].split(',').map((s) => s.trim());
    if (flags.metrics) options.metrics = JSON.parse(flags.metrics);
    if (flags.filters) options.filters = JSON.parse(flags.filters);
    if (flags.sorts) options.sorts = JSON.parse(flags.sorts);
    if (flags.having) options.having = JSON.parse(flags.having);

    const response = await client.aggregateDataset(args.id, options as any);
    this.handleApiError(response);

    const data = response.data as any;
    if (!this.jsonEnabled()) {
      for (const row of (data?.rows ?? [])) {
        const groupParts = Object.entries(row.group || {}).map(([k, v]) => `${k}=${v}`).join(', ');
        const metricParts = Object.entries(row.metrics || {}).map(([k, v]) => `${k}=${v}`).join(', ');
        this.log(`${groupParts ? groupParts + ' → ' : ''}${metricParts}`);
      }
    }

    return response.data;
  }
}

import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class DatasetsBucket extends BaseCommand {
  static description = 'Bucket a numeric or date field into ranges with aggregate metrics per bucket';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    field: Flags.string({description: 'Field to bucket', required: true}),
    boundaries: Flags.string({description: 'Comma-separated boundary values (omit for auto-bucketing)'}),
    'bucket-count': Flags.integer({description: 'Number of auto-buckets (default: 5)'}),
    metrics: Flags.string({description: 'JSON array of metrics'}),
    filters: Flags.string({description: 'JSON array of filters'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsBucket);
    const client = await this.client(flags);

    const options: Record<string, unknown> = {field: flags.field};
    if (flags.boundaries) options.boundaries = flags.boundaries.split(',').map((s) => Number(s.trim()));
    if (flags['bucket-count']) options.bucketCount = flags['bucket-count'];
    if (flags.metrics) options.metrics = JSON.parse(flags.metrics);
    if (flags.filters) options.filters = JSON.parse(flags.filters);

    const response = await client.bucketDataset(args.id, options as any);
    this.handleApiError(response);

    const data = response.data as any;
    if (!this.jsonEnabled()) {
      for (const row of (data?.rows ?? [])) {
        const metricParts = Object.entries(row.metrics || {}).map(([k, v]) => `${k}=${v}`).join(', ');
        this.log(`${row.bucket}: ${metricParts}`);
      }
    }

    return response.data;
  }
}

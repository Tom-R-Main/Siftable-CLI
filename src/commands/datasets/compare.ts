import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class DatasetsCompare extends BaseCommand {
  static description = 'Compare metrics across segments of a categorical field side-by-side';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'segment-field': Flags.string({description: 'Categorical field to segment by', required: true}),
    'segment-values': Flags.string({description: 'Comma-separated segment values (auto-discovers if omitted)'}),
    metrics: Flags.string({description: 'JSON array of metrics'}),
    filters: Flags.string({description: 'JSON array of filters'}),
    limit: Flags.integer({description: 'Max segment values to compare', default: 10}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsCompare);
    const client = await this.client(flags);

    const options: Record<string, unknown> = {
      segmentField: flags['segment-field'],
      limit: flags.limit,
    };
    if (flags['segment-values']) options.segmentValues = flags['segment-values'].split(',').map((s) => s.trim());
    if (flags.metrics) options.metrics = JSON.parse(flags.metrics);
    if (flags.filters) options.filters = JSON.parse(flags.filters);

    const response = await client.compareDatasetSegments(args.id, options as any);
    this.handleApiError(response);

    const data = response.data as any;
    if (!this.jsonEnabled()) {
      for (const segment of (data?.segments ?? [])) {
        const metricParts = Object.entries(segment.metrics || {}).map(([k, v]) => `${k}=${v}`).join(', ');
        this.log(`${segment.segmentValue}: ${metricParts}`);
      }

      if (data?.deltas && Object.keys(data.deltas).length > 0) {
        this.log('\nDeltas:');
        for (const [key, delta] of Object.entries(data.deltas)) {
          const parts = Object.entries(delta as Record<string, unknown>).map(([k, v]) => `${k}=${v}`).join(', ');
          this.log(`  ${key}: ${parts}`);
        }
      }
    }

    return response.data;
  }
}

import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable, truncate} from '../../lib/output.js';

export default class DatasetsTimeseries extends BaseCommand {
  static description = 'Analyze dataset time series with lag, pct_change, rolling windows, drawdown, volatility, and correlation';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    filters: Flags.string({description: 'JSON array of filters'}),
    'date-field': Flags.string({description: 'Date field name', required: true}),
    'segment-field': Flags.string({description: 'Optional segment field'}),
    'segment-values': Flags.string({description: 'Comma-separated segment values'}),
    metrics: Flags.string({description: 'JSON array of metric definitions'}),
    transforms: Flags.string({description: 'JSON array of transform definitions'}),
    pivot: Flags.boolean({description: 'Emit explicit pivoted output', default: false}),
    'order-direction': Flags.string({
      description: 'Time ordering',
      options: ['asc', 'desc'],
      default: 'asc',
    }),
    limit: Flags.integer({description: 'Maximum output rows', default: 100}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsTimeseries);
    const client = await this.client(flags);

    const response = await client.analyzeDatasetTimeseries(args.id, {
      filters: this.parseJsonFlag(flags.filters, '--filters') as Array<Record<string, unknown>> | undefined,
      dateField: flags['date-field'],
      segmentField: flags['segment-field'],
      segmentValues: flags['segment-values']?.split(',').map((part) => part.trim()).filter(Boolean),
      metrics: this.parseJsonFlag(flags.metrics, '--metrics') as Array<Record<string, unknown>> | undefined,
      transforms: this.parseJsonFlag(flags.transforms, '--transforms') as Array<Record<string, unknown>> | undefined,
      pivot: flags.pivot,
      orderDirection: flags['order-direction'] as 'asc' | 'desc',
      limit: flags.limit,
    });
    this.handleApiError(response);

    const data = response.data as any;
    if (!this.jsonEnabled()) {
      const columns = (data?.columns ?? []).slice(0, 6);
      renderTable((data?.rows ?? []) as Record<string, unknown>[], columns.map((column: Record<string, unknown>) => ({
        key: String(column.key),
        header: truncate(String(column.label ?? column.key), 24),
      })));
      if (data?.summary && Object.keys(data.summary).length > 0) {
        this.log('\nSummary:');
        for (const [key, value] of Object.entries(data.summary as Record<string, unknown>)) {
          this.log(`  ${key}: ${JSON.stringify(value)}`);
        }
      }
    }

    return response.data;
  }
}

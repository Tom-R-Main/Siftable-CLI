import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, renderTable, truncate} from '../../lib/output.js';

export default class DatasetsPlot extends BaseCommand {
  static description = 'Validate and normalize a lightweight plot payload from a derived result';

  static flags = {
    ...BaseCommand.baseFlags,
    'source-result': Flags.string({description: 'Inline JSON for a derived result', required: false}),
    'source-result-file': Flags.string({description: 'Path to a JSON file containing a derived result', required: false}),
    'chart-type': Flags.string({
      description: 'Chart type',
      options: ['line', 'bar', 'scatter'],
      required: true,
    }),
    'x-field': Flags.string({description: 'X-axis field', required: true}),
    'y-fields': Flags.string({description: 'Comma-separated Y-axis fields', required: true}),
    'series-field': Flags.string({description: 'Optional series field'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(DatasetsPlot);
    const client = await this.client(flags);

    const sourceResult = this.parseJsonInput<Record<string, unknown>>(
      flags['source-result'],
      flags['source-result-file'],
      '--source-result',
    );
    if (!sourceResult) {
      this.error('Provide --source-result or --source-result-file.');
    }

    const response = await client.plotDatasetResult({
      sourceResult,
      chartType: flags['chart-type'] as 'line' | 'bar' | 'scatter',
      xField: flags['x-field'],
      yFields: flags['y-fields'].split(',').map((part) => part.trim()).filter(Boolean),
      seriesField: flags['series-field'],
    });
    this.handleApiError(response);

    const data = response.data as any;
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Chart Type', data?.chartType],
        ['X Field', data?.xField],
        ['Y Fields', Array.isArray(data?.yFields) ? data.yFields.join(', ') : '—'],
        ['Series Field', data?.seriesField ?? '—'],
        ['Rows', data?.summary?.rowCount ?? data?.rows?.length ?? 0],
      ]);

      const rows = (data?.rows ?? []) as Record<string, unknown>[];
      if (rows.length > 0) {
        const previewKeys = Object.keys(rows[0] ?? {}).slice(0, 6);
        this.log('');
        renderTable(rows.slice(0, 10), previewKeys.map((key) => ({
          key,
          header: truncate(key, 24),
        })));
      }
    }

    return response.data;
  }
}

import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {parseJsonArrayFlag} from '../../lib/dataset-query.js';
import {renderTable} from '../../lib/output.js';

export default class DatasetsPivot extends BaseCommand {
  static description = 'Create a pivot-style summary from grouped dataset metrics';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    rows: Flags.string({description: 'Row field', required: true}),
    cols: Flags.string({description: 'Column field', required: true}),
    metrics: Flags.string({description: 'JSON metrics array; defaults to count'}),
    filters: Flags.string({description: 'JSON array of filters'}),
    limit: Flags.integer({description: 'Maximum grouped cells to request', default: 500}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsPivot);
    let metrics;
    let filters;
    try {
      metrics = parseJsonArrayFlag(flags.metrics, '--metrics') ?? [{operation: 'count', as: 'count'}];
      filters = parseJsonArrayFlag(flags.filters, '--filters');
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Invalid JSON flag.');
    }

    const client = await this.client(flags);
    const response = await client.aggregateDataset(args.id, {
      groupBy: [flags.rows, flags.cols],
      metrics,
      filters,
      limit: flags.limit,
    });
    this.handleApiError(response);

    const aggregateRows = (((response.data as any)?.rows ?? []) as Array<{
      group?: Record<string, unknown>;
      metrics?: Record<string, unknown>;
    }>);
    const metricName = String((metrics?.[0]?.as ?? metrics?.[0]?.operation ?? 'count'));
    const rowValues = new Map<string, Record<string, unknown>>();
    const colValues = new Set<string>();

    for (const item of aggregateRows) {
      const rowValue = String(item.group?.[flags.rows] ?? '');
      const colValue = String(item.group?.[flags.cols] ?? '');
      colValues.add(colValue);
      const row = rowValues.get(rowValue) ?? {[flags.rows]: rowValue};
      row[colValue] = item.metrics?.[metricName] ?? null;
      rowValues.set(rowValue, row);
    }

    const columns = Array.from(colValues).sort();
    const rows = Array.from(rowValues.values());
    const result = {
      ok: true,
      datasetId: args.id,
      rowField: flags.rows,
      columnField: flags.cols,
      metric: metricName,
      columns,
      rows,
      source: response.data,
    };

    if (!this.jsonEnabled()) {
      renderTable(rows, [
        {key: flags.rows, header: flags.rows},
        ...columns.map((column) => ({key: column, header: column})),
      ]);
    }

    return result;
  }
}

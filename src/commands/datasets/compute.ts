import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable, truncate} from '../../lib/output.js';

export default class DatasetsCompute extends BaseCommand {
  static description = 'Compute derived fields from a dataset or prior derived result';

  static args = {
    id: Args.string({description: 'Dataset ID', required: false}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    filters: Flags.string({description: 'JSON array of filters'}),
    select: Flags.string({description: 'Comma-separated fields to include'}),
    'computed-fields': Flags.string({
      description: 'JSON array of computed fields, e.g. \'[{"as":"spread","expression":"right.Close-left.Close"}]\'',
      required: true,
    }),
    'order-by': Flags.string({description: 'JSON array of order clauses'}),
    sorts: Flags.string({description: 'JSON array of output sorts'}),
    limit: Flags.integer({description: 'Maximum rows', default: 50}),
    'source-result': Flags.string({description: 'Inline JSON for a prior derived result'}),
    'source-result-file': Flags.string({description: 'Path to a JSON file containing a prior derived result'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsCompute);
    const client = await this.client(flags);

    const sourceResult = this.parseJsonInput<Record<string, unknown>>(
      flags['source-result'],
      flags['source-result-file'],
      '--source-result',
    );
    const datasetId = args.id ?? (typeof sourceResult?.datasetId === 'string' ? sourceResult.datasetId : undefined);
    if (!datasetId) {
      this.error('Dataset ID is required unless --source-result includes datasetId.');
    }

    const response = await client.computeDatasetFields(datasetId, {
      filters: this.parseJsonFlag(flags.filters, '--filters') as Array<Record<string, unknown>> | undefined,
      select: flags.select?.split(',').map((part) => part.trim()).filter(Boolean),
      computedFields: this.parseJsonFlag(flags['computed-fields'], '--computed-fields') as Array<{ as: string; expression: string; description?: string }>,
      orderBy: this.parseJsonFlag(flags['order-by'], '--order-by') as Array<Record<string, unknown>> | undefined,
      sorts: this.parseJsonFlag(flags.sorts, '--sorts') as Array<Record<string, unknown>> | undefined,
      limit: flags.limit,
      sourceResult,
    });
    this.handleApiError(response);

    const data = response.data as any;
    if (!this.jsonEnabled()) {
      const columns = (data?.columns ?? []).slice(0, 6);
      renderTable((data?.rows ?? []) as Record<string, unknown>[], columns.map((column: Record<string, unknown>) => ({
        key: String(column.key),
        header: truncate(String(column.label ?? column.key), 24),
      })));
    }

    return response.data;
  }
}

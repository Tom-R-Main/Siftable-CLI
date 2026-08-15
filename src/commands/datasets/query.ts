import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {parseDatasetFiltersFlag, parseDatasetSortsFlag} from '../../lib/dataset-query.js';
import {renderDatasetRecords} from '../../lib/dataset-render.js';

export default class DatasetsQuery extends BaseCommand {
  static description = 'Query records from a dataset';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({description: 'Maximum number of records', default: 25}),
    cursor: Flags.string({description: 'Pagination cursor from previous query'}),
    filters: Flags.string({
      description: 'Filter conditions as JSON array, e.g. \'[{"field":"status","value":"active"}]\'',
    }),
    sorts: Flags.string({
      description: 'Sort spec as JSON array, e.g. \'[{"field":"name","direction":"asc"}]\'',
    }),
    'include-deleted': Flags.boolean({description: 'Include soft-deleted records', default: false}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsQuery);
    const client = await this.client(flags);

    const input: Record<string, unknown> = {
      limit: flags.limit,
      includeDeleted: flags['include-deleted'],
    };

    if (flags.cursor) input.cursor = flags.cursor;

    if (flags.filters) {
      try {
        input.filters = parseDatasetFiltersFlag(flags.filters);
      } catch (error) {
        this.error(error instanceof Error ? error.message : 'Invalid --filters JSON.');
      }
    }

    if (flags.sorts) {
      try {
        input.sorts = parseDatasetSortsFlag(flags.sorts);
      } catch (error) {
        this.error(error instanceof Error ? error.message : 'Invalid --sorts JSON.');
      }
    }

    const response = await client.queryDataset(args.id, input);
    this.handleApiError(response);

    const records = this.unwrapList(response, 'records');

    if (!this.jsonEnabled()) {
      if (records.length === 0) {
        this.log('No records found.');
        return records;
      }

      renderDatasetRecords(records);
    }

    return response.data;
  }
}

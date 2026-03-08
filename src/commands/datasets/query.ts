import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

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
        input.filters = JSON.parse(flags.filters);
      } catch {
        this.error('Invalid --filters JSON. Expected array of filter objects.');
      }
    }

    if (flags.sorts) {
      try {
        input.sorts = JSON.parse(flags.sorts);
      } catch {
        this.error('Invalid --sorts JSON. Expected array of sort objects.');
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

      // Dynamically build columns from the fields of the first record
      const sampleFields = (records[0]?.fields ?? {}) as Record<string, unknown>;
      const fieldNames = Object.keys(sampleFields);

      const columns = [
        {key: 'id', header: 'ID', get: (r: Record<string, unknown>) => {
          const id = String(r.id ?? '');
          return id.length > 8 ? id.slice(0, 8) + '…' : id;
        }},
        ...fieldNames.slice(0, 6).map(name => ({
          key: name,
          header: name,
          get: (r: Record<string, unknown>) => {
            const fields = r.fields as Record<string, unknown> | undefined;
            const val = fields?.[name];
            const str = val != null ? String(val) : '—';
            return str.length > 30 ? str.slice(0, 29) + '…' : str;
          },
        })),
      ];

      renderTable(records, columns);

      if (fieldNames.length > 6) {
        this.log(`\n(${fieldNames.length - 6} more field(s) hidden — use --json for all)`);
      }
    }

    return response.data;
  }
}

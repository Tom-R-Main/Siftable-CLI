import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {mergeFilters, parseJsonArrayFlag, splitFields} from '../../lib/dataset-query.js';
import {recordKey, renderDatasetRecords} from '../../lib/dataset-render.js';

export default class DatasetsSearch extends BaseCommand {
  static description = 'Search dataset records across selected text-like fields';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
    query: Args.string({description: 'Search text', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    fields: Flags.string({description: 'Comma-separated fields to search; defaults to profile columns'}),
    filters: Flags.string({description: 'JSON array of base filters applied to every field search'}),
    limit: Flags.integer({description: 'Maximum merged records', default: 25}),
    'per-field-limit': Flags.integer({description: 'Maximum records to request per searched field', default: 25}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsSearch);
    const client = await this.client(flags);
    let baseFilters;
    try {
      baseFilters = parseJsonArrayFlag(flags.filters, '--filters');
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Invalid --filters JSON.');
    }

    let fields = splitFields(flags.fields);
    if (!fields) {
      const profile = await client.profileDataset(args.id, {sampleLimit: 0});
      this.handleApiError(profile);
      fields = (((profile.data as any)?.columns ?? []) as Array<Record<string, unknown>>)
        .map((column) => String(column.name ?? ''))
        .filter(Boolean);
    }
    if (!fields || fields.length === 0) {
      this.error('No fields available to search. Provide --fields.');
    }

    const byId = new Map<string, Record<string, unknown>>();
    const matches: Array<{field: string; count: number}> = [];
    for (const field of fields) {
      const response = await client.queryDataset(args.id, {
        filters: mergeFilters(baseFilters, {field, operator: 'contains', value: args.query}),
        limit: flags['per-field-limit'],
        includeDeleted: false,
      });
      this.handleApiError(response);
      const records = (((response.data as any)?.records ?? []) as Record<string, unknown>[]);
      matches.push({field, count: records.length});
      for (const record of records) {
        if (byId.size >= flags.limit && !byId.has(recordKey(record))) continue;
        byId.set(recordKey(record), record);
      }
    }

    const records = Array.from(byId.values()).slice(0, flags.limit);
    const result = {
      ok: true,
      datasetId: args.id,
      query: args.query,
      searchedFields: fields,
      matches,
      records,
      totalCount: records.length,
    };

    if (!this.jsonEnabled()) {
      renderDatasetRecords(records);
    }

    return result;
  }
}

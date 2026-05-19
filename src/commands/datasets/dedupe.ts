import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class DatasetsDedupe extends BaseCommand {
  static description = 'Find duplicate dataset records by key without mutating data';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    key: Flags.string({description: 'Field name used to group duplicates', required: true}),
    limit: Flags.integer({description: 'Maximum records to scan in one bounded pass', default: 500}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsDedupe);
    const client = await this.client(flags);
    const response = await client.queryDataset(args.id, {
      sorts: [{field: flags.key, direction: 'asc'}],
      limit: flags.limit,
      includeDeleted: false,
    });
    this.handleApiError(response);

    const records = (((response.data as any)?.records ?? []) as Record<string, unknown>[]);
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const record of records) {
      const fields = (record.fields ?? {}) as Record<string, unknown>;
      const value = fields[flags.key];
      if (value === null || value === undefined || value === '') continue;
      const key = String(value);
      const group = groups.get(key) ?? [];
      group.push(record);
      groups.set(key, group);
    }

    const duplicateGroups = Array.from(groups.entries())
      .filter(([, group]) => group.length > 1)
      .map(([value, group]) => ({
        value,
        count: group.length,
        recordIds: group.map((record) => record.id),
      }));

    const result = {
      ok: true,
      dryRun: true,
      datasetId: args.id,
      key: flags.key,
      scanned: records.length,
      duplicateGroupCount: duplicateGroups.length,
      duplicateRecordCount: duplicateGroups.reduce((sum, group) => sum + group.count, 0),
      duplicateGroups,
      next: duplicateGroups.length > 0
        ? ['Review duplicateGroups and use dataset diff/apply-diff or update-record to make deliberate changes.']
        : [],
    };

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Dataset ID', args.id],
        ['Key', flags.key],
        ['Scanned', records.length],
        ['Duplicate groups', duplicateGroups.length],
      ]);
      if (duplicateGroups.length > 0) {
        this.log('');
        renderTable(duplicateGroups as unknown as Record<string, unknown>[], [
          {key: 'value', header: 'Value'},
          {key: 'count', header: 'Count'},
          {key: 'recordIds', header: 'Record IDs', get: (row) => ((row.recordIds ?? []) as unknown[]).join(', ')},
        ]);
      }
    }

    return result;
  }
}

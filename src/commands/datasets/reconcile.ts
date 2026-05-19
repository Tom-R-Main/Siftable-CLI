import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, renderTable} from '../../lib/output.js';

function indexRecords(records: Record<string, unknown>[], keyField: string): Map<string, Record<string, unknown>[]> {
  const index = new Map<string, Record<string, unknown>[]>();
  for (const record of records) {
    const fields = (record.fields ?? {}) as Record<string, unknown>;
    const value = fields[keyField];
    if (value === null || value === undefined || value === '') continue;
    const key = String(value);
    const group = index.get(key) ?? [];
    group.push(record);
    index.set(key, group);
  }
  return index;
}

export default class DatasetsReconcile extends BaseCommand {
  static description = 'Compare two datasets by key without mutating either dataset';

  static args = {
    left: Args.string({description: 'Left dataset ID', required: true}),
    right: Args.string({description: 'Right dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'left-key': Flags.string({description: 'Left dataset key field', required: true}),
    'right-key': Flags.string({description: 'Right dataset key field; defaults to --left-key'}),
    limit: Flags.integer({description: 'Maximum rows to scan from each dataset', default: 500}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsReconcile);
    const rightKey = flags['right-key'] ?? flags['left-key'];
    const client = await this.client(flags);

    const leftResponse = await client.queryDataset(args.left, {
      sorts: [{field: flags['left-key'], direction: 'asc'}],
      limit: flags.limit,
      includeDeleted: false,
    });
    this.handleApiError(leftResponse);

    const rightResponse = await client.queryDataset(args.right, {
      sorts: [{field: rightKey, direction: 'asc'}],
      limit: flags.limit,
      includeDeleted: false,
    });
    this.handleApiError(rightResponse);

    const leftRecords = (((leftResponse.data as any)?.records ?? []) as Record<string, unknown>[]);
    const rightRecords = (((rightResponse.data as any)?.records ?? []) as Record<string, unknown>[]);
    const leftIndex = indexRecords(leftRecords, flags['left-key']);
    const rightIndex = indexRecords(rightRecords, rightKey);
    const keys = new Set([...leftIndex.keys(), ...rightIndex.keys()]);
    const matched: string[] = [];
    const leftOnly: string[] = [];
    const rightOnly: string[] = [];
    const duplicateKeys: Array<{key: string; leftCount: number; rightCount: number}> = [];

    for (const key of Array.from(keys).sort()) {
      const leftGroup = leftIndex.get(key) ?? [];
      const rightGroup = rightIndex.get(key) ?? [];
      if (leftGroup.length > 0 && rightGroup.length > 0) matched.push(key);
      else if (leftGroup.length > 0) leftOnly.push(key);
      else rightOnly.push(key);

      if (leftGroup.length > 1 || rightGroup.length > 1) {
        duplicateKeys.push({key, leftCount: leftGroup.length, rightCount: rightGroup.length});
      }
    }

    const result = {
      ok: true,
      dryRun: true,
      leftDatasetId: args.left,
      rightDatasetId: args.right,
      leftKey: flags['left-key'],
      rightKey,
      scanned: {
        left: leftRecords.length,
        right: rightRecords.length,
      },
      summary: {
        matched: matched.length,
        leftOnly: leftOnly.length,
        rightOnly: rightOnly.length,
        duplicateKeys: duplicateKeys.length,
      },
      matched,
      leftOnly,
      rightOnly,
      duplicateKeys,
      next: ['Use dataset diff/apply-diff to deliberately add, update, or normalize reconciled rows.'],
    };

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Left dataset', args.left],
        ['Right dataset', args.right],
        ['Matched', matched.length],
        ['Left only', leftOnly.length],
        ['Right only', rightOnly.length],
        ['Duplicate keys', duplicateKeys.length],
      ]);
      if (duplicateKeys.length > 0) {
        this.log('');
        renderTable(duplicateKeys as unknown as Record<string, unknown>[], [
          {key: 'key', header: 'Key'},
          {key: 'leftCount', header: 'Left'},
          {key: 'rightCount', header: 'Right'},
        ]);
      }
    }

    return result;
  }
}

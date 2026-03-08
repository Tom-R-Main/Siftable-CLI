import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable, truncate} from '../../lib/output.js';

export default class DatasetsJoin extends BaseCommand {
  static description = 'Join a dataset to itself using alias-scoped fields such as left.Close and right.Close';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'left-alias': Flags.string({description: 'Left alias', default: 'left'}),
    'right-alias': Flags.string({description: 'Right alias', default: 'right'}),
    'join-type': Flags.string({
      description: 'Join type',
      options: ['inner', 'left', 'right'],
      default: 'inner',
    }),
    'join-keys': Flags.string({
      description: 'JSON array of join keys, e.g. \'[{"leftField":"Date","rightField":"Date"}]\'',
      required: true,
    }),
    'left-filters': Flags.string({description: 'JSON array of left-side filters'}),
    'right-filters': Flags.string({description: 'JSON array of right-side filters'}),
    select: Flags.string({description: 'Comma-separated alias-scoped fields to return'}),
    sorts: Flags.string({description: 'JSON array of sorts'}),
    limit: Flags.integer({description: 'Maximum joined rows', default: 50}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsJoin);
    const client = await this.client(flags);

    const response = await client.joinDatasetRows(args.id, {
      leftAlias: flags['left-alias'],
      rightAlias: flags['right-alias'],
      joinType: flags['join-type'] as 'inner' | 'left' | 'right',
      joinKeys: this.parseJsonFlag(flags['join-keys'], '--join-keys') as Array<{ leftField: string; rightField: string }>,
      leftFilters: this.parseJsonFlag(flags['left-filters'], '--left-filters') as Array<Record<string, unknown>> | undefined,
      rightFilters: this.parseJsonFlag(flags['right-filters'], '--right-filters') as Array<Record<string, unknown>> | undefined,
      select: flags.select?.split(',').map((part) => part.trim()).filter(Boolean),
      sorts: this.parseJsonFlag(flags.sorts, '--sorts') as Array<Record<string, unknown>> | undefined,
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
    }

    return response.data;
  }
}

import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class DatasetsRank extends BaseCommand {
  static description = 'Rank dataset records by sorts or a weighted numeric formula';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    sorts: Flags.string({description: 'JSON array of sorts'}),
    filters: Flags.string({description: 'JSON array of filters'}),
    formula: Flags.string({description: 'JSON formula object {weights: [{field, weight}]}'}),
    limit: Flags.integer({description: 'Max rows', default: 25}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsRank);
    const client = await this.client(flags);

    const options: Record<string, unknown> = {limit: flags.limit};
    if (flags.sorts) options.sorts = JSON.parse(flags.sorts);
    if (flags.filters) options.filters = JSON.parse(flags.filters);
    if (flags.formula) options.formula = JSON.parse(flags.formula);

    const response = await client.rankDataset(args.id, options as any);
    this.handleApiError(response);

    const data = response.data as any;
    if (!this.jsonEnabled()) {
      for (const [i, row] of (data?.rows ?? []).entries()) {
        const fields = row.record?.fields ?? {};
        const preview = Object.entries(fields).slice(0, 5).map(([k, v]) => `${k}=${v}`).join(', ');
        this.log(`#${i + 1}${row.score != null ? ` (score: ${row.score})` : ''}: ${preview}`);
      }
    }

    return response.data;
  }
}

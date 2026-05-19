import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDatasetRecords} from '../../lib/dataset-render.js';

export default class DatasetsLookup extends BaseCommand {
  static description = 'Lookup dataset records by an exact key/value match';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    key: Flags.string({description: 'Field name to match', required: true}),
    value: Flags.string({description: 'Exact value to match', required: true}),
    limit: Flags.integer({description: 'Maximum matching records', default: 25}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsLookup);
    const client = await this.client(flags);
    const response = await client.queryDataset(args.id, {
      filters: [{field: flags.key, operator: '=', value: flags.value}],
      limit: flags.limit,
      includeDeleted: false,
    });
    this.handleApiError(response);

    const result = response.data as Record<string, unknown>;
    if (!this.jsonEnabled()) {
      renderDatasetRecords((result.records ?? []) as Record<string, unknown>[]);
    }

    return {
      ok: true,
      datasetId: args.id,
      key: flags.key,
      value: flags.value,
      ...result,
    };
  }
}

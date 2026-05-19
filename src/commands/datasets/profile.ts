import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class DatasetsProfile extends BaseCommand {
  static description = 'Show bounded profile information for a dataset';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'sample-limit': Flags.integer({description: 'Number of sample rows to include', default: 10}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsProfile);
    const client = await this.client(flags);
    const response = await client.profileDataset(args.id, {sampleLimit: flags['sample-limit']});
    this.handleApiError(response);
    const profile = response.data as Record<string, unknown>;

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Dataset ID', profile.datasetId],
        ['Rows', profile.rowCount],
      ]);
      this.log('');
      renderTable((profile.columns ?? []) as Record<string, unknown>[], [
        {key: 'name', header: 'Column'},
        {key: 'type', header: 'Type'},
        {key: 'nullCount', header: 'Nulls', get: (row) => String(row.nullCount ?? 0)},
      ]);
    }

    return profile;
  }
}

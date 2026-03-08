import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class DatasetsDeleteRecord extends BaseCommand {
  static description = 'Delete a record from a dataset';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
    'record-id': Args.string({description: 'Record ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({char: 'y', description: 'Skip confirmation'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsDeleteRecord);

    const confirmed = await this.confirmAction('Delete this record?', flags);
    if (!confirmed) {
      this.log('Cancelled.');
      return {deleted: false};
    }

    const client = await this.client(flags);
    const response = await client.mutateDataset(args.id, {
      operation: 'delete',
      recordId: args['record-id'],
    });
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Record ${args['record-id']} deleted`);
    }

    return {deleted: true, recordId: args['record-id']};
  }
}

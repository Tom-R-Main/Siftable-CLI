import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class DatasetsDelete extends BaseCommand {
  static description = 'Delete a dataset and its physical table';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({char: 'y', description: 'Confirm dataset deletion without prompting'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsDelete);
    const confirmed = await this.confirmAction(
      `Delete dataset ${args.id}? This removes the physical dataset table and archives the backing note.`,
      flags,
    );
    if (!confirmed) {
      this.log('Delete cancelled.');
      return {ok: false, deleted: false, cancelled: true, id: args.id};
    }

    const client = await this.client(flags);
    const response = await client.deleteDataset(args.id);
    this.handleApiError(response);

    const result = {ok: true, deleted: true, id: args.id};
    if (!this.jsonEnabled()) {
      this.log(`Deleted dataset ${args.id}.`);
    }

    return result;
  }
}

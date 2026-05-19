import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class DatasetsArchive extends BaseCommand {
  static description = 'Archive a dataset without dropping its physical table';

  static args = {
    id: Args.string({description: 'Dataset ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({char: 'y', description: 'Confirm dataset archival without prompting'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(DatasetsArchive);
    const confirmed = await this.confirmAction(
      `Archive dataset ${args.id}? This hides the backing note but keeps the dataset table available for recovery.`,
      flags,
    );
    if (!confirmed) {
      this.log('Archive cancelled.');
      return {ok: false, archived: false, cancelled: true, id: args.id};
    }

    const client = await this.client(flags);
    const response = await client.archiveDataset(args.id);
    this.handleApiError(response);

    const result = {
      ok: true,
      archived: true,
      id: args.id,
      dataset: (response.data as Record<string, unknown> | undefined)?.dataset,
    };
    if (!this.jsonEnabled()) {
      this.log(`Archived dataset ${args.id}.`);
    }

    return result;
  }
}

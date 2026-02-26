import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class CodebaseDelete extends BaseCommand {
  static description = 'Delete a repository and all indexed data';

  static args = {
    id: Args.string({description: 'Repository ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({char: 'y', description: 'Skip confirmation'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodebaseDelete);

    const confirmed = await this.confirmAction('Delete this repository and all indexed data?', flags);
    if (!confirmed) {
      this.log('Cancelled.');
      return {deleted: false};
    }

    const client = await this.client(flags);
    const response = await client.deleteCodeRepository(args.id);
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Repository ${args.id} deleted`);
    }

    return {deleted: true, id: args.id};
  }
}

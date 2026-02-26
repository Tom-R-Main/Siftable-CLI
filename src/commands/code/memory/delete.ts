import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class CodeMemoryDelete extends BaseCommand {
  static description = 'Delete a stored codebase fact';

  static args = {
    id: Args.string({description: 'Memory ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({char: 'y', description: 'Skip confirmation'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodeMemoryDelete);

    const confirmed = await this.confirmAction('Delete this fact?', flags);
    if (!confirmed) {
      this.log('Cancelled.');
      return {deleted: false};
    }

    const client = await this.client(flags);
    const response = await client.deleteCodeMemory(args.id);
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Fact ${args.id} deleted`);
    }

    return {deleted: true, id: args.id};
  }
}

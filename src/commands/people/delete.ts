import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class PeopleDelete extends BaseCommand {
  static description = 'Delete a contact';

  static args = {
    id: Args.string({description: 'Person ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({char: 'y', description: 'Skip confirmation'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PeopleDelete);

    const confirmed = await this.confirmAction('Delete this contact?', flags);
    if (!confirmed) {
      this.log('Cancelled.');
      return {deleted: false};
    }

    const client = await this.client(flags);
    const response = await client.deletePerson(args.id);
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Person ${args.id} deleted`);
    }

    return {deleted: true, id: args.id};
  }
}

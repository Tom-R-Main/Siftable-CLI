import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class OrganizationsDelete extends BaseCommand {
  static description = 'Delete an organization';

  static args = {
    id: Args.string({description: 'Organization ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({char: 'y', description: 'Skip confirmation'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(OrganizationsDelete);

    const confirmed = await this.confirmAction('Delete this organization? (People will be unlinked but not deleted)', flags);
    if (!confirmed) {
      this.log('Cancelled.');
      return {deleted: false};
    }

    const client = await this.client(flags);
    const response = await client.deleteOrganization(args.id);
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Organization ${args.id} deleted`);
    }

    return {deleted: true, id: args.id};
  }
}

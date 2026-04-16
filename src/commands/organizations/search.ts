import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class OrganizationsSearch extends BaseCommand {
  static description = 'Search organizations';

  static args = {
    query: Args.string({description: 'Search query', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({description: 'Maximum number of results'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(OrganizationsSearch);
    const client = await this.client(flags);
    const response = await client.searchOrganizations(args.query, flags.limit);
    this.handleApiError(response);

    const organizations = this.unwrapList(response, 'organizations');

    if (!this.jsonEnabled()) {
      renderTable(organizations, [
        {key: 'id', header: 'ID'},
        {key: 'name', header: 'Name'},
        {key: 'domain', header: 'Domain'},
        {key: 'industry', header: 'Industry'},
        {key: 'relationshipStatus', header: 'Status'},
      ]);
    }

    return organizations;
  }
}

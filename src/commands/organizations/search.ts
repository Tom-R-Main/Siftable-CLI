import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class OrganizationsSearch extends BaseCommand {
  static description = 'Search organizations';

  static args = {
    query: Args.string({description: 'Optional fuzzy search query', required: false}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({description: 'Maximum number of results'}),
    'starts-with': Flags.string({description: 'Name prefix filter'}),
    contains: Flags.string({description: 'Name substring filter'}),
    equals: Flags.string({description: 'Exact name filter'}),
    type: Flags.string({description: 'Filter by organization type'}),
    relationship: Flags.string({description: 'Filter by relationship status'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(OrganizationsSearch);
    const client = await this.client(flags);
    const response = await client.searchOrganizations({
      query: args.query,
      limit: flags.limit,
      nameStartsWith: flags['starts-with'],
      nameContains: flags.contains,
      nameEquals: flags.equals,
      type: flags.type,
      relationshipStatus: flags.relationship,
    });
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

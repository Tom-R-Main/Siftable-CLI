import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class VaultSearch extends BaseCommand {
  static description = 'Search vault entries (metadata only; requires vault:metadata:read)';

  static requiredScope = 'vault:metadata:read';

  static args = {
    query: Args.string({description: 'Search query', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({description: 'Maximum number of results'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(VaultSearch);
    const client = await this.client(flags);
    const response = await client.searchVaultEntries(args.query, flags.limit);
    this.handleApiError(response);

    const entries = this.unwrapList(response, 'entries');

    if (!this.jsonEnabled()) {
      renderTable(entries, [
        {key: 'id', header: 'ID'},
        {key: 'name', header: 'Name'},
        {key: 'entryType', header: 'Type'},
        {key: 'category', header: 'Category'},
      ]);
    }

    return entries;
  }
}

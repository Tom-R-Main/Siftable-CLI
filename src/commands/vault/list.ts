import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class VaultList extends BaseCommand {
  static description = 'List vault entries (metadata only; requires vault:metadata:read)';

  static requiredScope = 'vault:metadata:read';

  static flags = {
    ...BaseCommand.baseFlags,
    type: Flags.string({
      description: 'Filter by entry type',
      options: ['env_var', 'credential', 'oauth_token', 'ssh_key', 'certificate', 'note'],
    }),
    category: Flags.string({description: 'Filter by category'}),
    limit: Flags.integer({description: 'Maximum number of results'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(VaultList);
    const client = await this.client(flags);
    const response = await client.listVaultEntries({
      entryType: flags.type,
      category: flags.category,
      limit: flags.limit,
    });
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

import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';
import {
  projectVaultEntries,
  resolveVaultOwnerContext,
  vaultApiFlags,
  vaultOwnerFlag,
} from '../../lib/vault-owner-context.js';

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
    owner: vaultOwnerFlag,
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(VaultList);
    const owner = resolveVaultOwnerContext(flags);
    const client = await this.client(vaultApiFlags(flags, owner));
    const response = await client.listVaultEntries({
      entryType: flags.type,
      category: flags.category,
      limit: flags.limit,
    });
    this.handleApiError(response);

    const entries = projectVaultEntries(this.unwrapList(response, 'entries'), owner);

    if (!this.jsonEnabled()) {
      renderTable(entries, [
        {key: 'id', header: 'ID'},
        {key: 'name', header: 'Name'},
        {key: 'entryType', header: 'Type'},
        {key: 'category', header: 'Category'},
        {key: 'owner', header: 'Owner'},
        {key: 'qualifiedSlug', header: 'Qualified slug'},
      ]);
    }

    return entries;
  }
}

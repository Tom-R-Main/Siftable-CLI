import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';
import {
  projectVaultEntries,
  resolveVaultOwnerContext,
  vaultApiFlags,
  vaultOwnerFlag,
} from '../../lib/vault-owner-context.js';

export default class VaultSearch extends BaseCommand {
  static description = 'Search vault entries (metadata only; requires vault:metadata:read)';

  static requiredScope = 'vault:metadata:read';

  static args = {
    query: Args.string({description: 'Search query', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({description: 'Maximum number of results'}),
    owner: vaultOwnerFlag,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(VaultSearch);
    const owner = resolveVaultOwnerContext(flags);
    const client = await this.client(vaultApiFlags(flags, owner));
    const response = await client.searchVaultEntries(args.query, flags.limit);
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

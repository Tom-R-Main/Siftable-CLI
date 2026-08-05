import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';
import {resolveVaultOwnerContext, vaultApiFlags, vaultOwnerFlag} from '../../lib/vault-owner-context.js';
import type {SafeMaterializationSource} from '../../lib/vaultMaterializationSource.js';

export default class VaultSearch extends BaseCommand {
  static description = 'Search Vault entry metadata (exact safe field names resolve during materialization; values are never returned)';

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
    const response = await this.apiRequest<{entries: SafeMaterializationSource[]}>(
      vaultApiFlags(flags, owner),
      `/api/v1/vault/materializations/sources?surface=cli&contextContractVersion=${owner.contextContractVersion}&search=${encodeURIComponent(args.query)}`,
    );
    const entries = flags.limit == null
      ? response.entries
      : response.entries.slice(0, Math.max(0, flags.limit));

    if (!this.jsonEnabled()) {
      renderTable(entries, [
        {key: 'id', header: 'ID'},
        {key: 'name', header: 'Name'},
        {key: 'owner', header: 'Owner'},
        {key: 'qualifiedSlug', header: 'Qualified slug'},
      ]);
    }

    return entries;
  }
}

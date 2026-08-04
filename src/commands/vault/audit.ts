import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';
import {resolveVaultOwnerContext, vaultApiFlags, vaultOwnerFlag} from '../../lib/vault-owner-context.js';

export default class VaultAudit extends BaseCommand {
  static description = 'List Vault audit events (requires vault:audit:read)';

  static requiredScope = 'vault:audit:read';

  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({description: 'Maximum number of results'}),
    owner: vaultOwnerFlag,
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(VaultAudit);
    const owner = resolveVaultOwnerContext(flags);
    const client = await this.client(vaultApiFlags(flags, owner));
    const response = await client.listVaultAudit({limit: flags.limit});
    this.handleApiError(response);

    const events = this.unwrapList(response, 'entries');
    if (!this.jsonEnabled()) {
      renderTable(events, [
        {key: 'createdAt', header: 'Time'},
        {key: 'action', header: 'Action'},
        {key: 'vaultEntryId', header: 'Entry'},
        {key: 'accessorType', header: 'Accessor'},
      ]);
    }
    return events;
  }
}

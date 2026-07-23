import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class VaultAudit extends BaseCommand {
  static description = 'List Vault audit events (requires vault:audit:read)';

  static requiredScope = 'vault:audit:read';

  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({description: 'Maximum number of results'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(VaultAudit);
    const client = await this.client(flags);
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

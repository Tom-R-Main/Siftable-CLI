import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {parseCsvIdentifiers} from '../../lib/capability-input.js';

export default class CapabilitiesCreate extends BaseCommand {
  static description = 'Create a reviewed server-brokered Vault capability';

  static flags = {
    ...BaseCommand.baseFlags,
    'vault-entry': Flags.string({description: 'Vault entry UUID', required: true}),
    field: Flags.string({description: 'Credential payload field', default: 'value'}),
    adapter: Flags.string({description: 'Reviewed static adapter ID', required: true}),
    provider: Flags.string({description: 'Provider ID', required: true}),
    operation: Flags.string({description: 'Comma-separated allowlisted operations', required: true}),
    purpose: Flags.string({description: 'Non-secret human-readable purpose', required: true}),
    'expires-in': Flags.integer({description: 'Lifetime in seconds (300-2592000)'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CapabilitiesCreate);
    const response = await this.apiRequest<{
      capability: Record<string, unknown>;
      handle: string;
      warning: string;
    }>(
      flags,
      '/api/v1/vault/capabilities',
      {
        method: 'POST',
        body: {
          surface: 'cli',
          vaultEntryId: flags['vault-entry'],
          credentialField: flags.field,
          adapterId: flags.adapter,
          provider: flags.provider,
          allowedOperations: parseCsvIdentifiers(flags.operation),
          purpose: flags.purpose,
          approvalRequired: true,
          expiresInSeconds: flags['expires-in'],
        },
      },
    );
    if (!this.jsonEnabled()) {
      this.log(`Capability created: ${response.capability.id}`);
      this.log(`Handle: ${response.handle}`);
      this.warn(response.warning);
    }
    return response;
  }
}

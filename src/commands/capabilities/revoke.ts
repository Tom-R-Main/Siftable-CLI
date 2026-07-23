import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class CapabilitiesRevoke extends BaseCommand {
  static description = 'Revoke a Vault capability';

  static args = {
    id: Args.string({description: 'Capability metadata ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CapabilitiesRevoke);
    const response = await this.apiRequest<{capability: Record<string, unknown>}>(
      flags,
      `/api/v1/vault/capabilities/${encodeURIComponent(args.id)}/revoke`,
      {method: 'POST', body: {surface: 'cli'}},
    );
    if (!this.jsonEnabled()) this.log(`Capability revoked: ${response.capability.id}`);
    return response.capability;
  }
}

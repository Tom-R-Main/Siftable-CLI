import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class CapabilitiesDescribe extends BaseCommand {
  static description = 'Describe safe metadata for one Vault capability';

  static args = {
    id: Args.string({description: 'Capability metadata ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CapabilitiesDescribe);
    const response = await this.apiRequest<{capability: Record<string, unknown>}>(
      flags,
      `/api/v1/vault/capabilities/${encodeURIComponent(args.id)}?surface=cli`,
    );
    if (!this.jsonEnabled()) {
      this.log(`Capability: ${response.capability.id}`);
      this.log(`Adapter: ${response.capability.adapterId}`);
      this.log(`Provider: ${response.capability.provider}`);
      this.log(`Operations: ${(response.capability.allowedOperations as string[]).join(', ')}`);
      this.log(`Purpose: ${response.capability.purpose}`);
      this.log(`Expires: ${response.capability.expiresAt}`);
      this.log(`Approval required: ${response.capability.approvalRequired ? 'yes' : 'no'}`);
    }
    return response.capability;
  }
}

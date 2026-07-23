import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class GrantsStatus extends BaseCommand {
  static description = 'Inspect safe status for an ephemeral local execution grant';
  static args = {id: Args.string({required: true})};
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(GrantsStatus);
    const response = await this.apiRequest<{grant: Record<string, unknown>}>(
      flags,
      `/api/v1/vault/execution-grants/${encodeURIComponent(args.id)}?surface=cli`,
    );
    if (!this.jsonEnabled()) {
      this.log(`Grant: ${response.grant.id}`);
      this.log(`Status: ${response.grant.status}`);
      this.log(`Tier: ${response.grant.containmentTier}`);
      this.log(`Expires: ${response.grant.expiresAt}`);
      this.log(`Threat boundary: ${response.grant.threatDisclosure}`);
    }
    return response.grant;
  }
}

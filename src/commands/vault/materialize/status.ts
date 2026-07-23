import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class VaultMaterializeStatus extends BaseCommand {
  static description = 'Inspect safe status for a destination-bound Vault materialization';
  static args = {id: Args.string({required: true})};
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(VaultMaterializeStatus);
    const response = await this.apiRequest<{materialization: Record<string, unknown>}>(
      flags,
      `/api/v1/vault/materializations/${encodeURIComponent(args.id)}?surface=cli`,
    );
    if (!this.jsonEnabled()) {
      this.log(`Materialization: ${response.materialization.id}`);
      this.log(`Status: ${response.materialization.status}`);
      this.log(`Destination: ${response.materialization.destinationPath}`);
      this.log(`Mode: ${response.materialization.requestedMode}`);
      this.log(`Expires: ${response.materialization.expiresAt}`);
    }
    return response.materialization;
  }
}

import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail} from '../../lib/output.js';

export default class VaultRead extends BaseCommand {
  static description = 'Decrypt and read a vault secret (audit-logged)';

  static args = {
    id: Args.string({description: 'Vault entry ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(VaultRead);
    const client = await this.client(flags);
    const response = await client.readVaultSecret(args.id);
    this.handleApiError(response);

    const secret = response.data as Record<string, unknown>;

    if (!this.jsonEnabled()) {
      const payload = secret.payload as Record<string, unknown> | undefined;
      if (payload) {
        renderDetail(Object.entries(payload).map(([k, v]) => [k, v]));
      } else {
        this.log(JSON.stringify(secret, null, 2));
      }
    }

    return response.data;
  }
}

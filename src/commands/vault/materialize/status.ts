import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {resolveVaultOwnerContext, vaultApiFlags, vaultOwnerFlag} from '../../../lib/vault-owner-context.js';

export default class VaultMaterializeStatus extends BaseCommand {
  static description = 'Inspect safe status for a destination-bound Vault materialization';
  static args = {id: Args.string({required: true})};
  static flags = {
    ...BaseCommand.baseFlags,
    owner: vaultOwnerFlag,
    'legacy-context': Flags.boolean({
      description: 'Use the Personal/v0 identity of a request created with the deprecated path-shaped --workspace alias',
      default: false,
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(VaultMaterializeStatus);
    const owner = resolveVaultOwnerContext(flags, {
      legacyMaterializationAlias: flags['legacy-context'],
    });
    const response = await this.apiRequest<{materialization: Record<string, unknown>}>(
      vaultApiFlags(flags, owner),
      `/api/v1/vault/materializations/${encodeURIComponent(args.id)}?surface=cli&contextContractVersion=${owner.contextContractVersion}`,
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

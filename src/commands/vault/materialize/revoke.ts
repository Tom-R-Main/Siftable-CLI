import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {resolveVaultOwnerContext, vaultApiFlags, vaultOwnerFlag} from '../../../lib/vault-owner-context.js';
import {withMaterializationRecovery} from '../materialization-source.js';

export default class VaultMaterializeRevoke extends BaseCommand {
  static description = 'Revoke a pending destination-bound Vault materialization';

  static args = {id: Args.string({description: 'Materialization ID', required: true})};

  static flags = {
    ...BaseCommand.baseFlags,
    owner: vaultOwnerFlag,
    'legacy-context': Flags.boolean({
      description: 'Use the Personal/v0 identity of a request created with the deprecated path-shaped --workspace alias',
      default: false,
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(VaultMaterializeRevoke);
    const owner = resolveVaultOwnerContext(flags, {
      legacyMaterializationAlias: flags['legacy-context'],
    });
    const response = await withMaterializationRecovery(
      () => this.apiRequest<{materialization: Record<string, unknown>}>(
        vaultApiFlags(flags, owner),
        `/api/v1/vault/materializations/${encodeURIComponent(args.id)}/revoke`,
        {
          method: 'POST',
          body: {
            surface: 'cli',
            contextContractVersion: owner.contextContractVersion,
          },
        },
      ),
      {
        type: 'vault_materialization_not_found',
        retryable: false,
        recoveryCommand: 'sift vault materialize status --help',
      },
    );
    if (!this.jsonEnabled()) {
      this.log(`Materialization revoked: ${response.materialization.id}`);
    }
    return response.materialization;
  }
}

import {BaseCommand} from '../../../lib/base-command.js';
import {
  projectEnvironmentLeaseMetadata,
  type EnvironmentLeaseApiRecord,
} from '../../../lib/environmentLeaseApi.js';
import {resolveVaultOwnerContext, vaultApiFlags, vaultOwnerFlag} from '../../../lib/vault-owner-context.js';

export default class VaultLeasesList extends BaseCommand {
  static aliases = ['env leases list'];
  static description = 'List value-free environment lease and cleanup metadata';
  static flags = {...BaseCommand.baseFlags, owner: vaultOwnerFlag};

  async run(): Promise<unknown> {
    const {flags} = await this.parse(VaultLeasesList);
    const owner = resolveVaultOwnerContext({owner: flags.owner, workspace: flags.workspace});
    const response = await this.apiRequest<{leases: EnvironmentLeaseApiRecord[]}>(
      vaultApiFlags(flags, owner),
      `/api/v1/vault/materializations/leases?surface=cli&contextContractVersion=${owner.contextContractVersion}`,
    );
    const leases = response.leases.map(projectEnvironmentLeaseMetadata);
    if (!this.jsonEnabled()) {
      for (const lease of leases) {
        this.log(
          `${lease.id}  ${lease.owner}  bundle=${lease.bundleDigest}  holder=${lease.holder}`
          + `  ${lease.lifecycle}  cleanup=${lease.cleanup.state}  consumer=${lease.consumer}`
          + `  expires=${lease.expiresAt}`,
        );
      }
    }
    return leases;
  }
}

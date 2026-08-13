import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {
  projectEnvironmentLeaseMetadata,
  type EnvironmentLeaseApiRecord,
} from '../../../lib/environmentLeaseApi.js';
import {resolveVaultOwnerContext, vaultApiFlags, vaultOwnerFlag} from '../../../lib/vault-owner-context.js';

export default class VaultLeasesStatus extends BaseCommand {
  static aliases = ['env leases status'];
  static description = 'Inspect one value-free environment lease lifecycle';
  static args = {id: Args.string({required: true})};
  static flags = {...BaseCommand.baseFlags, owner: vaultOwnerFlag};

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(VaultLeasesStatus);
    const owner = resolveVaultOwnerContext({owner: flags.owner, workspace: flags.workspace});
    const response = await this.apiRequest<{lease: EnvironmentLeaseApiRecord}>(
      vaultApiFlags(flags, owner),
      `/api/v1/vault/materializations/leases/${encodeURIComponent(args.id)}?surface=cli&contextContractVersion=${owner.contextContractVersion}`,
    );
    const lease = projectEnvironmentLeaseMetadata(response.lease);
    if (!this.jsonEnabled()) {
      this.log(`Lease: ${lease.id}`);
      this.log(`Owner: ${lease.owner}`);
      this.log(`Bundle: ${lease.bundleDigest}`);
      this.log(`Holder: ${lease.holder}`);
      this.log(`Consumer: ${lease.consumer}`);
      this.log(`Lifecycle: ${lease.lifecycle}`);
      this.log(`Cleanup: ${lease.cleanup.state}`);
      this.log(`Expires: ${lease.expiresAt}`);
    }
    return lease;
  }
}

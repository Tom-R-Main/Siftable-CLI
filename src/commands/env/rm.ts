import {Flags} from '@oclif/core';
import path from 'node:path';
import {
  buildEnvironmentBundleContract,
  readManagedEnvironmentBundleReceipt,
  removeManagedEnvironmentBundle,
} from '../../lib/environmentBundle.js';
import {loadEnvironmentManifest} from '../../lib/environmentCommand.js';
import {checkoutRootFlag, OfflineEnvironmentCommand} from '../../lib/offlineEnvironmentCommand.js';

export default class EnvRm extends OfflineEnvironmentCommand {
  static summary = 'Remove one exact Sift-managed local environment file';
  static description = 'Removes only a recognized managed file after exact contract, path, file-identity, and content-stability checks. It cannot erase copies, backups, logs, or values retained by processes.';
  static flags = {
    'checkout-root': checkoutRootFlag,
    destination: Flags.string({description: 'Exact relative destination when the manifest declares more than one bundle'}),
    yes: Flags.boolean({required: true, description: 'Confirm removal of the exact recognized managed file'}),
  };

  async run(): Promise<{
    removed: true;
    destination: string;
    plaintextRecallPossible: false;
  }> {
    const {flags} = await this.parse(EnvRm);
    const checkoutRoot = this.resolveCheckoutRoot(flags['checkout-root']);
    const manifest = await loadEnvironmentManifest(checkoutRoot);
    const destinations = [...new Set(manifest.members
      .filter(member => member.kind === 'vault_field')
      .map(member => member.destination.path))];
    const destination = flags.destination ?? (destinations.length === 1 ? destinations[0] : undefined);
    if (!destination || !destinations.includes(destination)) {
      this.error('Choose one exact managed destination with --destination.');
    }
    const contract = buildEnvironmentBundleContract(manifest, path.resolve(checkoutRoot), destination);
    const receipt = await readManagedEnvironmentBundleReceipt(contract);
    const removed = await removeManagedEnvironmentBundle(contract, receipt);
    const result = {...removed, plaintextRecallPossible: false as const};
    if (!this.jsonEnabled()) {
      this.log(`Removed ${result.destination}.`);
      this.warn('Future pulls remain governed. Copies, backups, logs, and values already retained by processes may remain.');
    }
    return result;
  }
}

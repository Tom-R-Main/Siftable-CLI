import type {EnvironmentInspectionReport} from '../../lib/environmentCommand.js';
import {checkoutRootFlag, OfflineEnvironmentCommand} from '../../lib/offlineEnvironmentCommand.js';

export default class EnvStatus extends OfflineEnvironmentCommand {
  static summary = 'Report value-free local environment state';
  static description = 'Inspect .sift/environment.yaml and report absent, managed_current, managed_stale, modified_locally, unmanaged, or managed_unknown_freshness without reading destination values.';
  static flags = {'checkout-root': checkoutRootFlag};

  async run(): Promise<EnvironmentInspectionReport> {
    const {flags} = await this.parse(EnvStatus);
    const report = await this.inspect(this.resolveCheckoutRoot(flags['checkout-root']));
    this.printInspection(report);
    return report;
  }
}

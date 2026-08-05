import type {EnvironmentInspectionReport} from '../../lib/environmentCommand.js';
import {checkoutRootFlag, OfflineEnvironmentCommand} from '../../lib/offlineEnvironmentCommand.js';

export default class EnvDiff extends OfflineEnvironmentCommand {
  static summary = 'Show value-free environment contract drift';
  static description = 'Compare .sift/environment.yaml with checkout safety, effective Git ignore policy, local receipt metadata, and the generated example. This command is offline and never reads destination values.';
  static flags = {'checkout-root': checkoutRootFlag};

  async run(): Promise<EnvironmentInspectionReport> {
    const {flags} = await this.parse(EnvDiff);
    const report = await this.inspect(this.resolveCheckoutRoot(flags['checkout-root']));
    this.printInspection(report);
    if (!report.ok) this.error('Environment contract diff found unsafe or stale state.', {exit: 1});
    return report;
  }
}

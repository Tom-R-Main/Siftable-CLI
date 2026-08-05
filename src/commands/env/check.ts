import {Flags} from '@oclif/core';
import type {EnvironmentInspectionReport} from '../../lib/environmentCommand.js';
import {checkoutRootFlag, OfflineEnvironmentCommand} from './offline-command.js';

export default class EnvCheck extends OfflineEnvironmentCommand {
  static summary = 'Validate the environment contract for local or CI use';
  static description = 'Author the contract in .sift/environment.yaml first, run sift env check --ci, then generate the names-only example with sift env example. Validation is offline and approval-free.';
  static flags = {
    'checkout-root': checkoutRootFlag,
    ci: Flags.boolean({description: 'Fail non-zero when contract, example, Git, or checkout safety findings exist'}),
  };

  async run(): Promise<EnvironmentInspectionReport> {
    const {flags} = await this.parse(EnvCheck);
    const report = await this.inspect(this.resolveCheckoutRoot(flags['checkout-root']));
    this.printInspection(report);
    if (flags.ci && !report.ok) this.error('Environment contract check failed.', {exit: 1});
    return report;
  }
}

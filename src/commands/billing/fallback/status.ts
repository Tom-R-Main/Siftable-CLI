import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class BillingFallbackStatus extends BaseCommand {
  static description = 'Show your active personal-fallback decisions for a workspace';

  static flags = {
    ...BaseCommand.baseFlags,
    workspace: Flags.string({description: 'Workspace org ID', required: true}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(BillingFallbackStatus);
    const result = await this.apiRequest<{consents: unknown[]}>(
      flags,
      `/api/v1/billing/usage/personal-fallback/${flags.workspace}`,
    );
    if (!this.jsonEnabled()) {
      this.log(result.consents.length === 0
        ? 'No active personal fallback decisions.'
        : JSON.stringify(result.consents, null, 2));
    }
    return result;
  }
}

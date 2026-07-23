import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class BillingFallbackDecide extends BaseCommand {
  static description = 'Allow, deny, or always allow personal funding for a quoted workspace operation';

  static flags = {
    ...BaseCommand.baseFlags,
    workspace: Flags.string({description: 'Workspace org ID', required: true}),
    quote: Flags.string({description: 'Server-issued operation quote ID', required: true}),
    decision: Flags.string({options: ['allow', 'deny', 'always_allow'], required: true}),
    'monthly-cap-micros': Flags.string({description: 'Monthly micro-USD cap for always_allow'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(BillingFallbackDecide);
    if (flags.decision === 'always_allow' && !flags['monthly-cap-micros']) {
      this.error('always_allow requires --monthly-cap-micros. Unlimited can only be enabled in a recently authenticated browser session.');
    }
    const result = await this.apiRequest(
      flags,
      `/api/v1/billing/usage/personal-fallback/${flags.workspace}/decision`,
      {
        method: 'POST',
        body: {
          quoteId: flags.quote,
          decision: flags.decision,
          monthlyCapMicros: flags['monthly-cap-micros'] ?? null,
          unlimited: false,
        },
      },
    );
    if (!this.jsonEnabled()) this.log('Personal fallback decision saved.');
    return result;
  }
}

import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class BillingFallbackRevoke extends BaseCommand {
  static description = 'Revoke one of your active personal-fallback consents';

  static args = {consentId: Args.string({required: true})};

  static flags = {
    ...BaseCommand.baseFlags,
    workspace: Flags.string({description: 'Workspace org ID', required: true}),
  };

  async run(): Promise<{revoked: true}> {
    const {args, flags} = await this.parse(BillingFallbackRevoke);
    await this.apiRequest(
      flags,
      `/api/v1/billing/usage/personal-fallback/${flags.workspace}/consents/${args.consentId}`,
      {method: 'DELETE'},
    );
    if (!this.jsonEnabled()) this.log('Personal fallback consent revoked.');
    return {revoked: true};
  }
}

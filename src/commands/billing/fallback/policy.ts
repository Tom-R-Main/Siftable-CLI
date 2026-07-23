import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class BillingFallbackPolicy extends BaseCommand {
  static description = 'Read or update the workspace personal-fallback policy';

  static flags = {
    ...BaseCommand.baseFlags,
    workspace: Flags.string({description: 'Workspace org ID', required: true}),
    enabled: Flags.boolean({description: 'Enable personal fallback'}),
    disabled: Flags.boolean({description: 'Disable and revoke personal fallback'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(BillingFallbackPolicy);
    if (flags.enabled && flags.disabled) this.error('Choose only one of --enabled or --disabled.');
    const path = `/api/v1/billing/orgs/${flags.workspace}/personal-fallback-policy`;
    const result = flags.enabled || flags.disabled
      ? await this.apiRequest(flags, path, {
          method: 'PUT',
          body: {enabled: flags.enabled && !flags.disabled},
        })
      : await this.apiRequest(flags, path);
    if (!this.jsonEnabled()) this.log(JSON.stringify(result, null, 2));
    return result;
  }
}

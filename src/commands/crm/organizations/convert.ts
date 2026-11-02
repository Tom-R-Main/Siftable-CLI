import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class CrmOrganizationsConvert extends BaseCommand {
  static description = 'Explain the governed boundary between a CRM organization and a workspace';

  static args = {
    id: Args.string({description: 'CRM organization ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<never> {
    const {args} = await this.parse(CrmOrganizationsConvert);
    this.error(
      `CRM organization ${args.id} cannot be converted by the CLI. `
      + 'Workspace creation is a governed, audited action. Open https://siftable.io/app/settings/workspaces, then run `sift workspaces list` and `sift workspaces use <id>`.',
      {exit: 2},
    );
  }
}

import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class ApprovalsStatus extends BaseCommand {
  static description = 'Inspect a governed approval requested by this CLI identity';

  static args = {
    id: Args.string({description: 'Approval ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ApprovalsStatus);
    const response = await this.apiRequest<{approval: Record<string, unknown>}>(
      flags,
      `/api/v1/governed-approvals/${encodeURIComponent(args.id)}?surface=cli`,
    );
    const approval = response.approval;
    if (!this.jsonEnabled()) {
      this.log(`Approval: ${approval.id}`);
      this.log(`Status: ${approval.status}`);
      this.log(`Action: ${approval.action}`);
      this.log(`Resource: ${approval.resourceType}/${approval.resourceId}`);
      this.log(`Expires: ${approval.expiresAt}`);
    }
    return approval;
  }
}

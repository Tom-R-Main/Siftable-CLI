import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class WorkClaim extends BaseCommand {
  static description = 'Claim the next available agent work item';

  static args = {
    id: Args.string({description: 'Optional specific work item ID', required: false}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    agent: Flags.string({description: 'Agent alias to claim for'}),
    owner: Flags.string({description: 'Claim owner identity', required: true}),
    lease: Flags.integer({description: 'Lease seconds', default: 1800}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkClaim);
    const client = await this.client(flags);
    const response = await client.claimWorkItem({
      workItemId: args.id,
      assignedAlias: flags.agent,
      claimOwner: flags.owner,
      leaseSeconds: flags.lease,
    });
    this.handleApiError(response);
    const workItem = this.unwrapOne(response, 'workItem');
    if (!this.jsonEnabled()) {
      this.log(`Work item claimed: ${workItem.id}`);
      this.log(`Claim token: ${workItem.claimToken}`);
    }
    return response.data;
  }
}

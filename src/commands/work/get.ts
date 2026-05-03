import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class WorkGet extends BaseCommand {
  static description = 'Get an agent work item';

  static args = {
    id: Args.string({description: 'Work item ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkGet);
    const client = await this.client(flags);
    const response = await client.getWorkItem(args.id);
    this.handleApiError(response);
    const workItem = this.unwrapOne(response, 'workItem');
    if (!this.jsonEnabled()) {
      this.log(`${workItem.title}`);
      this.log(`Status: ${workItem.status}`);
      if (workItem.assignedAlias) this.log(`Agent: ${(workItem.assignedAlias as any).alias}`);
      if (workItem.claimOwner) this.log(`Claim owner: ${workItem.claimOwner}`);
    }
    return workItem;
  }
}

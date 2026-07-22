import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {formatClaimability, formatDependencies} from '../../lib/work-dependencies.js';

function redactClaimToken(workItem: Record<string, unknown>): Record<string, unknown> {
  const {claimToken: _claimToken, ...safeWorkItem} = workItem;
  return safeWorkItem;
}

export default class WorkGet extends BaseCommand {
  static description = 'Get executable agent work item details';

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
    const workItem = redactClaimToken(this.unwrapOne(response, 'workItem'));
    if (!this.jsonEnabled()) {
      this.log(`${workItem.title}`);
      this.log(`Status: ${workItem.status}`);
      if (workItem.taskId) this.log(`Parent task: ${workItem.taskId}`);
      if (workItem.assignedAlias) this.log(`Agent: ${(workItem.assignedAlias as any).alias}`);
      if (workItem.claimOwner) this.log(`Claim owner: ${workItem.claimOwner}`);
      this.log(`Depends on: ${formatDependencies(workItem.dependencies)}`);
      this.log(`Claimability: ${formatClaimability(workItem.claimability)}`);
    }
    return workItem;
  }
}

import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class WorkDependenciesGet extends BaseCommand {
  static description = 'Get authoritative dependencies and claimability for a work item';

  static args = {
    id: Args.string({description: 'Work item UUID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkDependenciesGet);
    const client = await this.client(flags);
    const response = await client.getWorkItem(args.id);
    this.handleApiError(response);
    const workItem = this.unwrapOne(response, 'workItem');
    const result = {
      workItemId: workItem.id,
      dependencies: Array.isArray(workItem.dependencies) ? workItem.dependencies : [],
      claimability: workItem.claimability ?? null,
    };
    if (!this.jsonEnabled()) {
      this.log(JSON.stringify(result, null, 2));
    }
    return result;
  }
}

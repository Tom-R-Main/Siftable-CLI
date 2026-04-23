import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class TasksCouplingDelete extends BaseCommand {
  static description = 'Delete a CSN coupling edge from a task';

  static args = {
    id: Args.string({description: 'Task ID', required: true}),
    edgeId: Args.string({description: 'Coupling edge ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({char: 'y', description: 'Skip confirmation'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(TasksCouplingDelete);
    const confirmed = await this.confirmAction('Delete this coupling edge?', flags);
    if (!confirmed) {
      this.log('Cancelled.');
      return {deleted: false};
    }

    const client = await this.client(flags);
    const response = await client.deleteTaskCouplingEdge(args.id, args.edgeId);
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Coupling edge ${args.edgeId} deleted`);
    }

    return {deleted: true, taskId: args.id, edgeId: args.edgeId};
  }
}

import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class TasksCouplingList extends BaseCommand {
  static description = 'List CSN coupling edges for a task';

  static args = {
    id: Args.string({description: 'Task ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(TasksCouplingList);
    const client = await this.client(flags);
    const response = await client.listTaskCouplingEdges(args.id);
    this.handleApiError(response);

    const edges = this.unwrapList(response, 'edges');

    if (!this.jsonEnabled()) {
      renderTable(edges, [
        {key: 'id', header: 'Edge ID'},
        {key: 'sourceTaskId', header: 'Source'},
        {key: 'targetTaskId', header: 'Target'},
        {key: 'couplingType', header: 'Type'},
        {key: 'strength', header: 'Strength'},
      ]);
    }

    return edges;
  }
}

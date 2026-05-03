import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class AgentsWork extends BaseCommand {
  static description = 'List work assigned to an agent alias';

  static args = {
    alias: Args.string({description: 'Agent alias or ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    status: Flags.string({description: 'Work item status'}),
    limit: Flags.integer({description: 'Maximum results'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(AgentsWork);
    const client = await this.client(flags);
    const response = await client.listWorkItems({
      assignedAlias: args.alias,
      status: flags.status,
      limit: flags.limit,
    });
    this.handleApiError(response);
    const workItems = this.unwrapList(response, 'workItems');

    if (!this.jsonEnabled()) {
      renderTable(workItems, [
        {key: 'id', header: 'ID'},
        {key: 'title', header: 'Title'},
        {key: 'status', header: 'Status'},
        {key: 'queueRank', header: 'Rank'},
      ]);
    }

    return workItems;
  }
}

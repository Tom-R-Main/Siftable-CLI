import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class WorkList extends BaseCommand {
  static description = 'List agent work items';

  static flags = {
    ...BaseCommand.baseFlags,
    status: Flags.string({description: 'Filter by status'}),
    agent: Flags.string({description: 'Filter by assigned agent alias'}),
    project: Flags.string({description: 'Filter by project ID'}),
    task: Flags.string({description: 'Filter by task ID'}),
    limit: Flags.integer({description: 'Maximum results'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(WorkList);
    const client = await this.client(flags);
    const response = await client.listWorkItems({
      status: flags.status,
      assignedAlias: flags.agent,
      projectId: flags.project,
      taskId: flags.task,
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
        {key: 'claimOwner', header: 'Owner', get: (r) => (r.claimOwner as string) || '-'},
      ]);
    }
    return workItems;
  }
}

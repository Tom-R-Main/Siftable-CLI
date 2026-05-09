import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

function redactClaimToken(workItem: Record<string, unknown>): Record<string, unknown> {
  const {claimToken: _claimToken, ...safeWorkItem} = workItem;
  return safeWorkItem;
}

export default class WorkList extends BaseCommand {
  static description = 'List executable agent work items';

  static flags = {
    ...BaseCommand.baseFlags,
    status: Flags.string({description: 'Filter by status'}),
    agent: Flags.string({description: 'Filter by assigned agent alias'}),
    project: Flags.string({description: 'Filter by project ID'}),
    task: Flags.string({description: 'Filter by parent human planning task ID'}),
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
    const workItems = this.unwrapList(response, 'workItems').map(redactClaimToken);
    if (!this.jsonEnabled()) {
      renderTable(workItems, [
        {key: 'id', header: 'ID'},
        {key: 'title', header: 'Title'},
        {key: 'status', header: 'Status'},
        {key: 'taskId', header: 'Task', get: (r) => (r.taskId as string) || '-'},
        {key: 'assignedAlias', header: 'Agent', get: (r) => {
          const alias = r.assignedAlias as string | {alias?: string} | undefined;
          return typeof alias === 'string' ? alias : alias?.alias || '-';
        }},
        {key: 'queueRank', header: 'Rank'},
        {key: 'claimOwner', header: 'Owner', get: (r) => (r.claimOwner as string) || '-'},
      ]);
    }
    return workItems;
  }
}

import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class TasksList extends BaseCommand {
  static description = 'List tasks';

  static examples = [
    '<%= config.bin %> tasks list',
    '<%= config.bin %> tasks list --status in_progress',
    '<%= config.bin %> tasks list --project <project-id> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    status: Flags.string({
      description: 'Filter by status',
      options: ['inbox', 'next_action', 'in_progress', 'waiting_for', 'completed', 'archived'],
    }),
    project: Flags.string({description: 'Filter by project ID'}),
    limit: Flags.integer({description: 'Maximum number of results'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(TasksList);
    const client = await this.client(flags);
    const response = await client.listTasks({
      status: flags.status,
      projectId: flags.project,
      limit: flags.limit,
    });
    this.handleApiError(response);

    const tasks = this.unwrapList(response, 'tasks');

    if (!this.jsonEnabled()) {
      renderTable(tasks, [
        {key: 'id', header: 'ID'},
        {key: 'title', header: 'Title'},
        {key: 'status', header: 'Status'},
        {key: 'priority', header: 'Priority'},
        {key: 'dueAt', header: 'Due', get: (r) => r.dueAt ? new Date(r.dueAt as string).toLocaleDateString() : '—'},
      ]);
    }

    return tasks;
  }
}

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
    phase: Flags.string({
      description: 'Filter by phase',
      options: ['draft', 'open', 'in_flight', 'review', 'blocked', 'done', 'cancelled'],
    }),
    effort: Flags.string({
      description: 'Filter by effort',
      options: ['trivial', 'small', 'medium', 'large', 'epic', 'unknown'],
    }),
    'executor-agent': Flags.string({
      description: 'Filter by executor agent',
      options: ['claude_code', 'openclaw', 'cursor', 'windsurf'],
    }),
    'title-starts-with': Flags.string({description: 'Title prefix filter'}),
    'title-contains': Flags.string({description: 'Title substring filter'}),
    'title-equals': Flags.string({description: 'Exact title filter'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(TasksList);
    const client = await this.client(flags);
    const response = await client.listTasks({
      status: flags.status,
      projectId: flags.project,
      limit: flags.limit,
      phase: flags.phase,
      effort: flags.effort,
      executorAgent: flags['executor-agent'],
      titleStartsWith: flags['title-starts-with'],
      titleContains: flags['title-contains'],
      titleEquals: flags['title-equals'],
    });
    this.handleApiError(response);

    const tasks = this.unwrapList(response, 'tasks');

    if (!this.jsonEnabled()) {
      renderTable(tasks, [
        {key: 'id', header: 'ID'},
        {key: 'title', header: 'Title'},
        {key: 'phase', header: 'Phase', get: (r) => (r.phase as string) || 'open'},
        {key: 'effort', header: 'Effort', get: (r) => (r.effort as string) || '—'},
        {key: 'status', header: 'Status'},
        {key: 'dueAt', header: 'Due', get: (r) => r.dueAt ? new Date(r.dueAt as string).toLocaleDateString() : '—'},
      ]);
    }

    return tasks;
  }
}

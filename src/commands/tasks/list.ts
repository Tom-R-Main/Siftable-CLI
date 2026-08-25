import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {collectionNavigation} from '../../lib/collection-navigation.js';
import {renderTable} from '../../lib/output.js';

export default class TasksList extends BaseCommand {
  static description = 'List human planning tasks';

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
    cursor: Flags.string({description: 'Continuation cursor from a previous page'}),
    phase: Flags.string({
      description: 'Filter by phase',
      options: ['draft', 'open', 'in_flight', 'review', 'blocked', 'done', 'cancelled'],
    }),
    effort: Flags.string({
      description: 'Filter by effort',
      options: ['trivial', 'small', 'medium', 'large', 'epic', 'unknown'],
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
      cursor: flags.cursor,
      phase: flags.phase,
      effort: flags.effort,
      titleStartsWith: flags['title-starts-with'],
      titleContains: flags['title-contains'],
      titleEquals: flags['title-equals'],
    });
    this.handleApiError(response);

    const tasks = this.unwrapList(response, 'tasks');
    const data = response.data as Record<string, unknown> | undefined;
    const nextCursor = typeof data?.nextCursor === 'string' ? data.nextCursor : null;
    const totalIsAuthoritative = !flags['title-starts-with'] && !flags['title-equals'];
    const total = totalIsAuthoritative && Number.isInteger(data?.totalCount)
      ? data?.totalCount as number
      : null;
    const result = {
      ok: true,
      tasks,
      ...collectionNavigation(tasks.length, flags.limit ?? Math.max(tasks.length, 1), {
        nextCursor,
        total,
        cursorSupported: true,
      }),
    };

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

    return result;
  }
}

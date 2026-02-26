import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class TasksUpdate extends BaseCommand {
  static description = 'Update a task';

  static args = {
    id: Args.string({description: 'Task ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Task title'}),
    description: Flags.string({description: 'Task description'}),
    status: Flags.string({
      description: 'Task status',
      options: ['inbox', 'next_action', 'in_progress', 'waiting_for', 'completed', 'archived'],
    }),
    priority: Flags.string({
      description: 'Priority level',
      options: ['do_now', 'schedule', 'delegate', 'someday'],
    }),
    due: Flags.string({description: 'Due date (ISO 8601)'}),
    project: Flags.string({description: 'Project ID'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(TasksUpdate);
    const client = await this.client(flags);

    const updates: Record<string, unknown> = {};
    if (flags.title !== undefined) updates.title = flags.title;
    if (flags.description !== undefined) updates.description = flags.description;
    if (flags.status !== undefined) updates.status = flags.status;
    if (flags.priority !== undefined) updates.priority = flags.priority;
    if (flags.due !== undefined) updates.dueAt = flags.due;
    if (flags.project !== undefined) updates.projectId = flags.project;

    const response = await client.updateTask(args.id, updates, this.idempotencyKey());
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Task ${args.id} updated`);
    }

    return response.data;
  }
}

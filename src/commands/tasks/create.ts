import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class TasksCreate extends BaseCommand {
  static description = 'Create a task';

  static examples = [
    '<%= config.bin %> tasks create --title "Review PR"',
    '<%= config.bin %> tasks create --title "Ship feature" --priority do_now --due 2026-03-01',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Task title', required: true}),
    description: Flags.string({description: 'Task description'}),
    priority: Flags.string({
      description: 'Priority level',
      options: ['do_now', 'schedule', 'delegate', 'someday'],
    }),
    due: Flags.string({description: 'Due date (ISO 8601)'}),
    project: Flags.string({description: 'Project ID'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(TasksCreate);
    const client = await this.client(flags);
    const response = await client.createTask(
      {
        title: flags.title,
        description: flags.description,
        priority: flags.priority as 'do_now' | 'schedule' | 'delegate' | 'someday' | undefined,
        dueAt: flags.due,
        projectId: flags.project,
      },
      this.idempotencyKey(),
    );
    this.handleApiError(response);

    const task = this.unwrapOne(response, 'task');

    if (!this.jsonEnabled()) {
      this.log(`Task created: ${task.id}`);
    }

    return response.data;
  }
}

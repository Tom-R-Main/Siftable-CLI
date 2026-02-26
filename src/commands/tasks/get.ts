import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, formatDate} from '../../lib/output.js';

export default class TasksGet extends BaseCommand {
  static description = 'Get task details';

  static args = {
    id: Args.string({description: 'Task ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(TasksGet);
    const client = await this.client(flags);
    const response = await client.getTask(args.id);
    this.handleApiError(response);

    const task = this.unwrapOne(response, 'task');

    if (!this.jsonEnabled()) {
      renderDetail([
        ['ID', task.id],
        ['Title', task.title],
        ['Status', task.status],
        ['Priority', task.priority],
        ['Description', task.description],
        ['Due', formatDate(task.dueAt as string)],
        ['Project', task.projectId],
        ['Created', formatDate(task.createdAt as string)],
        ['Updated', formatDate(task.updatedAt as string)],
      ]);
    }

    return response.data;
  }
}

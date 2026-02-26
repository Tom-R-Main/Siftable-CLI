import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class TasksComplete extends BaseCommand {
  static description = 'Mark a task as complete';

  static args = {
    id: Args.string({description: 'Task ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(TasksComplete);
    const client = await this.client(flags);
    const response = await client.completeTask(args.id, this.idempotencyKey());
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Task ${args.id} completed`);
    }

    return response.data;
  }
}

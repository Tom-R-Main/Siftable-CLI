import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class TasksDelete extends BaseCommand {
  static description = 'Delete a task';

  static args = {
    id: Args.string({description: 'Task ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({char: 'y', description: 'Skip confirmation'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(TasksDelete);

    const confirmed = await this.confirmAction('Delete this task?', flags);
    if (!confirmed) {
      this.log('Cancelled.');
      return {deleted: false};
    }

    const client = await this.client(flags);
    const response = await client.deleteTask(args.id);
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Task ${args.id} deleted`);
    }

    return {deleted: true, id: args.id};
  }
}

import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class CodeLink extends BaseCommand {
  static description = 'Link a task to code (file, commit, or repository)';

  static args = {
    'task-id': Args.string({description: 'Task ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    repo: Flags.string({description: 'Repository ID', required: true}),
    file: Flags.string({description: 'File path'}),
    commit: Flags.string({description: 'Commit SHA'}),
    notes: Flags.string({description: 'Notes about the link'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodeLink);
    const client = await this.client(flags);
    const response = await client.linkTaskToCode(args['task-id'], {
      repositoryId: flags.repo,
      filePath: flags.file,
      commitSha: flags.commit,
      notes: flags.notes,
    });
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Task ${args['task-id']} linked to code`);
    }

    return response.data;
  }
}

import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class ProjectsArchive extends BaseCommand {
  static description = 'Archive a project';

  static args = {
    id: Args.string({description: 'Project ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({char: 'y', description: 'Skip confirmation'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ProjectsArchive);

    const confirmed = await this.confirmAction('Archive this project?', flags);
    if (!confirmed) {
      this.log('Cancelled.');
      return {archived: false};
    }

    const client = await this.client(flags);
    const response = await client.archiveProject(args.id);
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Project ${args.id} archived`);
    }

    return response.data;
  }
}

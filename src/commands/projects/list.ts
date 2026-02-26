import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class ProjectsList extends BaseCommand {
  static description = 'List projects';

  static flags = {
    ...BaseCommand.baseFlags,
    status: Flags.string({
      description: 'Filter by status',
      options: ['planning', 'active', 'on_hold', 'blocked', 'completed'],
    }),
    'include-archived': Flags.boolean({description: 'Include archived projects'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(ProjectsList);
    const client = await this.client(flags);
    const response = await client.listProjects({
      status: flags.status,
      includeArchived: flags['include-archived'],
    });
    this.handleApiError(response);

    const projects = this.unwrapList(response, 'projects');

    if (!this.jsonEnabled()) {
      renderTable(projects, [
        {key: 'id', header: 'ID'},
        {key: 'emoji', header: ''},
        {key: 'name', header: 'Name'},
        {key: 'status', header: 'Status'},
      ]);
    }

    return projects;
  }
}

import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class ProjectsCreate extends BaseCommand {
  static description = 'Create a project';

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'Project name', required: true}),
    summary: Flags.string({description: 'Project summary'}),
    status: Flags.string({
      description: 'Project status',
      options: ['planning', 'active', 'on_hold', 'blocked', 'completed'],
    }),
    emoji: Flags.string({description: 'Single emoji'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(ProjectsCreate);
    const client = await this.client(flags);
    const response = await client.createProject({
      name: flags.name,
      summary: flags.summary,
      status: flags.status as 'planning' | 'active' | 'on_hold' | 'blocked' | 'completed' | undefined,
      emoji: flags.emoji,
    });
    this.handleApiError(response);

    const project = this.unwrapOne(response, 'project');

    if (!this.jsonEnabled()) {
      this.log(`Project created: ${project.id}`);
    }

    return response.data;
  }
}

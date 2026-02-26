import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class ProjectsUpdate extends BaseCommand {
  static description = 'Update a project';

  static args = {
    id: Args.string({description: 'Project ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'Project name'}),
    summary: Flags.string({description: 'Project summary'}),
    status: Flags.string({
      description: 'Project status',
      options: ['planning', 'active', 'on_hold', 'blocked', 'completed'],
    }),
    emoji: Flags.string({description: 'Single emoji'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ProjectsUpdate);
    const client = await this.client(flags);

    const updates: Record<string, unknown> = {};
    if (flags.name !== undefined) updates.name = flags.name;
    if (flags.summary !== undefined) updates.summary = flags.summary;
    if (flags.status !== undefined) updates.status = flags.status;
    if (flags.emoji !== undefined) updates.emoji = flags.emoji;

    const response = await client.updateProject(args.id, updates);
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Project ${args.id} updated`);
    }

    return response.data;
  }
}

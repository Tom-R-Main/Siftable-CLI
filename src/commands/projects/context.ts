import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class ProjectsContext extends BaseCommand {
  static description = 'Get project context (tasks, notes, signals)';

  static args = {
    id: Args.string({description: 'Project ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ProjectsContext);
    const client = await this.client(flags);
    const response = await client.getProjectContext(args.id);
    this.handleApiError(response);

    const ctx = response.data as Record<string, unknown>;

    if (!this.jsonEnabled()) {
      const project = ctx.project as Record<string, unknown> | undefined;
      if (project) {
        this.log(`\n${project.emoji || ''} ${project.name} (${project.status})`);
        if (project.summary) this.log(`  ${project.summary}`);
        this.log('');
      }

      const tasks = ctx.tasks as Record<string, unknown>[] | undefined;
      if (tasks?.length) {
        this.log('Tasks:');
        renderTable(tasks, [
          {key: 'id', header: 'ID'},
          {key: 'title', header: 'Title'},
          {key: 'status', header: 'Status'},
        ]);
        this.log('');
      }

      const notes = ctx.notes as Record<string, unknown>[] | undefined;
      if (notes?.length) {
        this.log('Notes:');
        renderTable(notes, [
          {key: 'id', header: 'ID'},
          {key: 'title', header: 'Title'},
          {key: 'noteType', header: 'Type'},
        ]);
      }
    }

    return response.data;
  }
}

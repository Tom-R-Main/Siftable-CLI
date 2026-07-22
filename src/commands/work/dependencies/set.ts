import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {parseWorkDependencies} from '../../../lib/work-dependencies.js';

export default class WorkDependenciesSet extends BaseCommand {
  static description = 'Atomically replace the authoritative dependencies for a work item';

  static args = {
    id: Args.string({description: 'Work item UUID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'depends-on': Flags.string({
      description: 'Dependency JSON array; pass [] to clear dependencies',
      required: true,
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkDependenciesSet);
    const client = await this.client(flags);
    let dependsOn;
    try {
      dependsOn = parseWorkDependencies(flags['depends-on']);
    } catch (error) {
      this.error(error instanceof Error ? error.message : 'Invalid dependencies.');
    }
    const response = await client.replaceWorkItemDependencies(args.id, dependsOn ?? []);
    this.handleApiError(response);
    const result = this.unwrapOne(response, 'workItem');
    if (!this.jsonEnabled()) this.log(`Dependencies replaced: ${result.id ?? args.id}`);
    return response.data;
  }
}

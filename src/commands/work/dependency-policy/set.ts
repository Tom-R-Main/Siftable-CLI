import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {WORK_DEPENDENCY_GATES, type WorkDependencyGate} from '../../../lib/work-dependencies.js';

export default class WorkDependencyPolicySet extends BaseCommand {
  static description = 'Set a project default work-dependency gate';

  static flags = {
    ...BaseCommand.baseFlags,
    project: Flags.string({description: 'Project UUID', required: true}),
    gate: Flags.string({
      description: 'Default gate for dependencies that omit requiredGate',
      options: [...WORK_DEPENDENCY_GATES],
      required: true,
    }),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(WorkDependencyPolicySet);
    const client = await this.client(flags);
    const response = await client.updateWorkDependencyPolicy(flags.project, {
      defaultRequiredGate: flags.gate as WorkDependencyGate,
    });
    this.handleApiError(response);
    if (!this.jsonEnabled()) this.log(`Default required gate: ${flags.gate}`);
    return response.data;
  }
}

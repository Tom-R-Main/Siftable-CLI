import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class WorkDependencyPolicyGet extends BaseCommand {
  static description = 'Get a project default work-dependency gate';

  static flags = {
    ...BaseCommand.baseFlags,
    project: Flags.string({description: 'Project UUID', required: true}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(WorkDependencyPolicyGet);
    const client = await this.client(flags);
    const response = await client.getWorkDependencyPolicy(flags.project);
    this.handleApiError(response);
    if (!this.jsonEnabled()) {
      const data = response.data as {defaultRequiredGate?: string} | undefined;
      this.log(`Default required gate: ${data?.defaultRequiredGate ?? 'done'}`);
    }
    return response.data;
  }
}

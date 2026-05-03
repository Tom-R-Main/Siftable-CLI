import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class AgentsGet extends BaseCommand {
  static description = 'Get an agent alias';

  static args = {
    alias: Args.string({description: 'Agent alias or ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(AgentsGet);
    const client = await this.client(flags);
    const response = await client.getAgent(args.alias);
    this.handleApiError(response);
    const agent = this.unwrapOne(response, 'agent');

    if (!this.jsonEnabled()) {
      this.log(`${agent.displayName ?? agent.alias} (${agent.alias})`);
      this.log(`Type: ${agent.agentType ?? 'custom'}`);
      this.log(`Status: ${agent.status ?? 'active'}`);
      if (agent.operatorId) this.log(`Operator: ${agent.operatorId}`);
    }

    return agent;
  }
}

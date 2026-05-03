import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class AgentsDisable extends BaseCommand {
  static description = 'Disable an agent alias';

  static args = {
    alias: Args.string({description: 'Agent alias or ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(AgentsDisable);
    const client = await this.client(flags);
    const response = await client.disableAgent(args.alias);
    this.handleApiError(response);
    const agent = this.unwrapOne(response, 'agent');

    if (!this.jsonEnabled()) {
      this.log(`Agent disabled: ${agent.alias}`);
    }

    return response.data;
  }
}

import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class AgentsCreate extends BaseCommand {
  static description = 'Create an agent alias';

  static flags = {
    ...BaseCommand.baseFlags,
    alias: Flags.string({description: 'Stable alias slug, e.g. codex', required: true}),
    name: Flags.string({description: 'Display name'}),
    type: Flags.string({description: 'Agent type', default: 'custom'}),
    operator: Flags.string({description: 'Linked daemon/operator ID'}),
    capabilities: Flags.string({description: 'Capabilities JSON object'}),
    permissions: Flags.string({description: 'Default permissions JSON object'}),
    hidden: Flags.boolean({description: 'Hide from normal user-visible lists'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(AgentsCreate);
    const client = await this.client(flags);
    const response = await client.createAgent({
      alias: flags.alias,
      displayName: flags.name,
      agentType: flags.type,
      operatorId: flags.operator,
      capabilities: this.parseJsonFlag<Record<string, unknown>>(flags.capabilities, 'capabilities'),
      defaultPermissions: this.parseJsonFlag<Record<string, unknown>>(flags.permissions, 'permissions'),
      visibleToUser: !flags.hidden,
    });
    this.handleApiError(response);
    const agent = this.unwrapOne(response, 'agent');

    if (!this.jsonEnabled()) {
      this.log(`Agent created: ${agent.alias}`);
    }

    return response.data;
  }
}

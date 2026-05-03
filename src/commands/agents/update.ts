import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class AgentsUpdate extends BaseCommand {
  static description = 'Update an agent alias';

  static args = {
    alias: Args.string({description: 'Agent alias or ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({description: 'Display name'}),
    type: Flags.string({description: 'Agent type'}),
    operator: Flags.string({description: 'Linked daemon/operator ID'}),
    capabilities: Flags.string({description: 'Capabilities JSON object'}),
    permissions: Flags.string({description: 'Default permissions JSON object'}),
    status: Flags.string({description: 'Alias status', options: ['active', 'disabled']}),
    hidden: Flags.boolean({description: 'Hide from normal user-visible lists'}),
    visible: Flags.boolean({description: 'Show in normal user-visible lists'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(AgentsUpdate);
    const client = await this.client(flags);
    const updates: Record<string, unknown> = {};
    if (flags.name !== undefined) updates.displayName = flags.name;
    if (flags.type !== undefined) updates.agentType = flags.type;
    if (flags.operator !== undefined) updates.operatorId = flags.operator;
    if (flags.capabilities !== undefined) updates.capabilities = this.parseJsonFlag(flags.capabilities, 'capabilities');
    if (flags.permissions !== undefined) updates.defaultPermissions = this.parseJsonFlag(flags.permissions, 'permissions');
    if (flags.status !== undefined) updates.status = flags.status;
    if (flags.hidden) updates.visibleToUser = false;
    if (flags.visible) updates.visibleToUser = true;

    const response = await client.updateAgent(args.alias, updates);
    this.handleApiError(response);
    const agent = this.unwrapOne(response, 'agent');

    if (!this.jsonEnabled()) {
      this.log(`Agent updated: ${agent.alias}`);
    }

    return response.data;
  }
}

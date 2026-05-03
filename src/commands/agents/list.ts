import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class AgentsList extends BaseCommand {
  static description = 'List agent aliases';

  static examples = [
    '<%= config.bin %> agents list',
    '<%= config.bin %> agents list --include-disabled --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    'include-disabled': Flags.boolean({description: 'Include disabled aliases'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(AgentsList);
    const client = await this.client(flags);
    const response = await client.listAgents({includeDisabled: flags['include-disabled']});
    this.handleApiError(response);
    const agents = this.unwrapList(response, 'agents');

    if (!this.jsonEnabled()) {
      renderTable(agents, [
        {key: 'alias', header: 'Alias'},
        {key: 'displayName', header: 'Name'},
        {key: 'agentType', header: 'Type'},
        {key: 'status', header: 'Status'},
        {key: 'operatorId', header: 'Operator', get: (r) => (r.operatorId as string) || '-'},
      ]);
    }

    return agents;
  }
}

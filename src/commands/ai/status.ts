import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import type {AiTransport} from '../../lib/ai-transport.js';
import {renderTable} from '../../lib/output.js';

export default class AiStatus extends BaseCommand {
  static description = 'Show non-secret Model Connection status (requires ai:connections:use)';
  static requiredScope = 'ai:connections:use';
  static flags = {...BaseCommand.baseFlags};
  static args = {
    connection: Args.string({
      description: 'Optional Model Connection UUID',
      required: false,
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(AiStatus);
    const client = await this.client(flags) as unknown as AiTransport;
    const result = await client.getAiConnectionStatus(args.connection);
    this.handleApiError(result);
    const connections = (result.data?.connections ?? []).map(connection => ({
      connectionId: connection.connectionId,
      connectionName: connection.connectionName,
      provider: connection.provider,
      lifecycleStatus: connection.lifecycleStatus,
      validationStatus: connection.validationStatus,
      availableModelCount: connection.availableModelCount,
    }));
    if (!this.jsonEnabled()) {
      renderTable(connections, [
        {key: 'connectionId', header: 'CONNECTION'},
        {key: 'connectionName', header: 'NAME'},
        {key: 'provider', header: 'PROVIDER'},
        {key: 'lifecycleStatus', header: 'LIFECYCLE'},
        {key: 'validationStatus', header: 'VALIDATION'},
        {key: 'availableModelCount', header: 'MODELS'},
      ]);
    }
    return connections;
  }
}

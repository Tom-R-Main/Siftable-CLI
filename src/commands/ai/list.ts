import {BaseCommand} from '../../lib/base-command.js';
import type {AiTransport} from '../../lib/ai-transport.js';
import {renderTable} from '../../lib/output.js';

export default class AiList extends BaseCommand {
  static description = 'List eligible connected models (requires ai:models:read)';
  static requiredScope = 'ai:models:read';
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {flags} = await this.parse(AiList);
    const client: AiTransport = await this.client(flags);
    const result = await client.listAiModels();
    this.handleAiApiError(result, 'ai:models:read');
    const models = (result.data?.models ?? []).map(model => ({
      connectionId: model.connectionId,
      connectionName: model.connectionName,
      provider: model.provider,
      model: model.model,
      status: model.status,
    }));

    if (!this.jsonEnabled()) {
      renderTable(models, [
        {key: 'connectionId', header: 'CONNECTION'},
        {key: 'connectionName', header: 'NAME'},
        {key: 'provider', header: 'PROVIDER'},
        {key: 'model', header: 'MODEL'},
        {key: 'status', header: 'STATUS'},
      ]);
    }
    return models;
  }
}

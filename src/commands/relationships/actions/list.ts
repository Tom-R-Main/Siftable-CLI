import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

export default class RelationshipActionsList extends BaseCommand {
  static description = 'List canonical executable relationship action contracts';
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipActionsList);
    const response = await this.apiRequest<{version: number; actions: Record<string, unknown>[]}>(
      flags,
      '/api/v1/ontology/relationship-actions',
    );
    if (!this.jsonEnabled()) {
      renderTable(response.actions, [
        {key: 'id', header: 'Action'},
        {key: 'label', header: 'Label'},
        {key: 'commitmentClass', header: 'Commitment'},
      ]);
    }
    return response;
  }
}

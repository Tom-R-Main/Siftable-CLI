import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

interface RelationshipActionContract extends Record<string, unknown> {
  id: string;
  label: string;
  description: string;
  commitmentClass: string;
  inputJsonSchema: Record<string, unknown>;
  outputJsonSchema: Record<string, unknown>;
  surfaceBindings: Array<{surface: string; availability: string}>;
}

export default class RelationshipsActionsList extends BaseCommand {
  static description = 'Discover canonical relationship actions and runtime schemas';
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipsActionsList);
    const response = await this.apiRequest<{version: number; actions: RelationshipActionContract[]}>(
      flags,
      '/api/v1/ontology/relationship-actions',
    );
    if (!this.jsonEnabled()) {
      this.log(`Relationship action contract v${response.version}`);
      renderTable(response.actions, [
        {key: 'id', header: 'Action'},
        {key: 'label', header: 'Label'},
        {key: 'commitmentClass', header: 'Commitment'},
      ]);
    }
    return response;
  }
}

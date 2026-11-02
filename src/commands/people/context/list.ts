import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

export default class PeopleContextList extends BaseCommand {
  static description = 'List how the current owner knows a person';

  static args = {
    personId: Args.string({description: 'Person ID', required: true}),
  };

  static flags = BaseCommand.baseFlags;

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PeopleContextList);
    const response = await this.apiRequest<{relationships: Record<string, unknown>[]; contexts: string[]}>(
      flags,
      `/api/v1/people/${args.personId}/context-relationships`,
    );
    const relationships = response.relationships;
    if (!this.jsonEnabled()) {
      renderTable(relationships, [
        {key: 'id', header: 'ID'},
        {key: 'context', header: 'Context'},
        {key: 'relationshipType', header: 'Relationship'},
        {key: 'isPrimary', header: 'Primary'},
      ]);
    }
    return response;
  }
}

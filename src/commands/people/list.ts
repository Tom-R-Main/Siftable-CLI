import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class PeopleList extends BaseCommand {
  static description = 'List contacts';

  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({description: 'Maximum number of results'}),
    'starts-with': Flags.string({description: 'Name prefix filter'}),
    contains: Flags.string({description: 'Name substring filter'}),
    equals: Flags.string({description: 'Exact name filter'}),
    relationship: Flags.string({description: 'Filter by relationshipToUser'}),
    context: Flags.string({description: 'Relationship context', options: ['all', 'personal', 'work'], default: 'all'}),
    category: Flags.string({description: 'Relationship category', options: ['family', 'romantic', 'professional', 'social']}),
    'has-no-email': Flags.boolean({description: 'Only contacts without an email'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(PeopleList);
    const params = new URLSearchParams();
    if (flags.limit) params.set('limit', String(flags.limit));
    if (flags['starts-with']) params.set('nameStartsWith', flags['starts-with']);
    if (flags.contains) params.set('nameContains', flags.contains);
    if (flags.equals) params.set('nameEquals', flags.equals);
    if (flags.relationship) params.set('relationshipEquals', flags.relationship);
    if (flags.context) params.set('context', flags.context);
    if (flags.category) params.set('relationshipCategory', flags.category);
    if (flags['has-no-email'] !== undefined) params.set('hasNoEmail', String(flags['has-no-email']));
    const query = params.toString();
    const response = await this.apiRequest<{people: Record<string, unknown>[]}>(
      flags,
      `/api/v1/people${query ? `?${query}` : ''}`,
    );
    const people = response.people;

    if (!this.jsonEnabled()) {
      renderTable(people, [
        {key: 'id', header: 'ID'},
        {key: 'name', header: 'Name'},
        {key: 'email', header: 'Email'},
        {key: 'company', header: 'Company'},
        {key: 'contexts', header: 'Contexts'},
      ]);
    }

    return people;
  }
}

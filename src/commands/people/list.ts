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
    'has-no-email': Flags.boolean({description: 'Only contacts without an email'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(PeopleList);
    const client = await this.client(flags);
    const response = await client.listPeople({
      limit: flags.limit,
      nameStartsWith: flags['starts-with'],
      nameContains: flags.contains,
      nameEquals: flags.equals,
      relationshipEquals: flags.relationship,
      hasNoEmail: flags['has-no-email'],
    });
    this.handleApiError(response);

    const people = this.unwrapList(response, 'people');

    if (!this.jsonEnabled()) {
      renderTable(people, [
        {key: 'id', header: 'ID'},
        {key: 'name', header: 'Name'},
        {key: 'email', header: 'Email'},
        {key: 'company', header: 'Company'},
      ]);
    }

    return people;
  }
}

import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class PeopleList extends BaseCommand {
  static description = 'List contacts';

  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({description: 'Maximum number of results'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(PeopleList);
    const client = await this.client(flags);
    const response = await client.listPeople(flags.limit);
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

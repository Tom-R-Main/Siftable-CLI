import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class PeopleGet extends BaseCommand {
  static description = 'Get a person profile with traits and relationships';

  static args = {
    id: Args.string({description: 'Person ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(PeopleGet);
    const client = await this.client(flags);
    const response = await client.getPerson(args.id);
    this.handleApiError(response);
    const person = response.data as Record<string, unknown>;

    if (!this.jsonEnabled()) {
      renderDetail([
        ['ID', person.id],
        ['Name', person.name],
        ['Relationship', person.relationshipToUser],
        ['Company', person.company],
        ['Role', person.jobTitle],
        ['Location', person.location],
      ]);
      const relationships = Array.isArray(person.relationships) ? person.relationships as Record<string, unknown>[] : [];
      if (relationships.length > 0) {
        this.log('');
        renderTable(relationships, [
          {key: 'id', header: 'ID'},
          {key: 'name', header: 'Person'},
          {key: 'relationshipType', header: 'Type'},
          {key: 'notes', header: 'Notes'},
        ]);
      }
    }

    return person;
  }
}

import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

export default class RelationshipSequencesList extends BaseCommand {
  static description = 'List supervised relationship sequences';

  static flags = {
    ...BaseCommand.baseFlags,
    status: Flags.string({description: 'Filter by sequence status'}),
    limit: Flags.integer({description: 'Maximum results'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipSequencesList);
    const client = await this.client(flags);
    const response = await client.listRelationshipSequences({status: flags.status, limit: flags.limit});
    this.handleApiError(response);
    const sequences = this.unwrapList(response, 'sequences');
    if (!this.jsonEnabled()) {
      renderTable(sequences, [
        {key: 'id', header: 'ID'},
        {key: 'name', header: 'Sequence'},
        {key: 'status', header: 'Status'},
        {key: 'definitionVersion', header: 'Version'},
      ]);
    }
    return sequences;
  }
}

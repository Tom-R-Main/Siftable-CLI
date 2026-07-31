import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

export default class RelationshipSequencesRuns extends BaseCommand {
  static description = 'List execution evidence for a supervised relationship sequence';

  static args = {
    id: Args.string({description: 'Sequence ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    status: Flags.string({description: 'Filter by run status'}),
    limit: Flags.integer({description: 'Maximum results'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipSequencesRuns);
    const client = await this.client(flags);
    const response = await client.listRelationshipSequenceRuns(
      args.id,
      {status: flags.status, limit: flags.limit},
    );
    this.handleApiError(response);
    const runs = this.unwrapList(response, 'runs');
    if (!this.jsonEnabled()) {
      renderTable(runs, [
        {key: 'id', header: 'ID'},
        {key: 'status', header: 'Status'},
        {key: 'stepId', header: 'Step'},
        {key: 'outcome', header: 'Outcome'},
      ]);
    }
    return runs;
  }
}

import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class RelationshipSequencesGet extends BaseCommand {
  static description = 'Show one supervised relationship sequence';

  static args = {
    id: Args.string({description: 'Sequence ID', required: true}),
  };

  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipSequencesGet);
    const client = await this.client(flags);
    const response = await client.getRelationshipSequence(args.id);
    this.handleApiError(response);
    const sequence = this.unwrapOne(response, 'sequence');
    if (!this.jsonEnabled()) this.log(JSON.stringify(sequence, null, 2));
    return sequence;
  }
}

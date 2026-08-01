import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class RelationshipSequencesResume extends BaseCommand {
  static description = 'Resume a supervised relationship sequence';

  static args = {
    id: Args.string({description: 'Sequence ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'idempotency-key': Flags.string({description: 'Stable 8-128 character key for safe retries', required: true}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipSequencesResume);
    const client = await this.client(flags);
    const response = await client.resumeRelationshipSequence(args.id, {}, flags['idempotency-key']);
    this.handleApiError(response);
    const sequence = this.unwrapOne(response, 'sequence');
    if (!this.jsonEnabled()) this.log(`Sequence resumed: ${sequence.id}`);
    return sequence;
  }
}

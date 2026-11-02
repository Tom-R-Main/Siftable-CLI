import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class RelationshipSequencesPause extends BaseCommand {
  static description = 'Pause a supervised relationship sequence';

  static args = {
    id: Args.string({description: 'Sequence ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    reason: Flags.string({description: 'Non-secret pause reason'}),
    'idempotency-key': Flags.string({description: 'Stable 8-128 character key for safe retries', required: true}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipSequencesPause);
    const client = await this.client(flags);
    const response = await client.pauseRelationshipSequence(
      args.id,
      {reason: flags.reason},
      flags['idempotency-key'],
    );
    this.handleApiError(response);
    const sequence = this.unwrapOne(response, 'sequence');
    if (!this.jsonEnabled()) this.log(`Sequence paused: ${sequence.id}`);
    return sequence;
  }
}

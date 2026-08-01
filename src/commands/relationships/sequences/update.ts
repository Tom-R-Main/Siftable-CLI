import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class RelationshipSequencesUpdate extends BaseCommand {
  static description = 'Update a supervised relationship sequence from a JSON definition';

  static args = {
    id: Args.string({description: 'Sequence ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    definition: Flags.string({description: 'Sequence update JSON object'}),
    'definition-file': Flags.string({description: 'Path to sequence update JSON', exactlyOne: ['definition', 'definition-file']}),
    'idempotency-key': Flags.string({description: 'Stable 8-128 character key for safe retries', required: true}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipSequencesUpdate);
    const definition = this.parseJsonInput<Record<string, unknown>>(
      flags.definition,
      flags['definition-file'],
      'definition',
    ) ?? {};
    const client = await this.client(flags);
    const response = await client.updateRelationshipSequence(args.id, definition, flags['idempotency-key']);
    this.handleApiError(response);
    const sequence = this.unwrapOne(response, 'sequence');
    if (!this.jsonEnabled()) this.log(`Sequence updated: ${sequence.id}`);
    return sequence;
  }
}

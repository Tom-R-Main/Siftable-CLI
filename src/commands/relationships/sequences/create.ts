import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class RelationshipSequencesCreate extends BaseCommand {
  static description = 'Create a supervised relationship sequence from a JSON definition';

  static flags = {
    ...BaseCommand.baseFlags,
    definition: Flags.string({description: 'Sequence definition JSON object'}),
    'definition-file': Flags.string({description: 'Path to sequence definition JSON', exactlyOne: ['definition', 'definition-file']}),
    'idempotency-key': Flags.string({description: 'Stable 8-128 character key for safe retries', required: true}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipSequencesCreate);
    const definition = this.parseJsonInput<Record<string, unknown>>(
      flags.definition,
      flags['definition-file'],
      'definition',
    ) ?? {};
    const client = await this.client(flags);
    const response = await client.createRelationshipSequence(definition, flags['idempotency-key']);
    this.handleApiError(response);
    const sequence = this.unwrapOne(response, 'sequence');
    if (!this.jsonEnabled()) this.log(`Sequence created: ${sequence.id}`);
    return sequence;
  }
}

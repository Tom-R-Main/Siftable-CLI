import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class RelationshipSequencesEnroll extends BaseCommand {
  static description = 'Enroll a relationship target in a supervised sequence';

  static args = {
    id: Args.string({description: 'Sequence ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    input: Flags.string({description: 'Enrollment input JSON object'}),
    'input-file': Flags.string({description: 'Path to enrollment input JSON', exactlyOne: ['input', 'input-file']}),
    'idempotency-key': Flags.string({description: 'Stable 8-128 character key for safe retries', required: true}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipSequencesEnroll);
    const input = this.parseJsonInput<Record<string, unknown>>(
      flags.input,
      flags['input-file'],
      'input',
    ) ?? {};
    const client = await this.client(flags);
    const response = await client.enrollRelationshipSequence(args.id, input, flags['idempotency-key']);
    this.handleApiError(response);
    const enrollment = this.unwrapOne(response, 'enrollment');
    if (!this.jsonEnabled()) this.log(`Enrollment created: ${enrollment.id}`);
    return enrollment;
  }
}

import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class RelationshipSequencesDryRun extends BaseCommand {
  static description = 'Preview a supervised sequence on the server without committing it';

  static args = {
    id: Args.string({description: 'Sequence ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    input: Flags.string({description: 'Dry-run input JSON object'}),
    'input-file': Flags.string({description: 'Path to dry-run input JSON'}),
    'idempotency-key': Flags.string({
      description: 'Stable 8-128 character key for reproducible server-side previews',
      required: true,
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipSequencesDryRun);
    const input = this.parseJsonInput<Record<string, unknown>>(
      flags.input,
      flags['input-file'],
      'input',
    ) ?? {};
    const client = await this.client(flags);
    const response = await client.dryRunRelationshipSequence(args.id, input, flags['idempotency-key']);
    this.handleApiError(response);
    const preview = this.unwrapOne(response, 'dryRun');
    if (!this.jsonEnabled()) this.log(JSON.stringify(preview, null, 2));
    return preview;
  }
}

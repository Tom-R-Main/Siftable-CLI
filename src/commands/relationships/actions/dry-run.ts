import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class RelationshipActionsDryRun extends BaseCommand {
  static description = 'Preview a relationship action on the server without committing it';

  static args = {
    id: Args.string({description: 'Relationship action ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    input: Flags.string({description: 'Action input JSON object'}),
    'input-file': Flags.string({description: 'Path to action input JSON'}),
    'idempotency-key': Flags.string({
      description: 'Stable 8-128 character key for reproducible server-side previews',
      required: true,
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipActionsDryRun);
    const input = this.parseJsonInput<Record<string, unknown>>(
      flags.input,
      flags['input-file'],
      'input',
    ) ?? {};
    const client = await this.client(flags);
    const response = await client.dryRunRelationshipAction(args.id, input, flags['idempotency-key']);
    this.handleApiError(response);
    const preview = this.unwrapOne(response, 'dryRun');
    if (!this.jsonEnabled()) this.log(JSON.stringify(preview, null, 2));
    return preview;
  }
}

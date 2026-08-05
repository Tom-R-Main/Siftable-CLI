import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class CodeMemoryNeedsReview extends BaseCommand {
  static description = 'Mark a code memory needs_review for likely staleness/contradiction (never deletes)';

  static args = {
    id: Args.string({description: 'Memory ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    reason: Flags.string({description: 'Audit reason', required: true}),
    signal: Flags.string({
      description: 'Staleness signal (repeatable)',
      multiple: true,
    }),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodeMemoryNeedsReview);
    const client = await this.client(flags);
    const response = await client.markCodeMemoryNeedsReview(args.id, {
      reason: flags.reason,
      signals: flags.signal,
      actorType: 'human',
    });
    this.handleApiError(response);

    if (!this.jsonEnabled()) {
      this.log(`Marked ${response.data?.id} → ${response.data?.lifecycle?.state}`);
    }

    return response.data;
  }
}

import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';

export default class RelationshipsComposerRequestChanges extends BaseCommand {
  static description = 'Return an exact review to its author without mutating the message';
  static args = { id: Args.string({ description: 'Composer session UUID', required: true }) };
  static flags = {
    ...BaseCommand.baseFlags,
    'expected-version': Flags.integer({ required: true, min: 1 }),
    reason: Flags.string({ required: true }),
    yes: Flags.boolean({ description: 'Confirm the review interruption' }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipsComposerRequestChanges);
    if (!await this.confirmAction('Request changes and invalidate the current approval?', flags)) return { cancelled: true };
    const response = await this.apiRequest<{ session: Record<string, unknown> }>(
      flags,
      `/api/v1/relationships/composer-sessions/${encodeURIComponent(args.id)}/request-changes`,
      { method: 'POST', body: { expectedVersion: flags['expected-version'], reason: flags.reason } },
    );
    if (!this.jsonEnabled()) renderDetail([
      ['Session', response.session.id],
      ['Phase', response.session.phase],
      ['Approval', 'Invalidated; message preserved'],
    ]);
    return response.session;
  }
}

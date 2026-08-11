import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';

export default class RelationshipsComposerReview extends BaseCommand {
  static description = 'Continue a coaching-clear durable draft to governed review';
  static args = { id: Args.string({ description: 'Composer session UUID', required: true }) };
  static flags = {
    ...BaseCommand.baseFlags,
    'expected-version': Flags.integer({ description: 'Current optimistic session version', required: true, min: 1 }),
    yes: Flags.boolean({ description: 'Confirm the transition to review' }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipsComposerReview);
    if (!await this.confirmAction('Continue this durable draft to governed review?', flags)) return { cancelled: true };
    const response = await this.apiRequest<{ session: Record<string, unknown> }>(
      flags,
      `/api/v1/relationships/composer-sessions/${encodeURIComponent(args.id)}/review`,
      { method: 'POST', body: { expectedVersion: flags['expected-version'] } },
    );
    if (!this.jsonEnabled()) renderDetail([
      ['Session', response.session.id],
      ['Phase', response.session.phase],
      ['Draft revision', (response.session.draft as Record<string, unknown> | null)?.revision ?? 'not created'],
      ['Next', 'Governed approval and transport'],
    ]);
    return response.session;
  }
}

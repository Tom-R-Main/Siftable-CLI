import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';

export default class RelationshipsComposerConfirm extends BaseCommand {
  static description = 'Confirm the bound brief and create its first durable draft revision';
  static args = { id: Args.string({ description: 'Composer session UUID', required: true }) };
  static flags = {
    ...BaseCommand.baseFlags,
    'expected-version': Flags.integer({ description: 'Current optimistic session version', required: true, min: 1 }),
    yes: Flags.boolean({ description: 'Confirm brief and create draft' }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipsComposerConfirm);
    if (!await this.confirmAction('Confirm this brief and create its durable draft?', flags)) return { cancelled: true };
    const response = await this.apiRequest<{ session: Record<string, unknown> }>(
      flags,
      `/api/v1/relationships/composer-sessions/${encodeURIComponent(args.id)}/confirm-brief`,
      { method: 'POST', body: { expectedVersion: flags['expected-version'] } },
    );
    if (!this.jsonEnabled()) renderDetail([
      ['Session', response.session.id],
      ['Phase', response.session.phase],
      ['Draft', (response.session.draft as Record<string, unknown> | null)?.revisionId ?? 'not created'],
      ['Sender', response.session.senderAccountId ?? 'not bound; draft remains saved'],
    ]);
    return response.session;
  }
}

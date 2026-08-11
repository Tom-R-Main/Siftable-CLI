import { Args } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderTable } from '../../../lib/output.js';

export default class RelationshipsComposerHistory extends BaseCommand {
  static description = 'Show append-only coaching and draft decision history in recorded order';
  static args = { id: Args.string({ description: 'Composer session UUID', required: true }) };
  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipsComposerHistory);
    const response = await this.apiRequest<{ session: Record<string, unknown> }>(
      flags,
      `/api/v1/relationships/composer-sessions/${encodeURIComponent(args.id)}`,
    );
    const history = Array.isArray(response.session.coachingHistory)
      ? response.session.coachingHistory as Record<string, unknown>[]
      : [];
    if (!this.jsonEnabled()) renderTable(history, [
      { key: 'createdAt', header: 'Recorded' },
      { key: 'action', header: 'Action' },
      { key: 'findingId', header: 'Finding' },
      { key: 'actor', header: 'Actor', get: (row) => String((row.actor as Record<string, unknown>)?.label ?? '—') },
      { key: 'revisionId', header: 'Revision' },
    ]);
    return history;
  }
}

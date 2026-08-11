import { Args } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail, renderTable } from '../../../lib/output.js';

export default class RelationshipsComposerShow extends BaseCommand {
  static description = 'Show a durable relationship composer session';
  static args = { id: Args.string({ description: 'Composer session UUID', required: true }) };
  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipsComposerShow);
    const response = await this.apiRequest<{ session: Record<string, unknown> }>(
      flags,
      `/api/v1/relationships/composer-sessions/${encodeURIComponent(args.id)}`,
    );
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Session', response.session.id],
        ['Phase', response.session.phase],
        ['Version', response.session.version],
        ['Sender', response.session.senderAccountId ?? 'not bound'],
      ]);
      const evidence = Array.isArray(response.session.evidence) ? response.session.evidence as Record<string, unknown>[] : [];
      if (evidence.length) renderTable(evidence, [
        { key: 'rank', header: 'Rank' },
        { key: 'decision', header: 'Decision' },
        { key: 'label', header: 'Evidence' },
      ]);
    }
    return response.session;
  }
}

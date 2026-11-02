import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';

export default class RelationshipsComposerBindSender extends BaseCommand {
  static description = 'Bind an explicit active connected email account to a durable draft';
  static args = { id: Args.string({ description: 'Composer session UUID', required: true }) };
  static flags = {
    ...BaseCommand.baseFlags,
    'expected-version': Flags.integer({ description: 'Current optimistic session version', required: true, min: 1 }),
    sender: Flags.string({ description: 'Connected email account UUID', required: true }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipsComposerBindSender);
    const response = await this.apiRequest<{ session: Record<string, unknown> }>(
      flags,
      `/api/v1/relationships/composer-sessions/${encodeURIComponent(args.id)}/sender`,
      { method: 'POST', body: { expectedVersion: flags['expected-version'], senderAccountId: flags.sender } },
    );
    if (!this.jsonEnabled()) renderDetail([
      ['Session', response.session.id],
      ['Sender', response.session.senderAccountId],
      ['Version', response.session.version],
    ]);
    return response.session;
  }
}

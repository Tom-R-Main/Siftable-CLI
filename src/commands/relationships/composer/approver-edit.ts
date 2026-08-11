import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';

export default class RelationshipsComposerApproverEdit extends BaseCommand {
  static description = 'Create an attributed approver revision and reopen coaching review';
  static args = { id: Args.string({ description: 'Composer session UUID', required: true }) };
  static flags = {
    ...BaseCommand.baseFlags,
    'expected-version': Flags.integer({ required: true, min: 1 }),
    subject: Flags.string({ required: true }),
    body: Flags.string({ required: true }),
    reason: Flags.string({ required: true }),
    yes: Flags.boolean({ description: 'Confirm the attributed edit' }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipsComposerApproverEdit);
    if (!await this.confirmAction('Create an approver revision and invalidate approval?', flags)) return { cancelled: true };
    const response = await this.apiRequest<{ session: Record<string, unknown> }>(
      flags,
      `/api/v1/relationships/composer-sessions/${encodeURIComponent(args.id)}/approver-edit`,
      {
        method: 'PATCH',
        body: {
          expectedVersion: flags['expected-version'],
          subject: flags.subject,
          bodyText: flags.body,
          reason: flags.reason,
        },
      },
    );
    const draft = response.session.draft as Record<string, unknown> | null;
    if (!this.jsonEnabled()) renderDetail([
      ['Session', response.session.id],
      ['Phase', response.session.phase],
      ['Draft revision', draft?.revision ?? 'not available'],
      ['Approval', 'Invalidated; review reopened'],
    ]);
    return response.session;
  }
}

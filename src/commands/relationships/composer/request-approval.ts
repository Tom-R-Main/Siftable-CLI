import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';

export default class RelationshipsComposerRequestApproval extends BaseCommand {
  static description = 'Request or resume approval for the exact composer review; approval remains browser-only';
  static args = { id: Args.string({ description: 'Composer session UUID', required: true }) };
  static flags = {
    ...BaseCommand.baseFlags,
    'expected-version': Flags.integer({ description: 'Current optimistic session version', required: true, min: 1 }),
    'idempotency-key': Flags.string({ description: 'Stable approval-request retry key', required: true }),
    yes: Flags.boolean({ description: 'Confirm the approval request' }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipsComposerRequestApproval);
    if (!await this.confirmAction('Request approval for this exact reviewed message?', flags)) return { cancelled: true };
    const response = await this.apiRequest<{ session: Record<string, unknown> }>(
      flags,
      `/api/v1/relationships/composer-sessions/${encodeURIComponent(args.id)}/approval-requests`,
      {
        method: 'POST',
        body: { expectedVersion: flags['expected-version'], idempotencyKey: flags['idempotency-key'] },
      },
    );
    const review = response.session.review as Record<string, unknown> | null;
    const approval = review?.approval as Record<string, unknown> | null;
    if (!this.jsonEnabled()) renderDetail([
      ['Session', response.session.id],
      ['Review digest', review?.digest ?? 'not available'],
      ['Approval', approval?.id ?? 'not requested'],
      ['Status', approval?.status ?? 'not requested'],
      ['Review in browser', approval?.approvalUrl ?? 'not available'],
      ['Dispatch', 'Not started by this command'],
    ]);
    return response.session;
  }
}

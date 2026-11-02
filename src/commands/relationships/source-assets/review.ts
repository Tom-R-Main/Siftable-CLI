import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';

export default class RelationshipSourceAssetsReview extends BaseCommand {
  static description = 'Append a human approval decision to a source-asset version';
  static args = { id: Args.string({ description: 'Source-asset version UUID', required: true }) };
  static flags = {
    ...BaseCommand.baseFlags,
    decision: Flags.string({ options: ['approved', 'rejected', 'needs_changes'], required: true }),
    reason: Flags.string({ required: true }),
    yes: Flags.boolean({ description: 'Confirm append-only review' }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipSourceAssetsReview);
    if (!await this.confirmAction(`Append ${flags.decision} review for source asset ${args.id}?`, flags)) return { cancelled: true };
    const response = await this.apiRequest<{ review: Record<string, unknown> }>(
      flags,
      `/api/v1/relationship-playbooks/source-assets/${encodeURIComponent(args.id)}/reviews`,
      { method: 'POST', body: { decision: flags.decision, reason: flags.reason } },
    );
    if (!this.jsonEnabled()) renderDetail([['Review', response.review.reviewId], ['Decision', response.review.decision]]);
    return response.review;
  }
}

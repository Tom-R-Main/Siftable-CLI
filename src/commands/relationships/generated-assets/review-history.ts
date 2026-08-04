import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

export default class RelationshipGeneratedAssetsReviewHistory extends BaseCommand {
  static description = 'List the append-only review history for one generated asset';
  static args = {id: Args.string({description: 'Generated asset UUID', required: true})};
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipGeneratedAssetsReviewHistory);
    const response = await this.apiRequest<{reviews: Array<Record<string, unknown>>}>(
      flags,
      `/api/v1/relationship-playbooks/generated-assets/${encodeURIComponent(args.id)}/reviews`,
    );
    if (!this.jsonEnabled()) {
      renderTable(response.reviews.map((review) => ({
        decision: review.decision,
        reviewer: review.reviewerUserId,
        reason: review.reason,
        at: review.createdAt,
      })), [
        {key: 'decision', header: 'Decision'},
        {key: 'reviewer', header: 'Reviewer'},
        {key: 'reason', header: 'Reason'},
        {key: 'at', header: 'Reviewed'},
      ]);
    }
    return response.reviews;
  }
}

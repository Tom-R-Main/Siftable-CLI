import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {asJsonObjectArray, assertReviewReasonCode} from '../../../lib/lead-discovery-contract.js';

interface ReviewBatchResponse {reviewBatch: Record<string, unknown>}

export default class LeadDiscoveryCandidatesReviewMany extends BaseCommand {
  static description = 'Review up to 25 discovery candidates with ordered per-item receipts';
  static flags = {
    ...BaseCommand.baseFlags,
    reviews: Flags.string({description: 'Exact versioned review commands as a JSON array'}),
    'reviews-file': Flags.string({description: 'Path to exact versioned review commands JSON array'}),
  };

  async run(): Promise<ReviewBatchResponse> {
    const {flags} = await this.parse(LeadDiscoveryCandidatesReviewMany);
    const parsed = this.parseJsonInput<unknown>(flags.reviews, flags['reviews-file'], 'reviews');
    if (parsed === undefined) this.error('Provide --reviews or --reviews-file.');
    let reviews: Array<Record<string, unknown>>;
    try {
      reviews = asJsonObjectArray(parsed, 'reviews').map((review, index) => {
        if (typeof review.state !== 'string' || typeof review.reasonCode !== 'string') {
          throw new Error(`reviews[${index}] requires state and reasonCode.`);
        }
        assertReviewReasonCode(review.state, review.reasonCode);
        return review;
      });
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
    const response = await this.apiRequest<ReviewBatchResponse>(flags, '/api/v1/lead-discovery/candidates/review-many', {
      method: 'POST',
      body: {reviews},
    });
    if (!this.jsonEnabled()) {
      const items = Array.isArray(response.reviewBatch.items) ? response.reviewBatch.items : [];
      const succeeded = items.filter(item => (item as Record<string, unknown>).ok === true).length;
      this.log(`Batch ${String(response.reviewBatch.outcome)}: ${succeeded}/${items.length} succeeded.`);
    }
    return response;
  }
}

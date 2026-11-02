import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {assertReviewReasonCode} from '../../../lib/lead-discovery-contract.js';

interface ReviewResponse {review: Record<string, unknown>}

export default class LeadDiscoveryCandidatesReview extends BaseCommand {
  static description = 'Versioned shortlist, reject, or restore of one discovery candidate';
  static args = {candidateId: Args.string({description: 'Discovery candidate UUID', required: true})};
  static flags = {
    ...BaseCommand.baseFlags,
    state: Flags.string({description: 'New review state', options: ['discovered', 'shortlisted', 'rejected'], required: true}),
    'expected-review-version': Flags.integer({description: 'Current review version used for optimistic concurrency', min: 0, required: true}),
    'reason-code': Flags.string({description: 'Structured shortlist/reject reason code', required: true}),
    'reason-note': Flags.string({description: 'Optional private review note'}),
    'idempotency-key': Flags.string({description: 'Stable retry key; generated when omitted'}),
  };

  async run(): Promise<ReviewResponse> {
    const {args, flags} = await this.parse(LeadDiscoveryCandidatesReview);
    let reasonCode: string;
    try {
      reasonCode = assertReviewReasonCode(flags.state, flags['reason-code']);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }
    const idempotencyKey = flags['idempotency-key'] ?? this.idempotencyKey();
    const response = await this.apiRequest<ReviewResponse>(
      flags,
      `/api/v1/lead-discovery/candidates/${encodeURIComponent(args.candidateId)}/review`,
      {
        method: 'POST',
        idempotencyKey,
        body: {
          expectedReviewVersion: flags['expected-review-version'],
          idempotencyKey,
          state: flags.state,
          reasonCode,
          ...(flags['reason-note'] ? {reasonNote: flags['reason-note']} : {}),
        },
      },
    );
    if (!this.jsonEnabled()) {
      const candidate = response.review.candidate as Record<string, unknown> | undefined;
      this.log(`Candidate ${String(candidate?.id ?? args.candidateId)}: ${String(candidate?.state ?? flags.state)} at review version ${String(response.review.reviewVersion)}`);
    }
    return response;
  }
}

import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../../lib/base-command.js';
import {renderDetail} from '../../../../lib/output.js';

const RELATIONSHIP_MEETINGS_API = '/api/v1/relationship-meetings';

export default class RelationshipMeetingsProposalsReview extends BaseCommand {
  static description = 'Append an attributable approval or rejection to one unchanged meeting proposal';

  static args = {
    id: Args.string({description: 'Meeting proposal UUID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    input: Flags.string({description: 'Exact decision, reason, and expectedProposalDigest JSON'}),
    'input-file': Flags.string({description: 'Path to exact proposal review input JSON'}),
    yes: Flags.boolean({description: 'Confirm attributable proposal review'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipMeetingsProposalsReview);
    const input = this.parseJsonInput<Record<string, unknown>>(flags.input, flags['input-file'], 'input');
    if (input === undefined || input === null || typeof input !== 'object' || Array.isArray(input)) {
      this.error('Provide --input or --input-file containing a JSON object.');
    }
    const decision = input.decision;
    if (decision !== 'approved' && decision !== 'rejected') {
      this.error('Proposal review decision must be approved or rejected.');
    }
    const confirmed = await this.confirmAction(
      `${decision === 'approved' ? 'Approve' : 'Reject'} meeting proposal ${args.id}?`,
      flags,
    );
    if (!confirmed) return {cancelled: true};
    const response = await this.apiRequest<{proposal: Record<string, unknown>}>(
      flags,
      `${RELATIONSHIP_MEETINGS_API}/proposals/${encodeURIComponent(args.id)}/reviews`,
      {
        method: 'POST',
        body: input,
      },
    );
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Proposal', response.proposal.proposalId],
        ['Decision', response.proposal.status],
        ['Reviewed by', response.proposal.reviewedBy],
        ['Reviewed at', response.proposal.reviewedAt],
      ]);
    }
    return response.proposal;
  }
}

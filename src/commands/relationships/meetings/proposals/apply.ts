import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../../lib/base-command.js';
import {renderDetail} from '../../../../lib/output.js';

const RELATIONSHIP_MEETINGS_API = '/api/v1/relationship-meetings';

export default class RelationshipMeetingsProposalsApply extends BaseCommand {
  static description = 'Atomically apply one approved meeting proposal after fresh precondition checks';

  static args = {
    id: Args.string({description: 'Approved meeting proposal UUID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'expected-proposal-digest': Flags.string({description: 'Exact reviewed proposal digest', required: true}),
    yes: Flags.boolean({description: 'Confirm the persistent internal relationship-state change'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipMeetingsProposalsApply);
    const confirmed = await this.confirmAction(
      `Apply approved meeting proposal ${args.id} to relationship state?`,
      flags,
    );
    if (!confirmed) return {cancelled: true};
    const response = await this.apiRequest<{receipt: Record<string, unknown>}>(
      flags,
      `${RELATIONSHIP_MEETINGS_API}/proposals/${encodeURIComponent(args.id)}/apply`,
      {
        method: 'POST',
        body: {expectedProposalDigest: flags['expected-proposal-digest']},
      },
    );
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Proposal', response.receipt.proposalId],
        ['Status', response.receipt.status],
        ['Applied by', response.receipt.appliedBy],
        ['Applied at', response.receipt.appliedAt],
      ]);
    }
    return response.receipt;
  }
}

import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../../lib/base-command.js';
import {renderDetail} from '../../../../lib/output.js';

const RELATIONSHIP_MEETINGS_API = '/api/v1/relationship-meetings';

export default class RelationshipMeetingsProposalsCreate extends BaseCommand {
  static description = 'Create an immutable, evidence-cited proposal for one registered relationship action';

  static flags = {
    ...BaseCommand.baseFlags,
    input: Flags.string({description: 'Exact meeting proposal input JSON'}),
    'input-file': Flags.string({description: 'Path to exact meeting proposal input JSON'}),
    'idempotency-key': Flags.string({description: 'Caller-owned stable key for exact retries', required: true}),
    yes: Flags.boolean({description: 'Confirm immutable proposal creation'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipMeetingsProposalsCreate);
    const parsed = this.parseJsonInput<Record<string, unknown>>(flags.input, flags['input-file'], 'input');
    if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.error('Provide --input or --input-file containing a JSON object.');
    }
    if (parsed.idempotencyKey !== undefined && parsed.idempotencyKey !== flags['idempotency-key']) {
      this.error('The idempotencyKey in the input must match --idempotency-key.');
    }
    const input = {...parsed, idempotencyKey: flags['idempotency-key']};
    const confirmed = await this.confirmAction(
      'Create this immutable meeting-derived relationship change proposal?',
      flags,
    );
    if (!confirmed) return {cancelled: true};
    const response = await this.apiRequest<{proposal: Record<string, unknown>}>(
      flags,
      `${RELATIONSHIP_MEETINGS_API}/proposals`,
      {
        method: 'POST',
        idempotencyKey: flags['idempotency-key'],
        body: input,
      },
    );
    if (!this.jsonEnabled()) {
      const action = response.proposal.action as Record<string, unknown> | undefined;
      renderDetail([
        ['Proposal', response.proposal.proposalId],
        ['Action', action?.actionId],
        ['Status', response.proposal.status],
        ['Digest', response.proposal.proposalDigest],
      ]);
    }
    return response.proposal;
  }
}

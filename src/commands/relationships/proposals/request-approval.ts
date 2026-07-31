import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class RelationshipProposalsRequestApproval extends BaseCommand {
  static description = 'Request short-lived human approval for a proposal; cannot approve or consume it';

  static args = {
    id: Args.string({description: 'Proposal ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    purpose: Flags.string({description: 'Non-secret reason shown to the human approver'}),
    'idempotency-key': Flags.string({description: 'Stable 8-128 character key for safe retries', required: true}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipProposalsRequestApproval);
    const client = await this.client(flags);
    const response = await client.requestRelationshipProposalApproval(
      args.id,
      {purpose: flags.purpose},
      flags['idempotency-key'],
    );
    this.handleApiError(response);
    const result = response.data ?? {};
    if (!this.jsonEnabled()) {
      const approval = (result as Record<string, unknown>).approval as Record<string, unknown> | undefined;
      this.log(`Approval requested: ${approval?.id ?? 'pending'}`);
      this.log('Approve or deny in the first-party Siftable browser. This CLI cannot approve or consume it.');
    }
    return result;
  }
}

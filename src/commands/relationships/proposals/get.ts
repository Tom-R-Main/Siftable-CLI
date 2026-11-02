import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class RelationshipProposalsGet extends BaseCommand {
  static description = 'Inspect one relationship action proposal and its evidence';

  static args = {
    id: Args.string({description: 'Proposal ID', required: true}),
  };

  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipProposalsGet);
    const client = await this.client(flags);
    const response = await client.getRelationshipActionProposal(args.id);
    this.handleApiError(response);
    const proposal = this.unwrapOne(response, 'proposal');
    if (!this.jsonEnabled()) this.log(JSON.stringify(proposal, null, 2));
    return proposal;
  }
}

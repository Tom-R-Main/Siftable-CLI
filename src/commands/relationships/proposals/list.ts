import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

export default class RelationshipProposalsList extends BaseCommand {
  static description = 'List pending and historical relationship action proposals';

  static flags = {
    ...BaseCommand.baseFlags,
    status: Flags.string({description: 'Filter by proposal status'}),
    sequence: Flags.string({description: 'Filter by sequence ID'}),
    enrollment: Flags.string({description: 'Filter by enrollment ID'}),
    limit: Flags.integer({description: 'Maximum results'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipProposalsList);
    const client = await this.client(flags);
    const response = await client.listRelationshipActionProposals({
      status: flags.status,
      sequenceId: flags.sequence,
      enrollmentId: flags.enrollment,
      limit: flags.limit,
    });
    this.handleApiError(response);
    const proposals = this.unwrapList(response, 'proposals');
    if (!this.jsonEnabled()) {
      renderTable(proposals, [
        {key: 'id', header: 'ID'},
        {key: 'actionId', header: 'Action'},
        {key: 'status', header: 'Status'},
        {key: 'approvalStatus', header: 'Approval'},
      ]);
    }
    return proposals;
  }
}

import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

export default class RelationshipActionsList extends BaseCommand {
  static description = 'List registered relationship actions and their commitment policies';

  static flags = {
    ...BaseCommand.baseFlags,
    commitment: Flags.string({description: 'Filter by commitment class'}),
    'approval-policy': Flags.string({description: 'Filter by approval policy'}),
    limit: Flags.integer({description: 'Maximum results'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipActionsList);
    const client = await this.client(flags);
    const response = await client.listRelationshipActions({
      commitmentClass: flags.commitment,
      approvalPolicy: flags['approval-policy'],
      limit: flags.limit,
    });
    this.handleApiError(response);
    const actions = this.unwrapList(response, 'actions');
    if (!this.jsonEnabled()) {
      renderTable(actions, [
        {key: 'id', header: 'ID'},
        {key: 'label', header: 'Action'},
        {key: 'commitmentClass', header: 'Commitment'},
        {
          key: 'approvalPolicy',
          header: 'Approval',
          get: (row) => {
            const policy = row.approvalPolicy as Record<string, unknown> | undefined;
            return typeof policy?.mode === 'string' ? policy.mode : '-';
          },
        },
      ]);
    }
    return actions;
  }
}

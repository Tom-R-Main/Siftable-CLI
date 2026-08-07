import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

interface RelationshipEmailAccount extends Record<string, unknown> {
  id: string;
  label: string;
  emailAddress: string;
  provider: string;
  status: string;
  syncEnabled: boolean;
}

export default class RelationshipEmailAccountsList extends BaseCommand {
  static description = 'List sender accounts available to relationship drafts and governed sends';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipEmailAccountsList);
    const response = await this.apiRequest<{accounts: RelationshipEmailAccount[]}>(
      flags,
      '/api/v1/email/accounts',
    );
    const accounts = response.accounts.filter(
      (account) => account.status === 'active' && account.syncEnabled,
    );
    if (!this.jsonEnabled()) {
      renderTable(accounts, [
        {key: 'id', header: 'Account ID'},
        {key: 'label', header: 'Label'},
        {key: 'emailAddress', header: 'Address'},
        {key: 'provider', header: 'Provider'},
        {key: 'syncEnabled', header: 'Usable', get: (row) => row.syncEnabled === true ? 'yes' : 'no'},
      ]);
    }
    return accounts;
  }
}

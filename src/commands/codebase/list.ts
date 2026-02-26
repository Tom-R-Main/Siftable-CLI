import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class CodebaseList extends BaseCommand {
  static description = 'List indexed repositories';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CodebaseList);
    const client = await this.client(flags);
    const response = await client.listCodeRepositories();
    this.handleApiError(response);

    const repos = this.unwrapList(response, 'repositories');

    if (!this.jsonEnabled()) {
      renderTable(repos, [
        {key: 'id', header: 'ID'},
        {key: 'name', header: 'Name'},
        {key: 'rootPath', header: 'Path'},
        {key: 'status', header: 'Status'},
      ]);
    }

    return repos;
  }
}

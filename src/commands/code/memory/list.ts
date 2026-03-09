import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

export default class CodeMemoryList extends BaseCommand {
  static description = 'List stored codebase facts';

  static flags = {
    ...BaseCommand.baseFlags,
    repo: Flags.string({description: 'Repository ID'}),
    limit: Flags.integer({description: 'Maximum number of results'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(CodeMemoryList);
    const client = await this.client(flags);
    const response = await client.listCodeMemories({
      repositoryId: flags.repo,
      limit: flags.limit,
    });
    this.handleApiError(response);

    const memories = this.unwrapList(response, 'memories');

    if (!this.jsonEnabled()) {
      renderTable(memories, [
        {key: 'id', header: 'ID'},
        {key: 'content', header: 'Fact'},
        {key: 'factType', header: 'Category'},
        {key: 'filePath', header: 'File'},
      ]);
    }

    return memories;
  }
}

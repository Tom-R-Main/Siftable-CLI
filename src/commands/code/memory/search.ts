import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderTable} from '../../../lib/output.js';

export default class CodeMemorySearch extends BaseCommand {
  static description = 'Search stored codebase facts';

  static args = {
    query: Args.string({description: 'Search query', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    category: Flags.string({
      description: 'Filter by category',
      options: ['architecture', 'integration', 'convention', 'entrypoint', 'gotcha', 'ownership'],
    }),
    repo: Flags.string({description: 'Repository ID'}),
    limit: Flags.integer({description: 'Maximum number of results'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodeMemorySearch);
    const client = await this.client(flags);
    const response = await client.searchCodeMemories({
      query: args.query,
      category: flags.category as 'architecture' | 'integration' | 'convention' | 'entrypoint' | 'gotcha' | 'ownership' | undefined,
      repositoryId: flags.repo,
      limit: flags.limit,
    });
    this.handleApiError(response);

    const memories = this.unwrapList(response, 'memories');

    if (!this.jsonEnabled()) {
      renderTable(memories, [
        {key: 'id', header: 'ID'},
        {key: 'fact', header: 'Fact'},
        {key: 'category', header: 'Category'},
        {key: 'filePath', header: 'File'},
      ]);
    }

    return memories;
  }
}

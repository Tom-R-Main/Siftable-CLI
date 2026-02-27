import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class CodebaseSearch extends BaseCommand {
  static description = 'Semantic code search';

  static args = {
    query: Args.string({description: 'Search query', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    repo: Flags.string({description: 'Repository ID'}),
    language: Flags.string({description: 'Filter by language'}),
    'symbol-type': Flags.string({
      description: 'Filter by symbol type',
      options: ['function', 'class', 'interface', 'type', 'export', 'impl'],
    }),
    limit: Flags.integer({description: 'Maximum number of results'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodebaseSearch);
    const client = await this.client(flags);
    const response = await client.searchCode({
      query: args.query,
      repositoryId: flags.repo,
      language: flags.language,
      symbolType: flags['symbol-type'],
      limit: flags.limit,
    });
    this.handleApiError(response);

    const results = this.unwrapList(response, 'results');

    if (!this.jsonEnabled()) {
      if (results.length) {
        renderTable(results, [
          {key: 'filePath', header: 'File'},
          {key: 'symbolName', header: 'Symbol'},
          {key: 'symbolType', header: 'Type'},
          {key: 'similarity', header: 'Score', get: (r) => r.similarity != null ? String(Number(r.similarity).toFixed(2)) : '—'},
        ]);
      } else {
        this.log('No results found.');
      }
    }

    return results;
  }
}

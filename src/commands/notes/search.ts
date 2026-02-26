import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class NotesSearch extends BaseCommand {
  static description = 'Search notes';

  static args = {
    query: Args.string({description: 'Search query', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    project: Flags.string({description: 'Filter by project ID'}),
    limit: Flags.integer({description: 'Maximum number of results'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(NotesSearch);
    const client = await this.client(flags);
    const response = await client.searchNotes(args.query, {
      projectId: flags.project,
      limit: flags.limit,
    });
    this.handleApiError(response);

    const results = this.unwrapList(response, 'results');

    if (!this.jsonEnabled()) {
      renderTable(results, [
        {key: 'id', header: 'ID'},
        {key: 'title', header: 'Title'},
        {key: 'noteType', header: 'Type'},
        {key: 'score', header: 'Score', get: (r) => r.score != null ? String(Number(r.score).toFixed(2)) : '—'},
      ]);
    }

    return results;
  }
}

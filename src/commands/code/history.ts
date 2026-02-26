import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable, formatDate} from '../../lib/output.js';

export default class CodeHistory extends BaseCommand {
  static description = 'Get commit history for a repository';

  static args = {
    repo: Args.string({description: 'Repository ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    path: Flags.string({description: 'Filter by file path'}),
    limit: Flags.integer({description: 'Maximum number of results'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodeHistory);
    const client = await this.client(flags);
    const response = await client.getCommits(args.repo, {
      path: flags.path,
      limit: flags.limit,
    });
    this.handleApiError(response);

    const commits = this.unwrapList(response, 'commits');

    if (!this.jsonEnabled()) {
      renderTable(commits, [
        {key: 'sha', header: 'SHA', get: (r) => String(r.sha ?? '').slice(0, 8)},
        {key: 'authorName', header: 'Author'},
        {key: 'message', header: 'Message', get: (r) => String(r.message ?? '').split('\n')[0]},
        {key: 'authorDate', header: 'Date', get: (r) => formatDate(r.authorDate as string)},
      ]);
    }

    return commits;
  }
}

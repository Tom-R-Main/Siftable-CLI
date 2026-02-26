import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class CodeWhoKnows extends BaseCommand {
  static description = 'Find experts for a code area';

  static args = {
    repo: Args.string({description: 'Repository ID', required: true}),
    area: Args.string({description: 'Path, glob, or symbol', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({description: 'Maximum number of results'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodeWhoKnows);
    const client = await this.client(flags);
    const response = await client.whoKnows(args.repo, args.area, flags.limit);
    this.handleApiError(response);

    const experts = this.unwrapList(response, 'experts');

    if (!this.jsonEnabled()) {
      renderTable(experts, [
        {key: 'name', header: 'Name'},
        {key: 'email', header: 'Email'},
        {key: 'score', header: 'Score', get: (r) => r.score != null ? String(Number(r.score).toFixed(2)) : '—'},
        {key: 'commits', header: 'Commits'},
      ]);
    }

    return experts;
  }
}

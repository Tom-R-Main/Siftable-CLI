import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {GitService} from '@execufunction/mcp-server/dist/gitService.js';
import {renderTable} from '../../lib/output.js';

export default class CodeBlame extends BaseCommand {
  static description = 'Git blame for a file';

  static args = {
    file: Args.string({description: 'Relative file path', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    root: Flags.string({description: 'Repository root path', default: '.'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodeBlame);
    const git = new GitService(flags.root);
    const entries = await git.getFileBlame(args.file);

    if (!this.jsonEnabled()) {
      renderTable(entries as unknown as Record<string, unknown>[], [
        {key: 'sha', header: 'SHA', get: (r) => String(r.sha ?? '').slice(0, 8)},
        {key: 'author', header: 'Author'},
        {key: 'lineStart', header: 'Line'},
        {key: 'lineCount', header: 'Lines'},
      ]);
    }

    return entries;
  }
}

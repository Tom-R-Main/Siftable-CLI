import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {executeCodebaseIndex} from '../../lib/codebase-index.js';

export default class CodebaseIndex extends BaseCommand {
  static description = 'Deprecated hosted-ingestion path (blocked unless temporarily restored by an operator)';
  static aliases = ['codebase index'];

  static args = {
    id: Args.string({description: 'Repository ID', required: false}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    path: Flags.string({description: 'Absolute path to repository root', required: false}),
    incremental: Flags.boolean({description: 'Git-aware incremental index (changed files only)'}),
    include: Flags.string({description: 'Comma-separated include glob patterns'}),
    exclude: Flags.string({description: 'Comma-separated exclude glob patterns'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodebaseIndex);

    if (!args.id) {
      const lines = [
        'Code context',
        '',
        'USAGE',
        '  $ sift codebase <COMMAND>',
        '',
        'COMMANDS',
        '  codebase index        Deprecated hosted full-ingestion path',
        '  codebase incremental  Deprecated hosted incremental-ingestion path',
        '  codebase list         List indexed repositories',
        '  codebase register     Deprecated hosted repository registration path',
        '  codebase search       Semantic code search',
        '  codebase snapshot     Get latest index snapshot for a repository',
        '  codebase status       Check indexing status for a repository',
        '  codebase delete       Delete a repository and all indexed data',
        '',
        'Use `sift help codebase index` or `sift help codebase incremental` for command-specific flags.',
      ];
      lines.forEach((line) => this.log(line));
      return {
        shownHelp: true,
        commands: ['index', 'incremental', 'list', 'register', 'search', 'snapshot', 'status', 'delete'],
      };
    }

    if (!flags.path) {
      this.error('Missing required flag path');
    }

    const client = await this.client(flags);

    return executeCodebaseIndex({
      client,
      repositoryId: args.id,
      rootPath: flags.path,
      incremental: Boolean(flags.incremental),
      include: flags.include,
      exclude: flags.exclude,
      jsonEnabled: this.jsonEnabled(),
      log: (message) => this.log(message),
    });
  }
}

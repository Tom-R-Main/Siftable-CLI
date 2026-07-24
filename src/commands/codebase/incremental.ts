import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {executeCodebaseIndex} from '../../lib/codebase-index.js';

export default class CodebaseIncremental extends BaseCommand {
  static description = 'Deprecated hosted incremental-ingestion path (blocked by default)';
  static aliases = ['codebase incremental-index', 'codebase index-incremental'];

  static args = {
    id: Args.string({description: 'Repository ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    path: Flags.string({description: 'Absolute path to repository root', required: true}),
    include: Flags.string({description: 'Comma-separated include glob patterns'}),
    exclude: Flags.string({description: 'Comma-separated exclude glob patterns'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodebaseIncremental);
    const client = await this.client(flags);

    return executeCodebaseIndex({
      client,
      repositoryId: args.id,
      rootPath: flags.path,
      incremental: true,
      include: flags.include,
      exclude: flags.exclude,
      jsonEnabled: this.jsonEnabled(),
      log: (message) => this.log(message),
    });
  }
}

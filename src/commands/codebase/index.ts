import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {indexLocalCodebase} from '@execufunction/mcp-server/dist/localIndexer.js';
import {indexIncrementally, formatIncrementalResult} from '@execufunction/mcp-server/dist/incrementalIndexer.js';

export default class CodebaseIndex extends BaseCommand {
  static description = 'Index a codebase (scan and upload files)';

  static args = {
    id: Args.string({description: 'Repository ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    path: Flags.string({description: 'Absolute path to repository root', required: true}),
    incremental: Flags.boolean({description: 'Git-aware incremental index (changed files only)'}),
    include: Flags.string({description: 'Comma-separated include glob patterns'}),
    exclude: Flags.string({description: 'Comma-separated exclude glob patterns'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodebaseIndex);
    const client = await this.client(flags);

    const includePatterns = flags.include?.split(',').map(p => p.trim());
    const excludePatterns = flags.exclude?.split(',').map(p => p.trim());

    const onProgress = this.jsonEnabled() ? undefined : (progress: {phase: string; filesFound: number; filesUploaded: number; currentFile?: string}) => {
      process.stderr.write(`\r${progress.phase}: ${progress.filesUploaded}/${progress.filesFound} files${progress.currentFile ? ` (${progress.currentFile})` : ''}  `);
    };

    if (flags.incremental) {
      const result = await indexIncrementally(client, args.id, flags.path, {
        includePatterns,
        excludePatterns,
        onProgress,
      });

      if (!this.jsonEnabled()) {
        process.stderr.write('\n');
        this.log(formatIncrementalResult(result));
      }

      return result;
    }

    const result = await indexLocalCodebase(client, args.id, flags.path, {
      includePatterns,
      excludePatterns,
      onProgress,
    });

    if (!this.jsonEnabled()) {
      process.stderr.write('\n');
      this.log(`Indexing complete: ${result.filesUploaded} files, ${result.chunksCreated} chunks`);
    }

    return result;
  }
}

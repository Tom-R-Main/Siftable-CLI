import { ExfClient } from '@siftable/mcp-server/dist/exfClient.js';
import {
  assertHostedCodebaseIngestionEnabled,
  indexLocalCodebase,
} from '@siftable/mcp-server/dist/localIndexer.js';
import { indexIncrementally, formatIncrementalResult } from '@siftable/mcp-server/dist/incrementalIndexer.js';

interface ExecuteCodebaseIndexOptions {
  client: ExfClient;
  repositoryId: string;
  rootPath: string;
  incremental: boolean;
  include?: string;
  exclude?: string;
  jsonEnabled: boolean;
  log: (message: string) => void;
}

export async function executeCodebaseIndex({
  client,
  repositoryId,
  rootPath,
  incremental,
  include,
  exclude,
  jsonEnabled,
  log,
}: ExecuteCodebaseIndexOptions): Promise<unknown> {
  await assertHostedCodebaseIngestionEnabled(client);

  const includePatterns = include?.split(',').map((pattern) => pattern.trim());
  const excludePatterns = exclude?.split(',').map((pattern) => pattern.trim());

  const onProgress = jsonEnabled ? undefined : (progress: { phase: string; filesFound: number; filesUploaded: number; currentFile?: string }) => {
    process.stderr.write(`\r${progress.phase}: ${progress.filesUploaded}/${progress.filesFound} files${progress.currentFile ? ` (${progress.currentFile})` : ''}  `);
  };

  if (incremental) {
    const result = await indexIncrementally(client, repositoryId, rootPath, {
      includePatterns,
      excludePatterns,
      onProgress,
    });

    if (result.phase === 'error') {
      throw new Error(result.error || 'Incremental hosted indexing failed.');
    }

    if (!jsonEnabled) {
      process.stderr.write('\n');
      log(formatIncrementalResult(result));
    }

    return result;
  }

  const result = await indexLocalCodebase(client, repositoryId, rootPath, {
    includePatterns,
    excludePatterns,
    onProgress,
  });

  if (result.phase === 'error') {
    throw new Error(result.error || 'Hosted indexing failed.');
  }

  if (!jsonEnabled) {
    process.stderr.write('\n');
    log(`Indexing complete: ${result.filesUploaded} files, ${result.chunksCreated} chunks`);
  }

  return result;
}

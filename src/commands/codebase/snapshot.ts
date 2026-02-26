import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail} from '../../lib/output.js';

export default class CodebaseSnapshot extends BaseCommand {
  static description = 'Get latest index snapshot for a repository';

  static args = {
    id: Args.string({description: 'Repository ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    branch: Flags.string({description: 'Filter by branch'}),
    materialize: Flags.boolean({description: 'Generate a download URL for the snapshot'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(CodebaseSnapshot);
    const client = await this.client(flags);

    const snapshotResponse = await client.getLatestCodeSnapshot(args.id, {
      branch: flags.branch,
    });
    this.handleApiError(snapshotResponse);

    const snapshot = snapshotResponse.data as Record<string, unknown>;

    if (flags.materialize && snapshot.id) {
      const archiveResponse = await client.createSnapshotArchiveUrl(snapshot.id as string);
      this.handleApiError(archiveResponse);

      const archive = archiveResponse.data as Record<string, unknown>;

      if (!this.jsonEnabled()) {
        renderDetail([
          ['Snapshot ID', snapshot.id],
          ['Branch', snapshot.branch],
          ['Commit', snapshot.commitSha],
          ['Download URL', archive.url],
          ['Expires', archive.expiresAt],
        ]);
      }

      return {...snapshot, archive: archiveResponse.data};
    }

    if (!this.jsonEnabled()) {
      renderDetail([
        ['Snapshot ID', snapshot.id],
        ['Branch', snapshot.branch],
        ['Commit', snapshot.commitSha],
        ['Files', snapshot.fileCount],
        ['Created', snapshot.createdAt],
      ]);
    }

    return snapshot;
  }
}

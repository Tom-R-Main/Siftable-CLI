import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {formatDateTime, renderTable} from '../../lib/output.js';

export default class DatasetsCleanup extends BaseCommand {
  static description = 'Plan or apply cleanup for lifecycle-tagged scratch datasets';

  static flags = {
    ...BaseCommand.baseFlags,
    lifecycle: Flags.string({description: 'Lifecycle kind to clean, e.g. scratch, benchmark, research-run'}),
    tag: Flags.string({description: 'Lifecycle tag to clean, e.g. benchmark'}),
    'older-than': Flags.string({description: 'Only include datasets older than this duration, e.g. 12h, 7d'}),
    limit: Flags.integer({description: 'Maximum lifecycle datasets to inspect', default: 100}),
    now: Flags.string({description: 'Deterministic timestamp for tests and scheduled cleanup'}),
    'dry-run': Flags.boolean({description: 'Return a deterministic cleanup plan without deleting datasets', default: true, allowNo: true}),
    yes: Flags.boolean({char: 'y', description: 'Confirm deletion when applying cleanup with --no-dry-run'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(DatasetsCleanup);
    const dryRun = flags['dry-run'] !== false;

    if (!dryRun) {
      const confirmed = await this.confirmAction(
        'Apply dataset cleanup? This permanently drops each candidate dataset table and archives its backing note.',
        flags,
      );
      if (!confirmed) {
        this.log('Cleanup cancelled.');
        return {ok: false, cancelled: true, dryRun: false};
      }
    }

    const client = await this.client(flags);
    const response = await client.cleanupDatasets({
      dryRun,
      lifecycle: flags.lifecycle,
      tag: flags.tag,
      olderThan: flags['older-than'],
      limit: flags.limit,
      now: flags.now,
    });
    this.handleApiError(response);

    const data = response.data as Record<string, unknown>;
    if (!this.jsonEnabled()) {
      const summary = data.summary as {candidates?: number; deleted?: number} | undefined;
      this.log(`${dryRun ? 'Cleanup plan' : 'Cleanup applied'}: ${summary?.candidates ?? 0} candidate(s), ${summary?.deleted ?? 0} deleted.`);
      renderTable(((data.candidates as Record<string, unknown>[] | undefined) ?? []), [
        {key: 'id', header: 'ID'},
        {key: 'title', header: 'Title'},
        {key: 'rowCount', header: 'Rows', get: (row) => String(row.rowCount ?? 0)},
        {key: 'createdAt', header: 'Created', get: (row) => formatDateTime(row.createdAt as string)},
        {key: 'reasons', header: 'Reasons', get: (row) => Array.isArray(row.reasons) ? row.reasons.join(',') : '—'},
      ]);
    }

    return data;
  }
}

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderTable } from '../../../lib/output.js';
import { queryString } from './_helpers.js';

export default class RelationshipPlaybooksList extends BaseCommand {
  static description = 'List immutable relationship playbook versions and latest approval decisions';
  static flags = {
    ...BaseCommand.baseFlags,
    'stable-key': Flags.string({ description: 'Filter by stable playbook key' }),
    limit: Flags.integer({ description: 'Maximum versions', min: 1, max: 200 }),
  };

  async run(): Promise<unknown> {
    const { flags } = await this.parse(RelationshipPlaybooksList);
    const response = await this.apiRequest<{ playbooks: Array<Record<string, unknown>> }>(
      flags,
      `/api/v1/relationship-playbooks/playbooks${queryString({ stableKey: flags['stable-key'], limit: flags.limit })}`,
    );
    if (!this.jsonEnabled()) {
      renderTable(response.playbooks.map((record) => {
        const snapshot = record.snapshot as Record<string, unknown>;
        const review = record.latestReview as Record<string, unknown> | null;
        return { key: snapshot.stableKey, version: snapshot.version, name: snapshot.name, decision: review?.decision ?? 'pending' };
      }), [
        { key: 'key', header: 'Key' },
        { key: 'version', header: 'Version' },
        { key: 'name', header: 'Name' },
        { key: 'decision', header: 'Approval' },
      ]);
    }
    return response.playbooks;
  }
}

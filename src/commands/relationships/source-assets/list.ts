import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderTable } from '../../../lib/output.js';
import {queryString} from '../../../lib/relationship-command-input.js';

export default class RelationshipSourceAssetsList extends BaseCommand {
  static description = 'List immutable grounded source-asset versions and latest approval decisions';
  static flags = {
    ...BaseCommand.baseFlags,
    'stable-key': Flags.string({ description: 'Filter by stable source-asset key' }),
    limit: Flags.integer({ description: 'Maximum versions', min: 1, max: 200 }),
  };

  async run(): Promise<unknown> {
    const { flags } = await this.parse(RelationshipSourceAssetsList);
    const response = await this.apiRequest<{ sourceAssets: Array<Record<string, unknown>> }>(
      flags,
      `/api/v1/relationship-playbooks/source-assets${queryString({ stableKey: flags['stable-key'], limit: flags.limit })}`,
    );
    if (!this.jsonEnabled()) {
      renderTable(response.sourceAssets.map((record) => {
        const snapshot = record.snapshot as Record<string, unknown>;
        const review = record.latestReview as Record<string, unknown> | null;
        return { key: snapshot.stableKey, version: snapshot.version, title: snapshot.title, decision: review?.decision ?? 'pending' };
      }), [
        { key: 'key', header: 'Key' },
        { key: 'version', header: 'Version' },
        { key: 'title', header: 'Title' },
        { key: 'decision', header: 'Approval' },
      ]);
    }
    return response.sourceAssets;
  }
}

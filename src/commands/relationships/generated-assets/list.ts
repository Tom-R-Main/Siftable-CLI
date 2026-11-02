import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderTable } from '../../../lib/output.js';
import {queryString} from '../../../lib/relationship-command-input.js';

export default class RelationshipGeneratedAssetsList extends BaseCommand {
  static description = 'List generated relationship assets with manifests and latest artifact review';
  static flags = {
    ...BaseCommand.baseFlags,
    'subject-type': Flags.string({ options: ['prospect', 'opportunity'] }),
    'subject-id': Flags.string(),
    limit: Flags.integer({ min: 1, max: 200 }),
  };

  async run(): Promise<unknown> {
    const { flags } = await this.parse(RelationshipGeneratedAssetsList);
    if (Boolean(flags['subject-type']) !== Boolean(flags['subject-id'])) this.error('--subject-type and --subject-id must be provided together');
    const response = await this.apiRequest<{ generatedAssets: Array<Record<string, unknown>> }>(
      flags,
      `/api/v1/relationship-playbooks/generated-assets${queryString({ subjectType: flags['subject-type'], subjectId: flags['subject-id'], limit: flags.limit })}`,
    );
    if (!this.jsonEnabled()) {
      renderTable(response.generatedAssets.map((record) => {
        const snapshot = record.snapshot as Record<string, unknown>;
        const review = record.latestReview as Record<string, unknown> | null;
        return { id: snapshot.generatedAssetId, kind: snapshot.kind, title: snapshot.title, decision: review?.decision ?? 'pending' };
      }), [
        { key: 'id', header: 'Asset' },
        { key: 'kind', header: 'Kind' },
        { key: 'title', header: 'Title' },
        { key: 'decision', header: 'Approval' },
      ]);
    }
    return response.generatedAssets;
  }
}

import { Args } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';

export default class RelationshipGeneratedAssetsShow extends BaseCommand {
  static description = 'Show one generated asset, exact manifest, and latest artifact approval';
  static args = { id: Args.string({ description: 'Generated asset UUID', required: true }) };
  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipGeneratedAssetsShow);
    const response = await this.apiRequest<{ generatedAsset: Record<string, unknown> }>(
      flags, `/api/v1/relationship-playbooks/generated-assets/${encodeURIComponent(args.id)}`,
    );
    if (!this.jsonEnabled()) {
      const snapshot = response.generatedAsset.snapshot as Record<string, unknown>;
      const review = response.generatedAsset.latestReview as Record<string, unknown> | null;
      renderDetail([['Asset', args.id], ['Kind', snapshot.kind], ['Title', snapshot.title], ['Approval', review?.decision ?? 'pending']]);
    }
    return response.generatedAsset;
  }
}

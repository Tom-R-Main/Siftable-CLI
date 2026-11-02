import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail} from '../../../lib/output.js';

export default class RelationshipSourceAssetsShow extends BaseCommand {
  static description = 'Show one exact immutable source-asset version and its latest review';
  static args = {id: Args.string({description: 'Source-asset version UUID', required: true})};
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipSourceAssetsShow);
    const response = await this.apiRequest<{sourceAsset: Record<string, unknown>}>(
      flags,
      `/api/v1/relationship-playbooks/source-assets/${encodeURIComponent(args.id)}`,
    );
    if (!this.jsonEnabled()) {
      const snapshot = response.sourceAsset.snapshot as Record<string, unknown>;
      const review = response.sourceAsset.latestReview as Record<string, unknown> | null;
      renderDetail([
        ['ID', snapshot.sourceAssetVersionId],
        ['Key', snapshot.stableKey],
        ['Version', snapshot.version],
        ['Approval', review?.decision ?? 'pending'],
      ]);
    }
    return response.sourceAsset;
  }
}

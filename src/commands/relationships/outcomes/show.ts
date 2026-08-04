import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail} from '../../../lib/output.js';

const OUTCOMES_API = '/api/v1/opportunities/analytics/outcomes';

export default class RelationshipOutcomesShow extends BaseCommand {
  static description = 'Show one immutable relationship-outcome snapshot';

  static args = {
    snapshotId: Args.string({description: 'Relationship-outcome snapshot ID', required: true}),
  };

  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipOutcomesShow);
    const response = await this.apiRequest<{snapshot: Record<string, unknown>}>(
      flags,
      `${OUTCOMES_API}/snapshots/${encodeURIComponent(args.snapshotId)}`,
    );
    if (!this.jsonEnabled()) {
      const verification = response.snapshot?.verification as Record<string, unknown> | undefined;
      renderDetail([
        ['Snapshot', response.snapshot?.id ?? response.snapshot?.snapshotId ?? args.snapshotId],
        ['Projection', response.snapshot?.projection ?? '—'],
        ['As of', response.snapshot?.asOf ?? '—'],
        ['Convention digest', response.snapshot?.conventionDigest ?? '—'],
        ['Verification', verification?.tier ?? response.snapshot?.verificationTier ?? '—'],
      ]);
    }
    return response;
  }
}

import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail} from '../../../lib/output.js';

const OUTCOMES_API = '/api/v1/opportunities/analytics/outcomes';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export default class RelationshipOutcomesReview extends BaseCommand {
  static description = 'Record an idempotent snapshot review without executing any proposed registered action';

  static args = {
    snapshotId: Args.string({description: 'Relationship-outcome snapshot ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    input: Flags.string({
      description: 'Exact ReviewRelationshipOutcomeSnapshotInput JSON (idempotency is injected)',
    }),
    'input-file': Flags.string({description: 'Path to exact snapshot review input JSON'}),
    'idempotency-key': Flags.string({
      description: 'Caller-owned stable key for this exact review',
      required: true,
    }),
    'dry-run': Flags.boolean({description: 'Validate authority and selected interventions without recording a review'}),
    yes: Flags.boolean({description: 'Confirm append-only review recording'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipOutcomesReview);
    const input = this.parseJsonInput<Record<string, unknown>>(
      flags.input,
      flags['input-file'],
      'input',
    );
    if (!isObject(input)) {
      this.error('Provide --input or --input-file containing a JSON object.');
    }
    if (typeof input.expectedSnapshotDigest !== 'string'
      || !Array.isArray(input.selectedInterventionIds)) {
      this.error('Review input must bind expectedSnapshotDigest and selectedInterventionIds.');
    }
    const dryRun = flags['dry-run'] === true || input.dryRun === true;
    if (!dryRun) {
      const confirmed = await this.confirmAction(
        `Record ${String(input.decision ?? 'snapshot')} review for snapshot ${args.snapshotId}? No proposed registered action will execute.`,
        flags,
      );
      if (!confirmed) return {cancelled: true};
    }

    const body = {...input, idempotencyKey: flags['idempotency-key'], dryRun};
    const response = await this.apiRequest<{
      review: Record<string, unknown>;
      receipt: Record<string, unknown>;
    }>(flags, `${OUTCOMES_API}/snapshots/${encodeURIComponent(args.snapshotId)}/reviews`, {
      method: 'POST',
      idempotencyKey: flags['idempotency-key'],
      body,
    });
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Snapshot', args.snapshotId],
        ['Review', response.review?.id ?? response.review?.reviewId ?? '—'],
        ['Decision', response.review?.decision ?? input.decision ?? '—'],
        ['Recorded', response.receipt?.persisted ?? !dryRun],
        ['Action execution', 'None; review never executes the proposed registered action'],
      ]);
    }
    return response;
  }
}

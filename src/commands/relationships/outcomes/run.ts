import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail} from '../../../lib/output.js';

const OUTCOMES_API = '/api/v1/opportunities/analytics/outcomes';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export default class RelationshipOutcomesRun extends BaseCommand {
  static description = 'Create or dry-run a C2 relationship-outcome snapshot; never execute proposed actions';

  static flags = {
    ...BaseCommand.baseFlags,
    input: Flags.string({
      description: 'Exact CreateRelationshipOutcomeSnapshotInput JSON (idempotency is injected)',
    }),
    'input-file': Flags.string({description: 'Path to exact snapshot input JSON'}),
    'idempotency-key': Flags.string({
      description: 'Caller-owned stable key for this exact snapshot request',
      required: true,
    }),
    'dry-run': Flags.boolean({description: 'Validate and project without persisting a snapshot'}),
    yes: Flags.boolean({description: 'Confirm C2 snapshot persistence'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipOutcomesRun);
    const input = this.parseJsonInput<Record<string, unknown>>(
      flags.input,
      flags['input-file'],
      'input',
    );
    if (!isObject(input)) {
      this.error('Provide --input or --input-file containing a JSON object.');
    }
    const declaration = input.declaration;
    if (!isObject(declaration)
      || !isObject(declaration.scopeAnchor)
      || !isObject(declaration.categoryConvention)) {
      this.error('The input declaration must explicitly include scopeAnchor and categoryConvention objects.');
    }
    const dryRun = flags['dry-run'] === true || input.dryRun === true;
    if (!dryRun) {
      const confirmed = await this.confirmAction(
        'Create this C2 relationship-outcome snapshot? This records analytics only and never executes proposed actions.',
        flags,
      );
      if (!confirmed) return {cancelled: true};
    }

    const body = {
      ...input,
      idempotencyKey: flags['idempotency-key'],
      dryRun,
    };
    const response = await this.apiRequest<{
      snapshot: Record<string, unknown>;
      receipt: Record<string, unknown>;
    }>(flags, `${OUTCOMES_API}/snapshots`, {
      method: 'POST',
      idempotencyKey: flags['idempotency-key'],
      body,
    });
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Snapshot', response.snapshot?.id ?? response.snapshot?.snapshotId ?? 'preview'],
        ['Projection', response.snapshot?.projection ?? input.projection ?? '—'],
        ['Commitment', dryRun ? 'C2 dry-run; no side effect' : 'C2 snapshot record'],
        ['Persisted', response.receipt?.persisted ?? !dryRun],
        ['Action execution', 'None; proposed registered actions require a separate command'],
      ]);
    }
    return response;
  }
}

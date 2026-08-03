import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail, renderTable} from '../../../lib/output.js';

const OUTCOMES_API = '/api/v1/opportunities/analytics/outcomes';

export default class RelationshipOutcomesInterventions extends BaseCommand {
  static description = 'Show the single bounded, reviewable intervention batch for a snapshot';

  static args = {
    snapshotId: Args.string({description: 'Relationship-outcome snapshot ID', required: true}),
  };

  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipOutcomesInterventions);
    const response = await this.apiRequest<{interventionBatch: Record<string, unknown>}>(
      flags,
      `${OUTCOMES_API}/snapshots/${encodeURIComponent(args.snapshotId)}/interventions`,
    );
    if (!this.jsonEnabled()) {
      const items = Array.isArray(response.interventionBatch?.items)
        ? response.interventionBatch.items as Record<string, unknown>[]
        : [];
      renderDetail([
        ['Snapshot', args.snapshotId],
        ['Batch', response.interventionBatch?.id ?? response.interventionBatch?.batchId ?? '—'],
        ['Items', items.length],
        ['Auto execute', response.interventionBatch?.autoExecute ?? false],
        ['Action execution', 'None; this command only reads proposals'],
      ]);
      renderTable(items, [
        {key: 'id', header: 'Intervention', get: row => String(row.id ?? row.interventionId ?? '—')},
        {key: 'requiredDecision', header: 'Decision'},
        {key: 'commitmentClass', header: 'Class'},
        {
          key: 'registeredAction',
          header: 'Registered action',
          get: row => {
            const action = row.registeredAction as Record<string, unknown> | undefined;
            return String(action?.actionId ?? '—');
          },
        },
      ]);
    }
    return response;
  }
}

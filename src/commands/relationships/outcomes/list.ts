import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail, renderTable} from '../../../lib/output.js';

const OUTCOMES_API = '/api/v1/opportunities/analytics/outcomes';

export default class RelationshipOutcomesList extends BaseCommand {
  static description = 'List relationship-outcome snapshots with bounded cursor pagination';

  static flags = {
    ...BaseCommand.baseFlags,
    projection: Flags.string({
      description: 'Filter by projection',
      options: ['sales_forecast', 'onboarding_handoff'],
    }),
    'scope-anchor-kind': Flags.string({description: 'Filter by declared scope anchor kind'}),
    'scope-anchor-id': Flags.string({description: 'Filter by declared scope anchor ID'}),
    limit: Flags.integer({description: 'Maximum snapshots to return', default: 50, min: 1, max: 200}),
    cursor: Flags.string({description: 'Opaque cursor from the previous page'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipOutcomesList);
    const query = new URLSearchParams({limit: String(flags.limit)});
    if (flags.projection) query.set('projection', flags.projection);
    if (flags['scope-anchor-kind']) query.set('scopeAnchorKind', flags['scope-anchor-kind']);
    if (flags['scope-anchor-id']) query.set('scopeAnchorId', flags['scope-anchor-id']);
    if (flags.cursor) query.set('cursor', flags.cursor);
    const response = await this.apiRequest<{
      snapshots: Record<string, unknown>[];
      page: Record<string, unknown>;
    }>(flags, `${OUTCOMES_API}/snapshots?${query.toString()}`);
    if (!this.jsonEnabled()) {
      renderTable(response.snapshots ?? [], [
        {key: 'id', header: 'Snapshot', get: row => String(row.id ?? row.snapshotId ?? '—')},
        {key: 'projection', header: 'Projection'},
        {
          key: 'asOf',
          header: 'As of',
          get: row => {
            const declaration = row.declaration as Record<string, unknown> | undefined;
            return String(declaration?.asOf ?? '—');
          },
        },
        {
          key: 'verification',
          header: 'Verification',
          get: row => {
            const verification = row.verification as Record<string, unknown> | undefined;
            return String(verification?.status ?? '—');
          },
        },
      ]);
      if (response.page?.nextCursor) renderDetail([['Next cursor', response.page.nextCursor]]);
    }
    return response;
  }
}

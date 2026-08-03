import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail, renderTable} from '../../../lib/output.js';

const OUTCOMES_API = '/api/v1/opportunities/analytics/outcomes';

export default class RelationshipOutcomesRecords extends BaseCommand {
  static description = 'List exact snapshot records with bounded cursor pagination';

  static args = {
    snapshotId: Args.string({description: 'Relationship-outcome snapshot ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({description: 'Maximum records to return', default: 50, min: 1, max: 100}),
    cursor: Flags.string({description: 'Opaque cursor from the previous page'}),
    risk: Flags.string({description: 'Filter by low, moderate, high, or unknown operational risk'}),
    posture: Flags.string({description: 'Filter by the declared record posture'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipOutcomesRecords);
    const query = new URLSearchParams({limit: String(flags.limit)});
    if (flags.cursor) query.set('cursor', flags.cursor);
    if (flags.risk) query.set('risk', flags.risk);
    if (flags.posture) query.set('posture', flags.posture);
    const response = await this.apiRequest<{
      records: Record<string, unknown>[];
      page: Record<string, unknown>;
    }>(
      flags,
      `${OUTCOMES_API}/snapshots/${encodeURIComponent(args.snapshotId)}/records?${query.toString()}`,
    );
    if (!this.jsonEnabled()) {
      renderTable(response.records ?? [], [
        {key: 'id', header: 'Record', get: row => String(row.id ?? row.recordId ?? row.opportunityId ?? '—')},
        {
          key: 'label',
          header: 'Relationship',
          get: row => {
            const subject = row.subject as Record<string, unknown> | undefined;
            return String(subject?.label ?? row.label ?? row.name ?? '—');
          },
        },
        {key: 'posture', header: 'Posture'},
        {key: 'operationalRisk', header: 'Risk'},
      ]);
      if (response.page?.nextCursor) renderDetail([['Next cursor', response.page.nextCursor]]);
    }
    return response;
  }
}

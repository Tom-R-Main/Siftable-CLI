import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {formatDateTime, renderDetail} from '../../lib/output.js';

export default class ProjectsPlanningRecompute extends BaseCommand {
  static description = 'Recompute the canonical CSN planning snapshot for a project';

  static args = {
    id: Args.string({description: 'Project ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ProjectsPlanningRecompute);
    const client = await this.client(flags);
    const response = await client.recomputeProjectPlanning(args.id);
    this.handleApiError(response);

    const bundle = response.data as Record<string, any>;

    if (!this.jsonEnabled()) {
      const snapshot = bundle.snapshot;
      const state = bundle.state ?? {};
      renderDetail([
        ['Project', args.id],
        ['Status', state.lastComputeStatus ?? 'idle'],
        ['Computed', formatDateTime(state.lastComputedAt ?? null)],
        ['P50', snapshot?.mcPercentiles?.p50 != null ? `${snapshot.mcPercentiles.p50}d` : '—'],
        ['P80', snapshot?.mcPercentiles?.p80 != null ? `${snapshot.mcPercentiles.p80}d` : '—'],
        ['P95', snapshot?.mcPercentiles?.p95 != null ? `${snapshot.mcPercentiles.p95}d` : '—'],
      ]);
      this.log('\nPlanning snapshot recomputed.');
    }

    return bundle;
  }
}

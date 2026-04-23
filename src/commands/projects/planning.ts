import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {formatDateTime, renderDetail, renderTable} from '../../lib/output.js';

export default class ProjectsPlanning extends BaseCommand {
  static description = 'Get the canonical CSN planning snapshot for a project';

  static args = {
    id: Args.string({description: 'Project ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ProjectsPlanning);
    const client = await this.client(flags);
    const response = await client.getProjectPlanning(args.id);
    this.handleApiError(response);

    const bundle = response.data as Record<string, any>;

    if (!this.jsonEnabled()) {
      const snapshot = bundle.snapshot;
      const state = bundle.state ?? {};
      renderDetail([
        ['Project', args.id],
        ['Status', state.lastComputeStatus ?? 'idle'],
        ['Dirty', state.dirty ? 'yes' : 'no'],
        ['Computed', formatDateTime(state.lastComputedAt ?? null)],
        ['P50', snapshot?.mcPercentiles?.p50 != null ? `${snapshot.mcPercentiles.p50}d` : '—'],
        ['P80', snapshot?.mcPercentiles?.p80 != null ? `${snapshot.mcPercentiles.p80}d` : '—'],
        ['P95', snapshot?.mcPercentiles?.p95 != null ? `${snapshot.mcPercentiles.p95}d` : '—'],
        ['Invalid cycles', snapshot?.invalidCycles?.length ?? 0],
      ]);

      const nextActions = (snapshot?.priorityRanking ?? []).slice(0, 5).map((entry: any) => ({
        taskId: entry.taskId,
        title: bundle.tasks?.find((task: any) => task.id === entry.taskId)?.title ?? entry.taskId,
        priority: Number(entry.priority).toFixed(2),
        reason: entry.reason ?? '—',
      }));
      if (nextActions.length > 0) {
        this.log('\nNext actions:');
        renderTable(nextActions, [
          {key: 'taskId', header: 'Task ID'},
          {key: 'title', header: 'Title'},
          {key: 'priority', header: 'Priority'},
          {key: 'reason', header: 'Reason'},
        ]);
      }

      const corridor = (snapshot?.criticalCorridor ?? []).slice(0, 5).map((entry: any) => ({
        taskId: entry.taskId,
        title: bundle.tasks?.find((task: any) => task.id === entry.taskId)?.title ?? entry.taskId,
        criticality: Number(entry.criticality).toFixed(2),
      }));
      if (corridor.length > 0) {
        this.log('\nCritical corridor:');
        renderTable(corridor, [
          {key: 'taskId', header: 'Task ID'},
          {key: 'title', header: 'Title'},
          {key: 'criticality', header: 'Criticality'},
        ]);
      }
    }

    return bundle;
  }
}

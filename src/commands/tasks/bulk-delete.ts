import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderTable} from '../../lib/output.js';

export default class TasksBulkDelete extends BaseCommand {
  static description = 'Preview or bulk-delete tasks';

  static flags = {
    ...BaseCommand.baseFlags,
    ids: Flags.string({description: 'Comma-separated task IDs'}),
    'title-starts-with': Flags.string({description: 'Title prefix filter'}),
    'title-contains': Flags.string({description: 'Title substring filter'}),
    'title-equals': Flags.string({description: 'Exact title filter'}),
    phase: Flags.string({options: ['draft', 'open', 'in_flight', 'review', 'blocked', 'done', 'cancelled']}),
    done: Flags.boolean({description: 'Filter by completed state'}),
    when: Flags.string({options: ['now', 'today', 'soon', 'later']}),
    confirm: Flags.boolean({description: 'Execute deletion instead of preview'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(TasksBulkDelete);
    const client = await this.client(flags);
    const taskIds = flags.ids?.split(',').map((id) => id.trim()).filter(Boolean);
    const filter = {
      titleStartsWith: flags['title-starts-with'],
      titleContains: flags['title-contains'],
      titleEquals: flags['title-equals'],
      phase: flags.phase,
      isDone: flags.done,
      when: flags.when,
    };

    const response = await client.bulkDeleteTasks({
      taskIds,
      filter,
      dryRun: !flags.confirm,
      confirm: flags.confirm,
    });
    this.handleApiError(response);
    const data = response.data || {matched: [], matchedCount: 0, deletedCount: 0, previewOnly: true, truncated: false};

    if (!this.jsonEnabled()) {
      if (data.previewOnly) {
        this.log(`Preview: ${data.matchedCount} task(s) matched.`);
        renderTable((data.matched || []) as Record<string, unknown>[], [
          {key: 'id', header: 'ID'},
          {key: 'title', header: 'Title'},
          {key: 'phase', header: 'Phase'},
          {key: 'when', header: 'When'},
        ]);
        if (data.truncated) this.log('Results truncated to 200 matches.');
        this.log('Re-run with --confirm to execute deletion.');
      } else {
        this.log(`Deleted ${data.deletedCount} task(s).`);
      }
    }

    return data;
  }
}

import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {renderDetail, formatDate} from '../../lib/output.js';

export default class TasksGet extends BaseCommand {
  static description = 'Get human planning task details';

  static args = {
    id: Args.string({description: 'Task ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(TasksGet);
    const client = await this.client(flags);
    const response = await client.getTask(args.id);
    this.handleApiError(response);

    const task = this.unwrapOne(response, 'task');

    if (!this.jsonEnabled()) {
      // Format acceptance criteria
      const ac = task.acceptanceCriteria as Array<{ text: string; met: boolean }> | undefined;
      let acDisplay = '—';
      if (ac && ac.length > 0) {
        const met = ac.filter((c: { met: boolean }) => c.met).length;
        acDisplay = `${met}/${ac.length} met\n` + ac.map((c: { text: string; met: boolean }) => `  ${c.met ? '[x]' : '[ ]'} ${c.text}`).join('\n');
      }

      // Format scope
      const sc = task.scope as { include?: string[]; exclude?: string[] } | undefined;
      let scopeDisplay = '—';
      if (sc && ((sc.include?.length ?? 0) > 0 || (sc.exclude?.length ?? 0) > 0)) {
        const parts: string[] = [];
        if (sc.include?.length) parts.push(...sc.include.map((s: string) => `  + ${s}`));
        if (sc.exclude?.length) parts.push(...sc.exclude.map((s: string) => `  - ${s}`));
        scopeDisplay = parts.join('\n');
      }

      renderDetail([
        ['ID', task.id],
        ['Title', task.title],
        ['Phase', task.phase || 'open'],
        ['Effort', task.effort || 'unknown'],
        ['Status', task.status],
        ['Priority', task.priority],
        ['Agent Work', `Use ${this.config.bin} work list --task ${task.id}`],
        ['Blocked Reason', task.blockedReason || '—'],
        ['Acceptance Criteria', acDisplay],
        ['Scope', scopeDisplay],
        ['Description', task.description],
        ['Due', formatDate(task.dueAt as string)],
        ['Project', task.projectId],
        ['Created', formatDate(task.createdAt as string)],
        ['Updated', formatDate(task.updatedAt as string)],
      ]);
    }

    return response.data;
  }
}

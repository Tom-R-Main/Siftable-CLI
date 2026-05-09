import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class TasksCreate extends BaseCommand {
  static description = 'Create a human planning task';

  static examples = [
    '<%= config.bin %> tasks create --title "Review PR"',
    '<%= config.bin %> tasks create --title "Ship feature" --priority do_now --due 2026-03-01',
    '<%= config.bin %> tasks create --title "Refactor auth" --effort medium --phase draft',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Task title', required: true}),
    description: Flags.string({description: 'Task description'}),
    priority: Flags.string({
      description: 'Priority level',
      options: ['do_now', 'schedule', 'delegate', 'someday'],
    }),
    due: Flags.string({description: 'Due date (ISO 8601)'}),
    project: Flags.string({description: 'Project ID'}),
    phase: Flags.string({
      description: 'Lifecycle phase',
      options: ['draft', 'open', 'in_flight', 'review', 'blocked', 'done', 'cancelled'],
    }),
    effort: Flags.string({
      description: 'Effort estimate',
      options: ['trivial', 'small', 'medium', 'large', 'epic', 'unknown'],
    }),
    'acceptance-criteria': Flags.string({
      description: 'Acceptance criteria (semicolon-separated text, e.g. "tests pass; docs updated")',
    }),
    scope: Flags.string({
      description: 'Scope boundaries (JSON object with include/exclude arrays)',
    }),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(TasksCreate);
    const client = await this.client(flags);
    // Parse acceptance criteria: semicolon-separated → array of {text, met: false}
    let acceptanceCriteria: Array<{ text: string; met: boolean }> | undefined;
    if (flags['acceptance-criteria']) {
      acceptanceCriteria = flags['acceptance-criteria']
        .split(';')
        .map(s => s.trim())
        .filter(Boolean)
        .map(text => ({ text, met: false }));
    }

    // Parse scope as JSON
    let scope: { include?: string[]; exclude?: string[] } | undefined;
    if (flags.scope) {
      try {
        scope = JSON.parse(flags.scope);
      } catch {
        this.error('Invalid JSON for --scope flag');
      }
    }

    const response = await client.createTask(
      {
        title: flags.title,
        description: flags.description,
        priority: flags.priority as 'do_now' | 'schedule' | 'delegate' | 'someday' | undefined,
        dueAt: flags.due,
        projectId: flags.project,
        phase: flags.phase,
        effort: flags.effort,
        acceptanceCriteria,
        scope,
      },
      this.idempotencyKey(),
    );
    this.handleApiError(response);

    const task = this.unwrapOne(response, 'task');

    if (!this.jsonEnabled()) {
      this.log(`Planning task created: ${task.id}`);
      this.log(`Create executable agent work with: ${this.config.bin} work create --task ${task.id} --title "${task.title}" --agent <alias>`);
    }

    return response.data;
  }
}

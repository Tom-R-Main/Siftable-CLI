import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

export default class WorkCreate extends BaseCommand {
  static description = 'Create an agent work item';

  static flags = {
    ...BaseCommand.baseFlags,
    title: Flags.string({description: 'Work item title', required: true}),
    prompt: Flags.string({description: 'Agent prompt or instructions'}),
    agent: Flags.string({description: 'Assigned agent alias'}),
    project: Flags.string({description: 'Linked project ID'}),
    task: Flags.string({description: 'Linked human task ID'}),
    rank: Flags.integer({description: 'Queue rank', default: 0}),
    context: Flags.string({description: 'Input context JSON object'}),
    'acceptance-criteria': Flags.string({description: 'Acceptance criteria JSON array or semicolon-separated text'}),
    'allowed-actions': Flags.string({description: 'Allowed actions JSON object'}),
    'write-scope': Flags.string({description: 'Write scope JSON object'}),
    verify: Flags.string({description: 'Verification commands separated by semicolons'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(WorkCreate);
    const client = await this.client(flags);
    const acceptanceCriteria = flags['acceptance-criteria']?.trim().startsWith('[')
      ? this.parseJsonFlag<unknown[]>(flags['acceptance-criteria'], 'acceptance criteria')
      : flags['acceptance-criteria']?.split(';').map((text) => text.trim()).filter(Boolean).map((text) => ({text, met: false}));
    const response = await client.createWorkItem({
      title: flags.title,
      prompt: flags.prompt,
      assignedAlias: flags.agent,
      projectId: flags.project,
      taskId: flags.task,
      queueRank: flags.rank,
      inputContext: this.parseJsonFlag<Record<string, unknown>>(flags.context, 'context'),
      acceptanceCriteria,
      allowedActions: this.parseJsonFlag<Record<string, unknown>>(flags['allowed-actions'], 'allowed actions'),
      writeScope: this.parseJsonFlag<Record<string, unknown>>(flags['write-scope'], 'write scope'),
      verificationCommands: flags.verify?.split(';').map((cmd) => cmd.trim()).filter(Boolean),
    }, this.idempotencyKey());
    this.handleApiError(response);
    const workItem = this.unwrapOne(response, 'workItem');
    if (!this.jsonEnabled()) {
      this.log(`Work item created: ${workItem.id}`);
    }
    return response.data;
  }
}

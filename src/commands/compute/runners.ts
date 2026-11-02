import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {printRunners} from '../../lib/compute-format.js';
import {resolveWorkspaceTenantId} from '../../lib/workspace-context.js';

export default class ComputeRunners extends BaseCommand {
  static description = 'List managed runners advertising a compute profile';

  static flags = {
    ...BaseCommand.baseFlags,
    'work-item': Flags.string({description: 'Check runner eligibility for this work item'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(ComputeRunners);
    const workspaceId = resolveWorkspaceTenantId(flags.workspace) ?? 'personal';
    const query = new URLSearchParams({workspaceId});
    if (flags['work-item']) query.set('workItemId', flags['work-item']);
    const result = await this.apiRequest<{runners?: Record<string, unknown>[] }>(
      {...flags, workspace: workspaceId === 'personal' ? null : workspaceId}, `/api/v1/compute/runners?${query}`);
    const runners = result.runners ?? [];
    if (!this.jsonEnabled()) printRunners(runners);
    return result;
  }
}

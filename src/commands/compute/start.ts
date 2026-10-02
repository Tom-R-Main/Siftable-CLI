import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {resolveWorkspaceTenantId} from '../../lib/workspace-context.js';

export default class ComputeStart extends BaseCommand {
  static description = 'Start the single approved dispatch for a compute grant';

  static args = {
    grantId: Args.string({description: 'Compute grant ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'idempotency-key': Flags.string({description: 'Explicit idempotency key for safe retries'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ComputeStart);
    const workspaceId = resolveWorkspaceTenantId(flags.workspace) ?? 'personal';
    const result = await this.apiRequest<{grant?: {id?: string; state?: string}; dispatch?: {id?: string}}>(
      {...flags, workspace: workspaceId === 'personal' ? null : workspaceId},
      `/api/v1/compute/grants/${encodeURIComponent(args.grantId)}/start`, {
        method: 'POST',
        body: {workspaceId, surface: 'cli'},
        ...(flags['idempotency-key'] ? {idempotencyKey: flags['idempotency-key']} : {}),
      });
    if (!this.jsonEnabled()) {
      this.log(`Compute dispatch started: ${result.dispatch?.id ?? 'unknown'} (grant ${result.grant?.id ?? args.grantId})`);
    }
    return result;
  }
}

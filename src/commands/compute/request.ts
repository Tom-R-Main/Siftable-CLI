import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {resolveWorkspaceTenantId} from '../../lib/workspace-context.js';

/**
 * Requests a task-bound compute grant. Returns the grant and the browser-only
 * approval URL; this command never approves and never waits for approval.
 */
export default class ComputeRequest extends BaseCommand {
  static description = 'Request human authorization to launch managed compute for one work-item revision';

  static args = {
    workItemId: Args.string({description: 'Work item ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    runner: Flags.string({description: 'Runner ID advertising a managed compute profile', required: true}),
    revision: Flags.integer({description: 'Expected work-item revision', required: true}),
    purpose: Flags.string({description: 'Human-readable purpose shown on the approval', required: true}),
    'idempotency-key': Flags.string({description: 'Explicit idempotency key for safe retries'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ComputeRequest);
    const workspaceId = resolveWorkspaceTenantId(flags.workspace) ?? 'personal';
    const result = await this.apiRequest<{grant: unknown; approvalUrl: string}>(
      {...flags, workspace: workspaceId === 'personal' ? null : workspaceId}, '/api/v1/compute/requests', {
      method: 'POST',
      body: {
        workspaceId, workItemId: args.workItemId,
        expectedRevision: flags.revision, runnerId: flags.runner,
        purpose: flags.purpose, surface: 'cli',
      },
      ...(flags['idempotency-key'] ? {idempotencyKey: flags['idempotency-key']} : {}),
    });
    if (!this.jsonEnabled()) {
      this.log(`Approval required (browser only): ${result.approvalUrl}`);
      this.log(`Start after approval: sift compute start ${(result.grant as {id?: string})?.id ?? 'GRANT_ID'} --workspace ${workspaceId}`);
    }
    return result;
  }
}

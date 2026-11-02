import {Args} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {printGrant} from '../../lib/compute-format.js';
import {resolveWorkspaceTenantId} from '../../lib/workspace-context.js';

export default class ComputeGet extends BaseCommand {
  static description = 'Inspect a compute grant, its dispatch, and cleanup state';

  static args = {
    grantId: Args.string({description: 'Compute grant ID', required: true}),
  };

  static flags = BaseCommand.baseFlags;

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(ComputeGet);
    const workspaceId = resolveWorkspaceTenantId(flags.workspace) ?? 'personal';
    const result = await this.apiRequest<Record<string, unknown>>(
      {...flags, workspace: workspaceId === 'personal' ? null : workspaceId},
      `/api/v1/compute/grants/${encodeURIComponent(args.grantId)}?workspaceId=${encodeURIComponent(workspaceId)}`);
    if (!this.jsonEnabled()) {
      printGrant(result, result as {dispatch?: {id?: string; state?: string} | null; execution?: {stopRequested?: boolean; cleanupPending?: boolean; confirmedReleased?: boolean}});
    }
    return result;
  }
}

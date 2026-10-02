import {BaseCommand} from '../../lib/base-command.js';
import {printGrants} from '../../lib/compute-format.js';
import {resolveWorkspaceTenantId} from '../../lib/workspace-context.js';

export default class ComputeList extends BaseCommand {
  static description = 'List this credential\'s compute grants';

  static flags = BaseCommand.baseFlags;

  async run(): Promise<unknown> {
    const {flags} = await this.parse(ComputeList);
    const workspaceId = resolveWorkspaceTenantId(flags.workspace) ?? 'personal';
    const result = await this.apiRequest<{grants?: Record<string, unknown>[] }>(
      {...flags, workspace: workspaceId === 'personal' ? null : workspaceId},
      `/api/v1/compute/grants?workspaceId=${encodeURIComponent(workspaceId)}`);
    const grants = result.grants ?? [];
    if (!this.jsonEnabled()) printGrants(grants);
    return result;
  }
}

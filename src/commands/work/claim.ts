import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {
  describeWorkLeaseSession,
  writeWorkLeaseSession,
  type WorkLeaseSession,
} from '../../lib/work-lease-session.js';
import {resolveWorkspaceTenantId} from '../../lib/workspace-context.js';

export default class WorkClaim extends BaseCommand {
  static description = 'Claim the next available executable agent work item';

  static args = {
    id: Args.string({description: 'Optional specific work item ID', required: false}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    agent: Flags.string({description: 'Agent alias to claim for'}),
    owner: Flags.string({description: 'Claim owner identity', required: true}),
    lease: Flags.integer({description: 'Lease seconds', default: 1800}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkClaim);
    const workspaceId = resolveWorkspaceTenantId(flags.workspace) ?? null;
    const client = await this.client({...flags, workspace: workspaceId});
    const response = await client.claimWorkItem({
      workItemId: args.id,
      assignedAlias: flags.agent,
      claimOwner: flags.owner,
      leaseSeconds: flags.lease,
    }, this.idempotencyKey());
    this.handleApiError(response);
    const workItem = this.unwrapOne(response, 'workItem');
    const workItemId = typeof workItem.id === 'string' ? workItem.id : null;
    const claimToken = typeof workItem.claimToken === 'string' ? workItem.claimToken : null;
    const claimOwner = typeof workItem.claimOwner === 'string' ? workItem.claimOwner : flags.owner;
    if (!workItemId || !claimToken) {
      this.error('The claim succeeded without resumable lease credentials; release the item or let the lease expire before retrying.');
    }
    const session: WorkLeaseSession = {
      version: 1,
      workItemId,
      claimOwner,
      claimToken,
      expiresAt: typeof workItem.claimExpiresAt === 'string' ? workItem.claimExpiresAt : null,
      apiUrl: flags['api-url'],
      workspaceId,
      state: 'active',
      updatedAt: new Date().toISOString(),
    };
    try {
      await writeWorkLeaseSession(session);
    } catch {
      const release = await client.transitionWorkItem(workItemId, 'release', {
        claimOwner,
        claimToken,
      }, {idempotencyKey: this.idempotencyKey()}).catch(() => null);
      this.error(release && !release.error
        ? 'The claim was released because its private local lease session could not be saved.'
        : 'The private local lease session could not be saved and automatic release did not succeed; wait for the lease to expire before reclaiming the item.');
    }
    const {claimToken: _claimToken, ...safeWorkItem} = workItem;
    const safeResponse = {
      ...(response.data && typeof response.data === 'object' ? response.data : {}),
      workItem: safeWorkItem,
      leaseSession: describeWorkLeaseSession(session),
    };
    if (!this.jsonEnabled()) {
      this.log(`Work item claimed: ${workItemId}`);
      this.log(`Next: sift work start ${workItemId}`);
    }
    return safeResponse;
  }
}

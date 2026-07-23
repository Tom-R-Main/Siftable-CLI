import {Args, Flags} from '@oclif/core';
import type {TransitionWorkItemInput} from '@siftable/mcp-server/dist/exfClient.js';
import {BaseCommand} from './base-command.js';

export function redactLifecycleResponse(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const record = data as Record<string, unknown>;
  const workItem = record.workItem;
  if (!workItem || typeof workItem !== 'object' || Array.isArray(workItem)) return data;
  const {claimToken: _claimToken, ...safeWorkItem} = workItem as Record<string, unknown>;
  return {...record, workItem: safeWorkItem};
}

export abstract class WorkActionCommand extends BaseCommand {
  static args = {
    id: Args.string({description: 'Work item ID', required: true}),
  };

  static baseActionFlags = {
    ...BaseCommand.baseFlags,
    owner: Flags.string({description: 'Claim owner identity (required for lease-owned transitions)'}),
    'claim-token': Flags.string({description: 'Claim token returned by work claim (required for lease-owned transitions)'}),
    lease: Flags.integer({description: 'Lease seconds'}),
    summary: Flags.string({description: 'Result summary'}),
    artifacts: Flags.string({description: 'Artifact refs JSON array'}),
    reason: Flags.string({description: 'Block or failure reason'}),
    'verification-results': Flags.string({
      description: 'Verification evidence JSON array: [{"command","exitCode","output"?}]',
    }),
  };

  protected async runWorkAction(command: typeof WorkActionCommand, action: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const {args, flags} = await this.parse(command);
    const ownerBoundActions = new Set(['start', 'heartbeat', 'block', 'review', 'fail']);
    if (ownerBoundActions.has(action) && (!flags.owner || !flags['claim-token'])) {
      this.error(`${action} requires both --owner and --claim-token from the active claim.`);
    }
    if (action === 'release' && (!flags.owner || !flags['claim-token'])) {
      this.error('release requires both --owner and --claim-token from the active claim.');
    }
    if (action === 'cancel' && Boolean(flags.owner) !== Boolean(flags['claim-token'])) {
      this.error('cancel requires --owner and --claim-token together for active work; omit both only for queued/blocked cancellation.');
    }
    const client = await this.client(flags);
    const response = await client.transitionWorkItem(args.id, action, {
      claimOwner: flags.owner,
      claimToken: flags['claim-token'],
      leaseSeconds: flags.lease,
      resultSummary: flags.summary,
      artifactRefs: this.parseJsonFlag<unknown[]>(flags.artifacts, 'artifacts'),
      verificationResults: this.parseJsonFlag<NonNullable<TransitionWorkItemInput['verificationResults']>>(
        flags['verification-results'],
        'verification-results',
      ),
      blockedReason: flags.reason,
      failureReason: flags.reason,
      ...extra,
    });
    this.handleApiError(response);
    const workItem = this.unwrapOne(response, 'workItem');
    if (!this.jsonEnabled()) {
      this.log(`Work item ${action}: ${workItem.id}`);
    }
    return redactLifecycleResponse(response.data);
  }
}

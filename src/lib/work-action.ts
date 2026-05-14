import {Args, Flags} from '@oclif/core';
import {BaseCommand} from './base-command.js';

export abstract class WorkActionCommand extends BaseCommand {
  static args = {
    id: Args.string({description: 'Work item ID', required: true}),
  };

  static baseActionFlags = {
    ...BaseCommand.baseFlags,
    owner: Flags.string({description: 'Claim owner identity'}),
    'claim-token': Flags.string({description: 'Claim token returned by work claim'}),
    lease: Flags.integer({description: 'Lease seconds'}),
    summary: Flags.string({description: 'Result summary'}),
    artifacts: Flags.string({description: 'Artifact refs JSON array'}),
    reason: Flags.string({description: 'Block or failure reason'}),
  };

  protected async runWorkAction(command: typeof WorkActionCommand, action: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const {args, flags} = await this.parse(command);
    const client = await this.client(flags);
    const response = await client.transitionWorkItem(args.id, action, {
      claimOwner: flags.owner,
      claimToken: flags['claim-token'],
      leaseSeconds: flags.lease,
      resultSummary: flags.summary,
      artifactRefs: this.parseJsonFlag<unknown[]>(flags.artifacts, 'artifacts'),
      blockedReason: flags.reason,
      failureReason: flags.reason,
      ...extra,
    });
    this.handleApiError(response);
    const workItem = this.unwrapOne(response, 'workItem');
    if (!this.jsonEnabled()) {
      this.log(`Work item ${action}: ${workItem.id}`);
    }
    return response.data;
  }
}

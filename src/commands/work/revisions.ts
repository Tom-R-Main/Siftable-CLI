import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';

type WorkItemRevision = {
  revision: number;
  previousRevision: number;
  actorType: string;
  actorUserId: string | null;
  reason: string;
  changedFields: string[];
  verificationInvalidated: boolean;
  createdAt: string;
};

export default class WorkRevisions extends BaseCommand {
  static description = 'List immutable, attributable work-item revision receipts and field diffs';

  static args = {
    id: Args.string({description: 'Work item ID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    limit: Flags.integer({description: 'Maximum revisions to return', min: 1, max: 100, default: 50}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkRevisions);
    const result = await this.apiRequest<{revisions: WorkItemRevision[]}>(
      flags,
      `/api/v1/work-items/${args.id}/revisions?limit=${flags.limit}`,
    );
    if (!this.jsonEnabled()) {
      if (result.revisions.length === 0) this.log('No work-item revisions found.');
      for (const revision of result.revisions) {
        this.log(`Revision ${revision.previousRevision} -> ${revision.revision}`);
        this.log(`Actor: ${revision.actorType} ${revision.actorUserId ?? '[anonymized]'}`);
        this.log(`Reason: ${revision.reason}`);
        this.log(`Changed: ${revision.changedFields.join(', ') || 'none'}`);
        this.log(`Verification invalidated: ${revision.verificationInvalidated ? 'yes' : 'no'}`);
        this.log(`Created: ${revision.createdAt}`);
        this.log('');
      }
    }
    return result;
  }
}

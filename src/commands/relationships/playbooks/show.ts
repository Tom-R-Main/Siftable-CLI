import { Args } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';

export default class RelationshipPlaybooksShow extends BaseCommand {
  static description = 'Show one immutable relationship playbook version and latest approval';
  static args = { id: Args.string({ description: 'Playbook version UUID', required: true }) };
  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipPlaybooksShow);
    const response = await this.apiRequest<{ playbook: Record<string, unknown> }>(
      flags, `/api/v1/relationship-playbooks/playbooks/${encodeURIComponent(args.id)}`,
    );
    if (!this.jsonEnabled()) {
      const snapshot = response.playbook.snapshot as Record<string, unknown>;
      const review = response.playbook.latestReview as Record<string, unknown> | null;
      renderDetail([['ID', args.id], ['Name', snapshot.name], ['Version', snapshot.version], ['Approval', review?.decision ?? 'pending']]);
    }
    return response.playbook;
  }
}

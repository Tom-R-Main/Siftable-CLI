import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';
import { readJsonObject } from '../playbooks/_helpers.js';

export default class RelationshipGeneratedAssetsDraft extends BaseCommand {
  static description = 'Create a private communication proposal from an approved outreach asset; does not send';
  static args = { id: Args.string({ description: 'Generated outreach/follow-up asset UUID', required: true }) };
  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({ description: 'Exact destination and idempotency JSON file', required: true }),
    yes: Flags.boolean({ description: 'Confirm proposal creation' }),
  };

  async run(): Promise<unknown> {
    const { args, flags } = await this.parse(RelationshipGeneratedAssetsDraft);
    const input = readJsonObject(flags.file, 'external draft request');
    if (!await this.confirmAction('Create a private external-communication proposal from this approved asset?', flags)) return { cancelled: true };
    const response = await this.apiRequest<{ asset: Record<string, unknown>; action: Record<string, unknown> }>(
      flags,
      `/api/v1/relationship-playbooks/generated-assets/${encodeURIComponent(args.id)}/draft`,
      { method: 'POST', body: input },
    );
    if (!this.jsonEnabled()) renderDetail([
      ['Asset', args.id],
      ['Action', 'relationship.communication.draft'],
      ['State', 'private proposal; separate send approval required'],
    ]);
    return response;
  }
}

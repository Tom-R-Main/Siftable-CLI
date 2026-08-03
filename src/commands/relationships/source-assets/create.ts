import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';
import { readJsonObject } from '../playbooks/_helpers.js';

export default class RelationshipSourceAssetsCreate extends BaseCommand {
  static description = 'Create an immutable, unapproved grounded source-asset version';
  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({ description: 'Source-asset version JSON file', required: true }),
    yes: Flags.boolean({ description: 'Confirm immutable version creation' }),
  };

  async run(): Promise<unknown> {
    const { flags } = await this.parse(RelationshipSourceAssetsCreate);
    const input = readJsonObject(flags.file, 'source asset version');
    if (!await this.confirmAction('Create this immutable source-asset version?', flags)) return { cancelled: true };
    const response = await this.apiRequest<{ sourceAsset: Record<string, unknown> }>(
      flags, '/api/v1/relationship-playbooks/source-assets', { method: 'POST', body: input },
    );
    const snapshot = response.sourceAsset.snapshot as Record<string, unknown>;
    if (!this.jsonEnabled()) renderDetail([['ID', snapshot.sourceAssetVersionId], ['Key', snapshot.stableKey], ['Approval', 'pending']]);
    return response.sourceAsset;
  }
}

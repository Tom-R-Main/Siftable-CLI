import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';
import { readJsonObject } from '../playbooks/_helpers.js';

export default class RelationshipGeneratedAssetsGenerate extends BaseCommand {
  static description = 'Generate a grounded asset from approved exact playbook and source-asset versions';
  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({ description: 'Generation request JSON file', required: true }),
    yes: Flags.boolean({ description: 'Confirm immutable asset generation' }),
  };

  async run(): Promise<unknown> {
    const { flags } = await this.parse(RelationshipGeneratedAssetsGenerate);
    const input = readJsonObject(flags.file, 'generation request');
    if (!await this.confirmAction('Generate this immutable grounded asset?', flags)) return { cancelled: true };
    const response = await this.apiRequest<{ generatedAsset: Record<string, unknown> }>(
      flags, '/api/v1/relationship-playbooks/generated-assets', { method: 'POST', body: input },
    );
    const snapshot = response.generatedAsset.snapshot as Record<string, unknown>;
    if (!this.jsonEnabled()) renderDetail([['Asset', snapshot.generatedAssetId], ['Kind', snapshot.kind], ['Approval', 'pending']]);
    return response.generatedAsset;
  }
}

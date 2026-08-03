import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderDetail } from '../../../lib/output.js';
import { readJsonObject } from '../playbooks/_helpers.js';

export default class RelationshipPlaybookRecommendationsCreate extends BaseCommand {
  static description = 'Record a consequential recommendation with at least three plausible moves';
  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({ description: 'Recommendation JSON file', required: true }),
    yes: Flags.boolean({ description: 'Confirm immutable recommendation creation' }),
  };

  async run(): Promise<unknown> {
    const { flags } = await this.parse(RelationshipPlaybookRecommendationsCreate);
    const input = readJsonObject(flags.file, 'playbook recommendation');
    if (!await this.confirmAction('Record this immutable recommendation and its alternatives?', flags)) return { cancelled: true };
    const response = await this.apiRequest<{ recommendation: Record<string, unknown> }>(
      flags, '/api/v1/relationship-playbooks/recommendations', { method: 'POST', body: input },
    );
    if (!this.jsonEnabled()) renderDetail([
      ['Recommendation', response.recommendation.recommendationId],
      ['Selected move', response.recommendation.selectedMoveId],
      ['Class', response.recommendation.recommendationClass],
    ]);
    return response.recommendation;
  }
}

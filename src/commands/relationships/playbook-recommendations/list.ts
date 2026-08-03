import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../lib/base-command.js';
import { renderTable } from '../../../lib/output.js';
import { queryString } from '../playbooks/_helpers.js';

export default class RelationshipPlaybookRecommendationsList extends BaseCommand {
  static description = 'List recorded relationship playbook recommendations with alternative moves';
  static flags = {
    ...BaseCommand.baseFlags,
    'subject-type': Flags.string({ options: ['prospect', 'opportunity'] }),
    'subject-id': Flags.string(),
    limit: Flags.integer({ min: 1, max: 200 }),
  };

  async run(): Promise<unknown> {
    const { flags } = await this.parse(RelationshipPlaybookRecommendationsList);
    if (Boolean(flags['subject-type']) !== Boolean(flags['subject-id'])) this.error('--subject-type and --subject-id must be provided together');
    const response = await this.apiRequest<{ recommendations: Array<Record<string, unknown>> }>(
      flags,
      `/api/v1/relationship-playbooks/recommendations${queryString({ subjectType: flags['subject-type'], subjectId: flags['subject-id'], limit: flags.limit })}`,
    );
    if (!this.jsonEnabled()) {
      renderTable(response.recommendations.map((item) => ({
        id: item.recommendationId,
        selected: item.selectedMoveId,
        class: item.recommendationClass,
        alternatives: Array.isArray(item.moves) ? item.moves.length : 0,
      })), [
        { key: 'id', header: 'Recommendation' },
        { key: 'selected', header: 'Selected move' },
        { key: 'class', header: 'Class' },
        { key: 'alternatives', header: 'Moves' },
      ]);
    }
    return response.recommendations;
  }
}

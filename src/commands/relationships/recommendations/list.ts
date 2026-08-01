import {Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {parseEntityRef} from '../../../lib/entity-ref.js';
import {renderTable} from '../../../lib/output.js';

export default class RelationshipRecommendationsList extends BaseCommand {
  static description = 'List immutable relationship recommendation snapshots';
  static flags = {
    ...BaseCommand.baseFlags,
    lens: Flags.string({description: 'Relationship lens identifier'}),
    subject: Flags.string({description: 'Filter by prospect:uuid or opportunity:uuid'}),
    limit: Flags.integer({description: 'Maximum recommendations', default: 50}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(RelationshipRecommendationsList);
    const params = new URLSearchParams({limit: String(flags.limit)});
    if (flags.lens) params.set('lens', flags.lens);
    if (flags.subject) {
      const subject = parseEntityRef(flags.subject);
      if (!['prospect', 'opportunity'].includes(subject.entityType)) {
        this.error('Subject must be prospect:uuid or opportunity:uuid.');
      }
      params.set('subjectType', subject.entityType);
      params.set('subjectId', subject.entityId);
    }
    const response = await this.apiRequest<{recommendations: Record<string, unknown>[]}>(
      flags,
      `/api/v1/relationships/recommendations?${params}`,
    );
    if (!this.jsonEnabled()) {
      renderTable(response.recommendations.map((record) => {
        const snapshot = record.snapshot as Record<string, unknown>;
        const subject = snapshot.subject as Record<string, unknown>;
        return {
          id: snapshot.recommendationId,
          subject: `${subject.kind}:${subject.id}`,
          score: snapshot.priorityScore,
          state: record.state,
          executable: snapshot.executable,
        };
      }), [
        {key: 'id', header: 'Recommendation'},
        {key: 'subject', header: 'Subject'},
        {key: 'score', header: 'Score'},
        {key: 'state', header: 'State'},
        {key: 'executable', header: 'Executable'},
      ]);
    }
    return response.recommendations;
  }
}

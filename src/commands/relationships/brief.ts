import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {parseEntityRef} from '../../lib/entity-ref.js';
import {renderDetail, renderTable} from '../../lib/output.js';

export default class RelationshipsBrief extends BaseCommand {
  static description = 'Compose an exact, evidence-grounded relationship brief';
  static args = {
    subject: Args.string({description: 'Subject as prospect:uuid or opportunity:uuid', required: true}),
  };
  static flags = {
    ...BaseCommand.baseFlags,
    lens: Flags.string({description: 'Relationship lens identifier', default: 'relationship'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipsBrief);
    const parsed = parseEntityRef(args.subject);
    if (!['prospect', 'opportunity'].includes(parsed.entityType)) {
      this.error('Subject must be prospect:uuid or opportunity:uuid.');
    }
    const response = await this.apiRequest<{brief: Record<string, unknown>}>(flags, '/api/v1/relationships/brief', {
      method: 'POST',
      body: {lens: flags.lens, subject: {kind: parsed.entityType, id: parsed.entityId}},
    });
    const brief = response.brief;
    if (!this.jsonEnabled()) {
      const recommendations = Array.isArray(brief.recommendations)
        ? brief.recommendations as Record<string, unknown>[]
        : [];
      renderDetail([
        ['Subject', brief.subjectLabel],
        ['Lens', brief.lens],
        ['Citations', Array.isArray(brief.citations) ? brief.citations.length : 0],
        ['Recommendations', recommendations.length],
      ]);
      if (recommendations.length > 0) {
        this.log('');
        renderTable(recommendations, [
          {key: 'recommendationId', header: 'Recommendation'},
          {key: 'priorityScore', header: 'Score'},
          {key: 'executable', header: 'Executable'},
          {key: 'suppressionReasons', header: 'Suppression'},
        ]);
      }
    }
    return brief;
  }
}

import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail, renderTable} from '../../../lib/output.js';

export default class RelationshipRecommendationsShow extends BaseCommand {
  static description = 'Show a relationship recommendation with its exact citations and gates';
  static args = {id: Args.string({description: 'Recommendation UUID', required: true})};
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipRecommendationsShow);
    const response = await this.apiRequest<{recommendation: Record<string, unknown>}>(
      flags,
      `/api/v1/relationships/recommendations/${encodeURIComponent(args.id)}`,
    );
    const recommendation = response.recommendation;
    const snapshot = recommendation.snapshot as Record<string, unknown>;
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Recommendation', snapshot.recommendationId],
        ['State', recommendation.state],
        ['Score', snapshot.priorityScore],
        ['Executable', snapshot.executable],
        ['Source digest', snapshot.sourceDigest],
        ['Ranking version', snapshot.rankingVersion],
        ['Policy version', snapshot.policyVersion],
      ]);
      const gates = Array.isArray(snapshot.gates) ? snapshot.gates as Record<string, unknown>[] : [];
      if (gates.length > 0) {
        this.log('');
        renderTable(gates, [
          {key: 'code', header: 'Gate'},
          {key: 'status', header: 'Status'},
          {key: 'reason', header: 'Reason'},
        ]);
      }
    }
    return recommendation;
  }
}

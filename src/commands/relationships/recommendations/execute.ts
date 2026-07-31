import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail} from '../../../lib/output.js';

export default class RelationshipRecommendationsExecute extends BaseCommand {
  static description = 'Execute an accepted, current recommendation through the canonical action runtime';
  static args = {id: Args.string({description: 'Recommendation UUID', required: true})};
  static flags = {
    ...BaseCommand.baseFlags,
    yes: Flags.boolean({description: 'Confirm canonical action execution'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipRecommendationsExecute);
    const confirmed = await this.confirmAction(`Execute accepted recommendation ${args.id}?`, flags);
    if (!confirmed) return {cancelled: true};
    const result = await this.apiRequest<Record<string, unknown>>(
      flags,
      `/api/v1/relationships/recommendations/${encodeURIComponent(args.id)}/execute`,
      {method: 'POST'},
    );
    if (!this.jsonEnabled()) {
      const recommendation = result.recommendation as Record<string, unknown>;
      const outcome = result.outcome as Record<string, unknown>;
      renderDetail([
        ['Recommendation', args.id],
        ['State', recommendation.state],
        ['Outcome', outcome.status],
      ]);
    }
    return result;
  }
}

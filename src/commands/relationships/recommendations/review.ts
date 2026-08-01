import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';
import {renderDetail} from '../../../lib/output.js';

export default class RelationshipRecommendationsReview extends BaseCommand {
  static description = 'Append an ordinary review decision to a relationship recommendation';
  static args = {id: Args.string({description: 'Recommendation UUID', required: true})};
  static flags = {
    ...BaseCommand.baseFlags,
    decision: Flags.string({
      description: 'Review decision',
      options: ['accepted', 'dismissed', 'snoozed', 'needs_information'],
      required: true,
    }),
    reason: Flags.string({description: 'Review reason'}),
    'snoozed-until': Flags.string({description: 'Offset-aware ISO date-time, required for snoozed'}),
    yes: Flags.boolean({description: 'Confirm the append-only review'}),
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipRecommendationsReview);
    const confirmed = await this.confirmAction(`Append ${flags.decision} review for ${args.id}?`, flags);
    if (!confirmed) return {cancelled: true};
    const response = await this.apiRequest<{recommendation: Record<string, unknown>}>(
      flags,
      `/api/v1/relationships/recommendations/${encodeURIComponent(args.id)}/reviews`,
      {
        method: 'POST',
        body: {
          decision: flags.decision,
          reason: flags.reason,
          snoozedUntil: flags['snoozed-until'],
        },
      },
    );
    if (!this.jsonEnabled()) {
      renderDetail([
        ['Recommendation', args.id],
        ['State', response.recommendation.state],
        ['Decision', flags.decision],
      ]);
    }
    return response.recommendation;
  }
}

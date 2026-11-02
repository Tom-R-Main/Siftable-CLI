import {Args} from '@oclif/core';
import {BaseCommand} from '../../../../lib/base-command.js';

const RELATIONSHIP_MEETINGS_API = '/api/v1/relationship-meetings';

export default class RelationshipMeetingsProposalsShow extends BaseCommand {
  static description = 'Inspect a meeting-derived relationship proposal, evidence, diffs, and recovery plan';

  static args = {
    id: Args.string({description: 'Meeting proposal UUID', required: true}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipMeetingsProposalsShow);
    const response = await this.apiRequest<{proposal: Record<string, unknown>}>(
      flags,
      `${RELATIONSHIP_MEETINGS_API}/proposals/${encodeURIComponent(args.id)}`,
    );
    if (!this.jsonEnabled()) this.log(JSON.stringify(response.proposal, null, 2));
    return response.proposal;
  }
}

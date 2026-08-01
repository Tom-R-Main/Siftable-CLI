import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class RelationshipsHandoffsShow extends BaseCommand {
  static description = 'Show one immutable relationship outcome handoff receipt';
  static args = {
    id: Args.string({description: 'Outcome handoff receipt UUID', required: true}),
  };
  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipsHandoffsShow);
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(args.id)) this.error('Handoff id must be a UUID.');
    const response = await this.apiRequest<{handoff: Record<string, unknown>}>(
      flags,
      `/api/v1/ontology/relationship-handoffs/${args.id}`,
    );
    if (!this.jsonEnabled()) this.log(JSON.stringify(response.handoff, null, 2));
    return response.handoff;
  }
}

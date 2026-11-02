import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class RelationshipActionsShow extends BaseCommand {
  static description = 'Show one registered relationship action';

  static args = {
    id: Args.string({description: 'Relationship action ID', required: true}),
  };

  static flags = {...BaseCommand.baseFlags};

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(RelationshipActionsShow);
    const client = await this.client(flags);
    const response = await client.getRelationshipAction(args.id);
    this.handleApiError(response);
    const action = this.unwrapOne(response, 'action');
    if (!this.jsonEnabled()) this.log(JSON.stringify(action, null, 2));
    return action;
  }
}

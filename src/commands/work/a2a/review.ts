import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class WorkA2aReview extends BaseCommand {
  static description = 'Inspect scoped A2A dispatch history, artifacts and verification';
  static args = {id: Args.string({required: true, description: 'Local work item ID'})};
  static flags = {...BaseCommand.baseFlags};
  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkA2aReview);
    const result = await this.apiRequest(flags, `/api/v1/work-items/${encodeURIComponent(args.id)}/a2a/review`);
    if (!this.jsonEnabled()) this.log(JSON.stringify(result, null, 2));
    return result;
  }
}

import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class WorkA2aRecover extends BaseCommand {
  static description = 'Recover an addressed blocked dispatch after repairing authority';
  static args = {connection: Args.string({required: true, description: 'A2A connection ID'}), dispatch: Args.string({required: true, description: 'Outbound dispatch ID'})};
  static flags = {...BaseCommand.baseFlags,
    generation: Flags.integer({required: true, min: 0, description: 'Observed dispatch generation'}),
  };
  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkA2aRecover);
    const result = await this.apiRequest(flags, `/api/v1/a2a-connections/${encodeURIComponent(args.connection)}/dispatches/${encodeURIComponent(args.dispatch)}/recover`, {method: 'POST', body: {generation: flags.generation}});
    if (!this.jsonEnabled()) this.log(JSON.stringify(result, null, 2));
    return result;
  }
}

import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class WorkA2aContinue extends BaseCommand {
  static description = 'Send one explicit clarification to a waiting A2A conversation';
  static args = {connection: Args.string({required: true}), dispatch: Args.string({required: true})};
  static flags = {...BaseCommand.baseFlags,
    text: Flags.string({required: true}),
    'request-key': Flags.string({required: true, description: 'Stable key to reuse when retrying this operation'}),
  };
  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkA2aContinue);
    const result = await this.apiRequest(flags, `/api/v1/a2a-connections/${encodeURIComponent(args.connection)}/dispatches/${encodeURIComponent(args.dispatch)}/messages`, {method: 'POST', body: {text: flags.text}, idempotencyKey: flags['request-key']});
    if (!this.jsonEnabled()) this.log(JSON.stringify(result, null, 2));
    return result;
  }
}

import {Args} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class WorkA2aCancel extends BaseCommand {
  static description = 'Cancel the remote conversation; worker termination remains unconfirmed';
  static args = {connection: Args.string({required: true}), dispatch: Args.string({required: true})};
  static flags = {...BaseCommand.baseFlags,

  };
  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkA2aCancel);
    const result = await this.apiRequest(flags, `/api/v1/a2a-connections/${encodeURIComponent(args.connection)}/dispatches/${encodeURIComponent(args.dispatch)}/cancel`, {method: 'POST'});
    if (!this.jsonEnabled()) this.log(JSON.stringify(result, null, 2));
    return result;
  }
}

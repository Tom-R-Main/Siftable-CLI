import {Args, Flags} from '@oclif/core';
import {BaseCommand} from '../../../lib/base-command.js';

export default class WorkA2aSend extends BaseCommand {
  static description = 'Send one bounded assignment to an explicit A2A connection and remote work item';
  static args = {connection: Args.string({required: true}), work: Args.string({required: true})};
  static flags = {
    ...BaseCommand.baseFlags,
    text: Flags.string({required: true}),
    'remote-work': Flags.string({required: true}),
    'remote-workspace': Flags.string({description: 'Remote workspace UUID; omit for personal scope'}),
    'max-turns': Flags.integer({default: 8, min: 1, max: 32}),
    deadline: Flags.string({required: true, description: 'Absolute ISO deadline for this conversation'}),
    'request-key': Flags.string({required: true, description: 'Stable key to reuse when retrying this assignment'}),
  };
  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(WorkA2aSend);
    const result = await this.apiRequest(flags, `/api/v1/a2a-connections/${encodeURIComponent(args.connection)}/dispatches`, {
      method: 'POST', idempotencyKey: flags['request-key'],
      body: {workItemId: args.work, text: flags.text,
        remoteTarget: {workItemId: flags['remote-work'], workspaceId: flags['remote-workspace'] ?? null},
        bounds: {maxTurns: flags['max-turns'], deadline: flags.deadline}},
    });
    if (!this.jsonEnabled()) this.log(JSON.stringify(result, null, 2));
    return result;
  }
}

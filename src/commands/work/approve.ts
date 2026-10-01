import {Args} from '@oclif/core';
import {type WorkDecisionOutput, WorkRuntimeCommand} from '../../lib/work-runtime-command.js';

export default class WorkApprove extends WorkRuntimeCommand {
  static description = 'Decide an approval a running agent is waiting on. Opens the web app, where you decide with your signed-in session, then waits for the stored outcome.';

  static examples = [
    '<%= config.bin %> work approve <work-item-id>',
    '<%= config.bin %> work approve <work-item-id> <request-id> --no-browser --json',
  ];

  static args = {
    id: Args.string({description: 'Work item UUID', required: true}),
    requestId: Args.string({description: 'Runtime request UUID (default: the only open approval)'}),
  };

  static flags = {
    ...WorkRuntimeCommand.baseFlags,
    ...WorkRuntimeCommand.decisionFlags,
  };

  async run(): Promise<WorkDecisionOutput | undefined> {
    const {args, flags} = await this.parse(WorkApprove);
    return this.decideInBrowser('approval', args.id, args.requestId, flags);
  }
}

import {Args} from '@oclif/core';
import {type WorkDecisionOutput, WorkRuntimeCommand} from '../../lib/work-runtime-command.js';

export default class WorkAnswer extends WorkRuntimeCommand {
  static description = 'Answer a question a running agent asked. Opens the web app, where you answer with your signed-in session, then waits for the stored outcome.';

  static examples = [
    '<%= config.bin %> work answer <work-item-id>',
    '<%= config.bin %> work answer <work-item-id> <request-id> --no-browser --json',
  ];

  static args = {
    id: Args.string({description: 'Work item UUID', required: true}),
    requestId: Args.string({description: 'Runtime request UUID (default: the only open question)'}),
  };

  static flags = {
    ...WorkRuntimeCommand.baseFlags,
    ...WorkRuntimeCommand.decisionFlags,
  };

  async run(): Promise<WorkDecisionOutput | undefined> {
    const {args, flags} = await this.parse(WorkAnswer);
    this.renderOptions = {fullDetail: flags['full-detail']};
    return this.decideInBrowser('user_input', args.id, args.requestId, flags);
  }
}

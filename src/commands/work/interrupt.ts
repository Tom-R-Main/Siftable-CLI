import {Args} from '@oclif/core';
import {type WorkControlOutput, type WorkControlUnconfirmedOutput, WorkRuntimeCommand} from '../../lib/work-runtime-command.js';

export default class WorkInterrupt extends WorkRuntimeCommand {
  static description = 'Interrupt the current turn of a running work item; the session stays open for further instructions';

  static examples = [
    '<%= config.bin %> work interrupt <work-item-id>',
    '<%= config.bin %> work interrupt <work-item-id> --wait --json',
  ];

  static args = {
    id: Args.string({description: 'Work item UUID', required: true}),
  };

  static flags = {
    ...WorkRuntimeCommand.baseFlags,
    ...WorkRuntimeCommand.controlFlags,
  };

  async run(): Promise<WorkControlOutput | WorkControlUnconfirmedOutput> {
    const {args, flags} = await this.parse(WorkInterrupt);
    return this.sendControl(args.id, {kind: 'interrupt'}, flags);
  }
}

import {Args, Flags} from '@oclif/core';
import {WorkRuntimeCommand} from '../../lib/work-runtime-command.js';

export default class WorkWatch extends WorkRuntimeCommand {
  static description = 'Follow a running work item: ledger events, the execution attempt, runtime requests and controls. Read-only.';

  static examples = [
    '<%= config.bin %> work watch <work-item-id>',
    '<%= config.bin %> work watch <work-item-id> --backlog 20 --timeout 600',
    '<%= config.bin %> work watch <work-item-id> --json   # JSON Lines: snapshot, event, attempt, request, control, end',
  ];

  static args = {
    id: Args.string({description: 'Work item UUID', required: true}),
  };

  static flags = {
    ...WorkRuntimeCommand.baseFlags,
    ...WorkRuntimeCommand.watchFlags,
    backlog: Flags.integer({description: 'Replay this many ledger events before the current end', min: 0, max: 500, default: 0}),
  };

  async run(): Promise<void> {
    const {args, flags} = await this.parse(WorkWatch);
    await this.follow(this.runtimeApi(flags), args.id, flags, flags.backlog);
  }
}

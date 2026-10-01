import * as readline from 'node:readline';
import {Args, Flags} from '@oclif/core';
import {WorkRuntimeCommand} from '../../lib/work-runtime-command.js';
import {
  ControlInputQueue,
  RUNTIME_INSTRUCTION_MAX_CHARS,
  submitAttachControl,
  type WorkItemFollower,
  type WorkRuntimeApi,
} from '../../lib/work-runtime.js';

export default class WorkAttach extends WorkRuntimeCommand {
  static description = 'Attach to a running work item: show its state and recent ledger, follow it, and (on a terminal) send typed lines as instructions';

  static examples = [
    '<%= config.bin %> work attach <work-item-id>',
    '<%= config.bin %> work attach <work-item-id> --no-input --json',
  ];

  static args = {
    id: Args.string({description: 'Work item UUID', required: true}),
  };

  static flags = {
    ...WorkRuntimeCommand.baseFlags,
    ...WorkRuntimeCommand.watchFlags,
    backlog: Flags.integer({description: 'Replay this many ledger events before the current end', min: 0, max: 500, default: 20}),
  };

  async run(): Promise<void> {
    const {args, flags} = await this.parse(WorkAttach);
    const api = this.runtimeApi(flags);
    const interactive = Boolean(process.stdin.isTTY) && !flags['no-input'] && !flags.once;
    let input: readline.Interface | undefined;
    let follower: WorkItemFollower | undefined;
    let stop: () => void = () => undefined;
    // Lines are sent one at a time in input order; the follower waits for the
    // queue before writing its end record, on /quit, EOF or attempt end.
    const queue = new ControlInputQueue(async line => {
      if (follower) await this.handleLine(api, args.id, line, follower, stop);
    });
    try {
      await this.follow(api, args.id, flags, flags.backlog, (current, _signal, stopFollowing) => {
        follower = current;
        stop = stopFollowing;
        if (!interactive) return;
        if (!this.jsonEnabled()) {
          console.log('Type an instruction and press Enter to queue it. /interrupt stops the current turn; /quit detaches.');
        }
        input = readline.createInterface({input: process.stdin, terminal: false});
        input.on('line', line => queue.submit(line));
        input.on('close', () => {
          // Lines read before EOF are already queued; detach after they are sent.
          void queue.idle().then(stopFollowing);
        });
      }, () => queue.close());
    } finally {
      input?.close();
    }
  }

  private async handleLine(
    api: WorkRuntimeApi,
    workItemId: string,
    line: string,
    follower: WorkItemFollower,
    stop: () => void,
  ): Promise<void> {
    const text = line.trim();
    if (!text) return;
    if (text === '/quit' || text === '/detach') {
      stop();
      return;
    }
    const input = text === '/interrupt'
      ? {kind: 'interrupt' as const}
      : {kind: 'instruction' as const, instruction: text};
    if (input.kind === 'instruction' && input.instruction.length > RUNTIME_INSTRUCTION_MAX_CHARS) {
      console.error(`Instruction is longer than ${RUNTIME_INSTRUCTION_MAX_CHARS} characters; not sent.`);
      return;
    }
    try {
      const outcome = await submitAttachControl(api, workItemId, input, follower);
      if (outcome.status === 'not_sent') {
        console.error('The watch has stopped; this line was not sent.');
      } else if (outcome.status === 'refused') {
        console.error(`Control was not accepted (HTTP ${outcome.httpStatus}).`);
      } else {
        if (outcome.record.type === 'control') follower.noteControl(outcome.record.control);
        this.emitRecord(outcome.record);
      }
    } catch (error) {
      console.error(`Control was not sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

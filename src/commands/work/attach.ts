import * as readline from 'node:readline';
import {Args, Flags} from '@oclif/core';
import {WorkRuntimeCommand} from '../../lib/work-runtime-command.js';
import {
  RUNTIME_INSTRUCTION_MAX_CHARS,
  type WorkItemFollower,
  type WorkRuntimeApi,
  isAbortError,
  newControlIdempotencyKey,
  sendControlWithRetry,
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
    try {
      await this.follow(api, args.id, flags, flags.backlog, (follower, signal, stop) => {
        if (!interactive) return;
        if (!this.jsonEnabled()) {
          console.log('Type an instruction and press Enter to queue it. /interrupt stops the current turn; /quit detaches.');
        }
        input = readline.createInterface({input: process.stdin, terminal: false});
        input.on('line', line => {
          void this.handleLine(api, args.id, line, follower, signal, stop);
        });
        input.on('close', stop);
      });
    } finally {
      input?.close();
    }
  }

  private async handleLine(
    api: WorkRuntimeApi,
    workItemId: string,
    line: string,
    follower: WorkItemFollower,
    signal: AbortSignal,
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
      const {result} = await sendControlWithRetry(api, workItemId, input, {
        idempotencyKey: newControlIdempotencyKey(input.kind),
        retries: 2,
        retryDelayMs: 500,
        signal,
      });
      if (!result.ok) {
        console.error(`Control was not accepted (HTTP ${result.status}).`);
        return;
      }
      follower.noteControl(result.body.control);
      this.emitRecord({version: 1, type: 'control', control: result.body.control});
    } catch (error) {
      if (!isAbortError(error)) console.error(`Control was not sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

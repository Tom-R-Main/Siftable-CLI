import {readFileSync} from 'node:fs';
import {Args} from '@oclif/core';
import {type WorkControlOutput, type WorkControlUnconfirmedOutput, WorkRuntimeCommand} from '../../lib/work-runtime-command.js';
import {RUNTIME_INSTRUCTION_MAX_CHARS} from '../../lib/work-runtime.js';

export default class WorkSend extends WorkRuntimeCommand {
  static description = 'Queue a follow-up instruction for a running work item; it runs as the next turn after the current turn settles';

  static examples = [
    '<%= config.bin %> work send <work-item-id> "Also update the README"',
    'echo "Run the full test suite" | <%= config.bin %> work send <work-item-id> -',
    '<%= config.bin %> work send <work-item-id> "Stop after the migration" --wait --json',
  ];

  static args = {
    id: Args.string({description: 'Work item UUID', required: true}),
    instruction: Args.string({description: 'Instruction text, or - to read it from stdin', required: true}),
  };

  static flags = {
    ...WorkRuntimeCommand.baseFlags,
    ...WorkRuntimeCommand.controlFlags,
  };

  async run(): Promise<WorkControlOutput | WorkControlUnconfirmedOutput> {
    const {args, flags} = await this.parse(WorkSend);
    const instruction = args.instruction === '-' ? readFileSync(0, 'utf8').trim() : args.instruction;
    if (!instruction.trim()) this.error('Instruction must not be empty.');
    if (instruction.length > RUNTIME_INSTRUCTION_MAX_CHARS) {
      this.error(`Instruction must be at most ${RUNTIME_INSTRUCTION_MAX_CHARS} characters.`);
    }
    return this.sendControl(args.id, {kind: 'instruction', instruction}, flags);
  }
}

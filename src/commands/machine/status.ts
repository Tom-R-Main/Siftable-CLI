import {BaseCommand} from '../../lib/base-command.js';
import {describeMachineState} from '../../lib/supervisor/machineStatus.js';
import {SUPERVISOR_STATE_DIR} from '../../lib/supervisor/machineState.js';

export default class MachineStatus extends BaseCommand {
  static description = 'Show this machine\'s supervisor enrollment (run as root; never prints the credential)';

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    await this.parse(MachineStatus);
    if (process.platform !== 'linux') this.error('Machine enrollment runs on Linux only.');
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) this.error('Run this as root (sudo); the supervisor state is readable only by its account and root.');
    const status = await describeMachineState(SUPERVISOR_STATE_DIR);
    if (!this.jsonEnabled()) for (const line of status.lines) this.log(line);
    return status.summary;
  }
}

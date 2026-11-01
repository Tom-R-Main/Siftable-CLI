import {Flags} from '@oclif/core';
import {BaseCommand} from '../../lib/base-command.js';
import {hostedKeygen} from '../../lib/supervisor/hostedEnroll.js';
import {MachineEnrollError} from '../../lib/supervisor/machineEnroll.js';
import {MachineStateError, SUPERVISOR_STATE_DIR} from '../../lib/supervisor/machineState.js';
import {ensureSupervisorAccount} from '../../lib/supervisor/systemAccount.js';

export default class MachineKeygen extends BaseCommand {
  static description = 'Create (or load) this hosted machine\'s key and print its public key (run as root by the Siftable controller)';

  static examples = ['sudo sift machine keygen --hosted <hosted-machine-id>'];

  static flags = {
    ...BaseCommand.baseFlags,
    hosted: Flags.string({required: true, description: 'The hosted machine id this instance was started for'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(MachineKeygen);
    if (process.platform !== 'linux') this.error('Hosted machine keys are made on the Linux instance only.');
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) this.error('Run this as root (sudo).');
    const account = await ensureSupervisorAccount();
    try {
      const key = await hostedKeygen({root: SUPERVISOR_STATE_DIR, owner: {uid: account.uid, gid: account.gid}}, flags.hosted);
      // Only the public key is printed: the controller reads it over SSM and binds it on the server.
      if (!this.jsonEnabled()) this.log(key.publicKey);
      return key;
    } catch (error) {
      if (error instanceof MachineEnrollError || error instanceof MachineStateError) this.error(error.message);
      throw error;
    }
  }
}

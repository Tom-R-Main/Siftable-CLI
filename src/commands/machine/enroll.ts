import {Flags} from '@oclif/core';
import {arch, hostname, platform} from 'node:os';
import {BaseCommand, DEFAULT_API_URL} from '../../lib/base-command.js';
import {enrollMachine, MachineEnrollError} from '../../lib/supervisor/machineEnroll.js';
import {machineHostLabels, parseMachineScope} from '../../lib/supervisor/machineProtocol.js';
import {MachineStateError, SUPERVISOR_STATE_DIR} from '../../lib/supervisor/machineState.js';
import {ensureSupervisorAccount} from '../../lib/supervisor/systemAccount.js';

export default class MachineEnroll extends BaseCommand {
  static description = 'Enroll this Linux machine as a contained supervisor (run as root)';

  static examples = [
    'sudo sift machine enroll',
    'sudo sift machine enroll --workspace 3f2c… --setup <setup-id>',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    workspace: Flags.string({default: 'personal', description: 'personal, or the workspace UUID to run work for'}),
    setup: Flags.string({description: 'Setup session this machine is enrolled for (recorded locally; prints the command that links it)'}),
    replace: Flags.boolean({default: false, description: 'Revoke and retire this machine\'s current enrollment, then enroll again'}),
    'abandon-runner': Flags.string({
      dependsOn: ['replace'],
      description: 'With --replace: the runner you revoked in the browser, when the old state cannot revoke itself',
    }),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(MachineEnroll);
    if (process.platform !== 'linux') {
      this.error('Machine enrollment runs on Linux only. On a Mac, use a Linux VM in your own cloud account and enroll that VM.');
    }
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
      this.error('Run this as root (sudo). It creates the siftable-supervisor account, which holds the credential instead of your home directory.');
    }
    let scope;
    try {
      scope = parseMachineScope(flags.workspace);
    } catch (error) {
      this.error((error as Error).message);
    }
    const apiUrl = (flags['api-url'] || process.env.SIFT_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
    const account = await ensureSupervisorAccount();
    if (!this.jsonEnabled() && account.created) this.log('Created the siftable-supervisor system account.');
    try {
      const result = await enrollMachine({
        fetch: globalThis.fetch,
        state: {root: SUPERVISOR_STATE_DIR, owner: {uid: account.uid, gid: account.gid}},
        now: () => new Date(),
        sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        log: (line) => (this.jsonEnabled() ? process.stderr.write(`${line}\n`) : this.log(line)),
      }, {
        apiUrl, scope, replace: flags.replace, ...(flags.setup ? {setupId: flags.setup} : {}),
        ...(flags['abandon-runner'] ? {abandonRunner: flags['abandon-runner']} : {}),
        host: machineHostLabels({hostname: hostname(), os: platform(), arch: arch(), agentVersion: this.config.version}),
      });
      if (!this.jsonEnabled()) {
        this.log(`Enrolled. Enrollment ${result.enrollmentId}, runner ${result.runnerId}.`);
        this.log('The machine is not qualified yet, so it cannot run work or call models until it qualifies.');
        if (!account.dockerGroup) this.log('Docker is not installed (no docker group); install it before qualifying.');
        // The plan is changed with the person's own credential, never the machine's, so this runs without sudo.
        if (flags.setup) this.log(`Link it to your setup as yourself, without sudo: sift setup link-machine ${flags.setup} --runner ${result.runnerId}`);
      }
      return {...result, dockerGroup: account.dockerGroup,
        ...(flags.setup ? {next: `sift setup link-machine ${flags.setup} --runner ${result.runnerId}`} : {})};
    } catch (error) {
      if (error instanceof MachineEnrollError || error instanceof MachineStateError) this.error(error.message);
      throw error;
    }
  }
}

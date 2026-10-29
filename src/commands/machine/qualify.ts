import {Flags} from '@oclif/core';
import {execFile, spawn} from 'node:child_process';
import {BaseCommand} from '../../lib/base-command.js';
import {
  type Attach,
  type Docker,
  MachineQualifyError,
  qualifyMachine,
  readProcCgroup,
  shippedAssets,
} from '../../lib/supervisor/machineQualify.js';
import {MachineStateError, SUPERVISOR_STATE_DIR} from '../../lib/supervisor/machineState.js';
import {ensureSupervisorAccount} from '../../lib/supervisor/systemAccount.js';

const DOCKER_ENV = {PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DOCKER_CONFIG: '/dev/null'};

const docker: Docker = (args) => new Promise((resolve) => {
  execFile('docker', args, {env: DOCKER_ENV, timeout: 120_000, maxBuffer: 16 * 1024 * 1024}, (error, stdout, stderr) => {
    const code = error ? (typeof (error as {code?: unknown}).code === 'number' ? (error as {code: number}).code : 1) : 0;
    resolve({code, stdout: String(stdout), stderr: String(stderr)});
  });
});

const attach: Attach = (args) => {
  const child = spawn('docker', args, {env: DOCKER_ENV, stdio: ['pipe', 'pipe', 'ignore']});
  return {
    stdin: child.stdin, stdout: child.stdout,
    exited: new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 1))),
    kill: () => { child.kill('SIGTERM'); },
  };
};

export default class MachineQualify extends BaseCommand {
  static description = 'Qualify this enrolled machine: run the isolation probes in the pinned agent image and report them (run as root)';

  static flags = {
    ...BaseCommand.baseFlags,
    'start-over': Flags.boolean({default: false, description: 'Retire a report the server refused, keeping it under retired/, and qualify again'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(MachineQualify);
    if (process.platform !== 'linux') this.error('Machine qualification runs on Linux only.');
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) this.error('Run this as root (sudo); it reads the supervisor\'s key and starts containers.');
    const account = await ensureSupervisorAccount();
    try {
      const result = await qualifyMachine({
        fetch: globalThis.fetch, docker, attach,
        state: {root: SUPERVISOR_STATE_DIR, owner: {uid: account.uid, gid: account.gid}},
        now: () => new Date(),
        log: (line) => (this.jsonEnabled() ? process.stderr.write(`${line}\n`) : this.log(line)),
        readHostCgroup: readProcCgroup,
        assets: shippedAssets(),
      }, {startOver: flags['start-over']});
      if (!this.jsonEnabled()) {
        if (result.outcome === 'qualified') this.log('Qualified. This machine can now run work.');
        else this.log(`Not qualified: ${result.failures.join(', ') || 'the server refused the report'}.`);
        if (result.problems.length > 0) this.log(`Findings: ${result.problems.join(', ')}.`);
        if (result.held.length > 0) this.log(`Could not remove: ${result.held.join(', ')}. The next run retries before qualifying again.`);
      }
      return result;
    } catch (error) {
      if (error instanceof MachineQualifyError || error instanceof MachineStateError) this.error(error.message);
      throw error;
    }
  }
}

import {Args} from '@oclif/core';
import {execFile} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {BaseCommand} from '../../lib/base-command.js';
import {SERVICE_NAME, servicePath, ServicePathError, serviceUnit, UNIT_PATH} from '../../lib/supervisor/supervisorService.js';

const systemctl = (...args: string[]) => new Promise<void>((resolve, reject) => {
  execFile('systemctl', args, {env: {PATH: '/usr/sbin:/usr/bin:/sbin:/bin'}, timeout: 60_000}, (error, _stdout, stderr) => {
    if (error) reject(new Error(`systemctl ${args.join(' ')} failed: ${String(stderr).trim() || error.message}`));
    else resolve();
  });
});

export default class MachineService extends BaseCommand {
  static description = 'Install or remove the systemd service that runs the supervisor (run as root)';

  static args = {
    action: Args.string({required: true, options: ['install', 'uninstall'], description: 'install writes, enables and starts the unit; uninstall stops, disables and removes it'}),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<unknown> {
    const {args} = await this.parse(MachineService);
    if (process.platform !== 'linux') this.error('The supervisor service runs on Linux only.');
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) this.error('Run this as root (sudo); it writes a systemd unit.');
    if (args.action === 'uninstall') {
      await systemctl('disable', '--now', SERVICE_NAME).catch((error: Error) => this.warn(error.message));
      await fs.rm(UNIT_PATH, {force: true});
      await systemctl('daemon-reload');
      this.log(`Removed ${SERVICE_NAME}. Any attempt it left is torn down the next time the supervisor runs.`);
      return {action: 'uninstall', unit: UNIT_PATH};
    }
    let paths: {node: string; cli: string};
    try {
      paths = {node: servicePath(process.execPath, 'The node binary'), cli: servicePath(path.resolve(__dirname, '../../../bin/run.js'), 'The sift CLI')};
    } catch (error) {
      if (error instanceof ServicePathError) this.error(error.message);
      throw error;
    }
    await fs.writeFile(UNIT_PATH, serviceUnit(paths), {mode: 0o644});
    await systemctl('daemon-reload');
    await systemctl('enable', '--now', SERVICE_NAME);
    this.log(`Installed and started ${SERVICE_NAME} (${paths.node} ${paths.cli}). Logs: journalctl -u ${SERVICE_NAME}`);
    return {action: 'install', unit: UNIT_PATH, ...paths};
  }
}

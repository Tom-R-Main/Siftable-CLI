/**
 * The siftable-supervisor system account (first-run U2c). The supervisor is
 * the trusted component: it holds the credential and the enrollment key, and
 * it starts agent containers, so v1 adds it to the docker group (host-root
 * equivalent). Agents never run as this account and never see its socket,
 * key or credential.
 */
import {execFile} from 'node:child_process';
import {SUPERVISOR_STATE_DIR} from './machineState.js';

export const SUPERVISOR_ACCOUNT = 'siftable-supervisor';

export type Exec = (file: string, args: string[]) => Promise<{code: number; stdout: string; stderr: string}>;

/** Runs a system tool by absolute path with a fixed PATH and no shell. */
export const execSystemTool: Exec = (file, args) => new Promise((resolve) => {
  execFile(file, args, {env: {PATH: '/usr/sbin:/usr/bin:/sbin:/bin'}, timeout: 30_000}, (error, stdout, stderr) => {
    const code = error ? (typeof (error as {code?: unknown}).code === 'number' ? (error as {code: number}).code : 1) : 0;
    resolve({code, stdout: String(stdout), stderr: String(stderr)});
  });
});

export interface SupervisorAccount {
  uid: number;
  gid: number;
  created: boolean;
  dockerGroup: boolean;
}

async function must(exec: Exec, file: string, args: string[]): Promise<string> {
  const result = await exec(file, args);
  if (result.code !== 0) throw new Error(`${file} ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result.stdout;
}

export async function ensureSupervisorAccount(exec: Exec = execSystemTool): Promise<SupervisorAccount> {
  const existing = await exec('/usr/bin/getent', ['passwd', SUPERVISOR_ACCOUNT]);
  const created = existing.code !== 0;
  if (created) {
    await must(exec, '/usr/sbin/useradd', [
      '--system', '--user-group', '--home-dir', SUPERVISOR_STATE_DIR, '--no-create-home',
      '--shell', '/usr/sbin/nologin', SUPERVISOR_ACCOUNT,
    ]);
  }
  const docker = await exec('/usr/bin/getent', ['group', 'docker']);
  let dockerGroup = false;
  if (docker.code === 0) {
    const groups = (await must(exec, '/usr/bin/id', ['-nG', SUPERVISOR_ACCOUNT])).trim().split(/\s+/);
    if (!groups.includes('docker')) await must(exec, '/usr/sbin/usermod', ['-aG', 'docker', SUPERVISOR_ACCOUNT]);
    dockerGroup = true;
  }
  const uid = Number((await must(exec, '/usr/bin/id', ['-u', SUPERVISOR_ACCOUNT])).trim());
  const gid = Number((await must(exec, '/usr/bin/id', ['-g', SUPERVISOR_ACCOUNT])).trim());
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0) throw new Error('The supervisor account has an unexpected uid or gid');
  return {uid, gid, created, dockerGroup};
}

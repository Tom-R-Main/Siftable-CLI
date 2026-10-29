/**
 * The systemd unit that runs `sift machine supervise` (first-run U2d-2).
 * ProtectHome hides /home and /root from the service, so the node binary and
 * the CLI must be installed outside them; no PATH or nvm lookup happens at
 * start. The unit runs as root because Docker access is root-equivalent; the
 * hardening options keep the service itself away from homes and shared /tmp.
 */
import {realpathSync} from 'node:fs';
import path from 'node:path';

export const SERVICE_NAME = 'siftable-supervisor.service';
export const UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}`;
export const INPUT_ROOT = '/run/siftable-attempts';

export class ServicePathError extends Error {}

/** Absolute, resolved, and outside any home directory, or refused. */
export function servicePath(candidate: string, what: string, resolve: (file: string) => string = realpathSync): string {
  if (!path.isAbsolute(candidate)) throw new ServicePathError(`${what} must be an absolute path (got ${candidate}).`);
  const resolved = resolve(candidate);
  if (/^\/(home|root)(\/|$)/.test(resolved) || /^\/(home|root)(\/|$)/.test(candidate)) {
    throw new ServicePathError(`${what} resolves to ${resolved}, inside a home directory the service cannot see. Install node and the CLI system-wide (for example under /usr/local or /opt/siftable).`);
  }
  if (/\s/.test(resolved)) throw new ServicePathError(`${what} contains whitespace: ${resolved}`);
  return resolved;
}

export function serviceUnit(paths: {node: string; cli: string}): string {
  return [
    '[Unit]',
    'Description=Siftable contained supervisor',
    'After=docker.service network-online.target',
    'Requires=docker.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${paths.node} ${paths.cli} machine supervise`,
    'Restart=on-failure',
    'RestartSec=10',
    'Slice=siftable.slice',
    'ProtectHome=yes',
    'PrivateTmp=yes',
    'NoNewPrivileges=yes',
    `RuntimeDirectory=${path.basename(INPUT_ROOT)}`,
    'RuntimeDirectoryMode=0755',
    // Stopping ends the docker attach clients too. Attempt containers live in the Docker daemon;
    // the next start tears them down from the journal and never relaunches them.
    'KillMode=mixed',
    'TimeoutStopSec=30',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

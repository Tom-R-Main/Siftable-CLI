import {spawn} from 'node:child_process';
import {constants as fsConstants} from 'node:fs';
import {access} from 'node:fs/promises';
import type {MaterializerIdentityStore} from './materializerDeviceIdentity.js';

const SECRET_TOOL = '/usr/bin/secret-tool';
const SERVICE = 'io.siftable.cli.vault-materializer';

export function buildSecretServiceStoreArguments(account: string): string[] {
  if (!/^[0-9a-f]{64}$/.test(account)) throw new Error('Secret Service account is invalid');
  return [
    'store', '--label=Siftable Vault materializer device identity',
    'service', SERVICE, 'account', account,
  ];
}

export function buildSecretServiceLookupArguments(account: string): string[] {
  if (!/^[0-9a-f]{64}$/.test(account)) throw new Error('Secret Service account is invalid');
  return ['lookup', 'service', SERVICE, 'account', account];
}

async function runSecretTool(args: string[], input?: string): Promise<{
  code: number;
  output: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(SECRET_TOOL, args, {
      stdio: ['pipe', 'pipe', 'pipe'], env: {PATH: '/usr/bin:/bin'},
    });
    const output: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Secret Service operation timed out'));
    }, 10_000);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 4096) {
        child.kill('SIGKILL');
        reject(new Error('Secret Service returned too much data'));
        return;
      }
      output.push(chunk);
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({code: code ?? 1, output: Buffer.concat(output).toString('utf8')});
    });
    child.stdin.end(input == null ? undefined : `${input}\n`);
  });
}

export async function secretServiceKeyringAvailable(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    await access(SECRET_TOOL, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export const secretServiceKeyringIdentityStore: MaterializerIdentityStore = {
  async read(account: string): Promise<Buffer | null> {
    if (!(await secretServiceKeyringAvailable())) {
      throw new Error('Secret Service convenience keyring is unavailable');
    }
    const result = await runSecretTool(buildSecretServiceLookupArguments(account));
    if (result.code !== 0 || !result.output.trim()) return null;
    const value = Buffer.from(result.output.trim(), 'base64url');
    if (value.length !== 32) {
      value.fill(0);
      throw new Error('Secret Service returned an invalid Vault identity key');
    }
    return value;
  },

  async write(account: string, value: Buffer): Promise<void> {
    if (value.length !== 32) throw new Error('Secret Service value must be 32 bytes');
    if (!(await secretServiceKeyringAvailable())) {
      throw new Error('Secret Service convenience keyring is unavailable');
    }
    const result = await runSecretTool(
      buildSecretServiceStoreArguments(account),
      value.toString('base64url'),
    );
    if (result.code !== 0) throw new Error('Unable to store the Vault identity in Secret Service');
  },
};

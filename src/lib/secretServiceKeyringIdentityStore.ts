import {constants as fsConstants} from 'node:fs';
import {access} from 'node:fs/promises';
import type {MaterializerIdentityStore} from './materializerDeviceIdentity.js';
import {runBoundedStdioProcess} from './boundedStdioProcess.js';

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

export function buildSecretServiceClearArguments(account: string): string[] {
  if (!/^[0-9a-f]{64}$/.test(account)) throw new Error('Secret Service account is invalid');
  return ['clear', 'service', SERVICE, 'account', account];
}

async function runSecretTool(args: string[], input?: string): Promise<{
  code: number;
  output: string;
  errorOutput: string;
}> {
  const result = await runBoundedStdioProcess({
    executable: SECRET_TOOL,
    args,
    stdin: input == null ? undefined : `${input}\n`,
    stdoutLimit: 4096,
    operation: 'Secret Service operation',
  });
  return {
    code: result.code,
    output: result.stdout.toString('utf8'),
    errorOutput: result.stderr.toString('utf8'),
  };
}

function boundedSecretServiceError(value: string): string {
  return value.replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 512);
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
    if (result.code !== 0) {
      const detail = boundedSecretServiceError(result.errorOutput);
      if (!detail) return null;
      throw new Error(`Secret Service lookup failed: ${detail}`);
    }
    if (!result.output.trim()) return null;
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

  async remove(account: string): Promise<void> {
    if (!(await secretServiceKeyringAvailable())) {
      throw new Error('Secret Service convenience keyring is unavailable');
    }
    const result = await runSecretTool(buildSecretServiceClearArguments(account));
    if (result.code !== 0 && boundedSecretServiceError(result.errorOutput)) {
      throw new Error('Unable to remove the Vault identity from Secret Service');
    }
  },
};

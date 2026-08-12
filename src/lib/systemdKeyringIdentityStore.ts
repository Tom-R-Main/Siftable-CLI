import {spawn} from 'node:child_process';
import {constants as fsConstants} from 'node:fs';
import {access, chmod, lstat, mkdir, rename, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import type {MaterializerIdentityStore} from './materializerDeviceIdentity.js';

const SYSTEMD_CREDS = '/usr/bin/systemd-creds';
const OUTPUT_LIMIT = 64 * 1024;

export function systemdCredentialName(account: string): string {
  if (!/^[0-9a-f]{64}$/.test(account)) throw new Error('Systemd credential account is invalid');
  return `sift-vault-${account}`;
}

export function buildSystemdCredentialEncryptArguments(
  account: string,
  outputPath: string,
): string[] {
  return ['encrypt', `--name=${systemdCredentialName(account)}`, '--with-key=host', '-', outputPath];
}

export function buildSystemdCredentialDecryptArguments(
  account: string,
  inputPath: string,
): string[] {
  return ['decrypt', `--name=${systemdCredentialName(account)}`, inputPath, '-'];
}

async function runSystemdCreds(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(SYSTEMD_CREDS, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {PATH: '/usr/bin:/bin'},
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('systemd credential operation timed out'));
    }, 10_000);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > OUTPUT_LIMIT) {
        child.kill('SIGKILL');
        reject(new Error('systemd credential operation returned too much data'));
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
      if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error('systemd credential operation failed'));
    });
    child.stdin.end(input);
  });
}

function credentialPath(account: string): string {
  return path.join(
    homedir(),
    '.sift',
    'vault-materializer-systemd-credentials',
    `${systemdCredentialName(account)}.cred`,
  );
}

async function assertPrivateRegularFile(filePath: string): Promise<void> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Systemd credential state is not a regular file');
  }
  if (process.getuid && info.uid !== process.getuid()) {
    throw new Error('Systemd credential state has unsafe ownership');
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error('Systemd credential state permissions are too broad');
  }
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const parsed = path.parse(directory);
  const segments = directory.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Systemd credential directory is unsafe');
    }
  }
  const info = await lstat(directory);
  if ((process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) {
    throw new Error('Systemd credential directory is unsafe');
  }
}

export async function systemdCredentialStoreAvailable(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    await access(SYSTEMD_CREDS, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export const systemdManagedKeyringIdentityStore: MaterializerIdentityStore = {
  async read(account: string): Promise<Buffer | null> {
    if (!(await systemdCredentialStoreAvailable())) {
      throw new Error('Systemd-managed Vault identity storage is unavailable');
    }
    const filePath = credentialPath(account);
    try {
      await assertPrivateRegularFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const value = await runSystemdCreds(buildSystemdCredentialDecryptArguments(account, filePath));
    if (value.length !== 32) {
      value.fill(0);
      throw new Error('Systemd-managed Vault identity storage returned an invalid key');
    }
    return value;
  },

  async write(account: string, value: Buffer): Promise<void> {
    if (value.length !== 32) throw new Error('Systemd credential value must be 32 bytes');
    if (!(await systemdCredentialStoreAvailable())) {
      throw new Error('Systemd-managed Vault identity storage is unavailable');
    }
    const filePath = credentialPath(account);
    const directory = path.dirname(filePath);
    await mkdir(directory, {recursive: true, mode: 0o700});
    await chmod(directory, 0o700);
    await assertPrivateDirectory(directory);
    const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await runSystemdCreds(buildSystemdCredentialEncryptArguments(account, temporaryPath), value);
      await chmod(temporaryPath, 0o600);
      await assertPrivateRegularFile(temporaryPath);
      await rename(temporaryPath, filePath);
      await chmod(filePath, 0o600);
    } finally {
      await rm(temporaryPath, {force: true});
    }
    const stored = await systemdManagedKeyringIdentityStore.read(account);
    if (!stored || stored.length !== value.length || !timingSafeEqual(stored, value)) {
      stored?.fill(0);
      throw new Error('Unable to verify the systemd-managed Vault identity');
    }
    stored.fill(0);
  },

  async remove(account: string): Promise<void> {
    if (!(await systemdCredentialStoreAvailable())) {
      throw new Error('Systemd-managed Vault identity storage is unavailable');
    }
    await rm(credentialPath(account), {force: true});
  },
};

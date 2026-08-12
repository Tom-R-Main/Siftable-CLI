import {constants as fsConstants} from 'node:fs';
import {chmod, lstat, mkdir, open, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import type {MaterializerIdentityStore} from './materializerDeviceIdentity.js';

function valuePath(account: string): string {
  if (!/^[0-9a-f]{64}$/.test(account)) throw new Error('Unprotected identity account is invalid');
  return path.join(homedir(), '.sift', 'vault-materializer-unprotected', `${account}.bin`);
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const parsed = path.parse(directory);
  const segments = directory.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Unprotected Vault identity directory is unsafe');
    }
  }
  const info = await lstat(directory);
  if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Unprotected Vault identity directory is unsafe');
  }
}

export const unprotectedEnvironmentIdentityStore: MaterializerIdentityStore = {
  async read(account: string): Promise<Buffer | null> {
    const filePath = valuePath(account);
    try {
      const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o077) !== 0) {
          throw new Error('Unprotected Vault identity state is unsafe');
        }
        const value = await handle.readFile();
        if (value.length !== 32) throw new Error('Unprotected Vault identity state is invalid');
        return value;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },

  async write(account: string, value: Buffer): Promise<void> {
    if (value.length !== 32) throw new Error('Unprotected identity value must be 32 bytes');
    const filePath = valuePath(account);
    const directory = path.dirname(filePath);
    await mkdir(directory, {recursive: true, mode: 0o700});
    await chmod(directory, 0o700);
    await assertPrivateDirectory(directory);
    const handle = await open(
      filePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(filePath, 0o600);
  },

  async remove(account: string): Promise<void> {
    await rm(valuePath(account), {force: true});
  },
};

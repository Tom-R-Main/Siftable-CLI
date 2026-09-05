import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import {spawn} from 'node:child_process';
import {constants as fsConstants, type Stats} from 'node:fs';
import {chmod, lstat, mkdir, open, readFile, rename, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const KEYCHAIN_SERVICE = 'io.siftable.cli.vault-materializer';
const KEYCHAIN_LABEL = 'Siftable Vault materializer device identity';
const IDENTITY_VERSION = 1;
const LOCK_WAIT_MILLISECONDS = 5_000;

interface StoredIdentity {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  authTag: string;
  ciphertext: string;
  publicKeyPem: string;
  createdAt: string;
}

export interface MaterializerDeviceIdentity {
  publicKeyPem: string;
  privateKey: KeyObject;
  fingerprint: string;
}

export interface MaterializerIdentityStore {
  read(account: string): Promise<Buffer | null>;
  write(account: string, value: Buffer): Promise<void>;
  remove(account: string): Promise<void>;
}

/**
 * Identifies the generated endpoint credential, not the surrounding hardware.
 * Re-exporting through SPKI makes equivalent PEM encodings hash identically
 * while preserving fingerprints already produced from Sift-generated keys.
 */
export function fingerprintMaterializerPublicKey(publicKeyPem: string): string {
  const canonicalPublicKeyPem = createPublicKey(publicKeyPem)
    .export({type: 'spki', format: 'pem'})
    .toString()
    .trim();
  return createHash('sha256').update(canonicalPublicKeyPem).digest('hex');
}

export function buildMacOsKeychainWriteCommand(
  account: string,
  value: Buffer,
): string {
  if (!/^[0-9a-f]{64}$/.test(account)) {
    throw new Error('Vault materializer Keychain account is invalid');
  }
  if (value.length !== 32) {
    throw new Error('Vault materializer Keychain value must be 32 bytes');
  }
  const encodedValueHex = Buffer.from(value.toString('base64url'), 'utf8').toString('hex');
  return [
    'add-generic-password',
    '-U',
    '-a',
    account,
    '-s',
    KEYCHAIN_SERVICE,
    '-l',
    `"${KEYCHAIN_LABEL}"`,
    '-X',
    encodedValueHex,
  ].join(' ');
}

async function runSecurity(
  args: string[],
  input?: string,
): Promise<{stdout: string; stderr: string; exitCode: number}> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {PATH: '/usr/bin:/bin'},
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 64 * 1024) {
        child.kill('SIGKILL');
        reject(new Error('macOS Keychain returned too much output'));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', reject);
    child.on('close', code => resolve({
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      exitCode: code ?? 1,
    }));
    if (input == null) {
      child.stdin.end();
    } else {
      child.stdin.end(`${input}\n`);
    }
  });
}

export const macOsKeychainIdentityStore: MaterializerIdentityStore = {
  async read(account: string): Promise<Buffer | null> {
    if (process.platform !== 'darwin') {
      throw new Error(
        'Timed Vault materialization sessions require a supported OS credential store (macOS Keychain is currently supported)',
      );
    }
    const result = await runSecurity([
      'find-generic-password',
      '-a',
      account,
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ]);
    if (result.exitCode !== 0) {
      if (result.stderr.includes('could not be found')) return null;
      throw new Error('Unable to read the Vault materializer identity from macOS Keychain');
    }
    return Buffer.from(result.stdout.trim(), 'base64url');
  },

  async write(account: string, value: Buffer): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error(
        'Timed Vault materialization sessions require a supported OS credential store (macOS Keychain is currently supported)',
      );
    }
    const result = await runSecurity(
      ['-i'],
      buildMacOsKeychainWriteCommand(account, value),
    );
    if (result.exitCode !== 0) {
      throw new Error('Unable to store the Vault materializer identity in macOS Keychain');
    }
    const storedValue = await macOsKeychainIdentityStore.read(account);
    if (
      !storedValue
      || storedValue.length !== value.length
      || !timingSafeEqual(storedValue, value)
    ) {
      throw new Error('Unable to verify the Vault materializer identity in macOS Keychain');
    }
  },

  async remove(account: string): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error(
        'Timed Vault materialization sessions require a supported OS credential store (macOS Keychain is currently supported)',
      );
    }
    const result = await runSecurity([
      'delete-generic-password',
      '-a',
      account,
      '-s',
      KEYCHAIN_SERVICE,
    ]);
    if (result.exitCode !== 0 && !result.stderr.includes('could not be found')) {
      throw new Error('Unable to remove the Vault materializer identity from macOS Keychain');
    }
  },
};

function accountFor(apiUrl: string): string {
  let origin: string;
  try {
    origin = new URL(apiUrl).origin;
  } catch {
    throw new Error('Materializer identity requires a valid API URL');
  }
  return createHash('sha256').update(origin).digest('hex');
}

function statePathFor(apiUrl: string, stateDirectory?: string): string {
  const directory = stateDirectory
    ?? path.join(homedir(), '.sift', 'vault-materializer-identities');
  return path.join(directory, `${accountFor(apiUrl)}.json`);
}

async function assertSecureRegularFile(filePath: string): Promise<void> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Vault materializer identity state is not a regular file');
  }
  if (process.getuid && info.uid !== process.getuid()) {
    throw new Error('Vault materializer identity state has unsafe ownership');
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error('Vault materializer identity state permissions are too broad');
  }
}

async function assertSecureDirectory(directoryPath: string): Promise<void> {
  const parsed = path.parse(directoryPath);
  const segments = directoryPath
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new Error('Vault materializer identity directory contains a symlink');
    }
    if (!info.isDirectory()) {
      throw new Error('Vault materializer identity path contains a non-directory');
    }
  }
  const info = await lstat(directoryPath);
  if (process.getuid && info.uid !== process.getuid()) {
    throw new Error('Vault materializer identity directory has unsafe ownership');
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error('Vault materializer identity directory permissions are too broad');
  }
}

function encryptPrivateKey(privateKeyPem: Buffer, wrappingKey: Buffer): {
  iv: string;
  authTag: string;
  ciphertext: string;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(privateKeyPem),
    cipher.final(),
  ]);
  return {
    iv: iv.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

function decryptPrivateKey(state: StoredIdentity, wrappingKey: Buffer): Buffer {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    wrappingKey,
    Buffer.from(state.iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(state.authTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(state.ciphertext, 'base64url')),
    decipher.final(),
  ]);
}

async function removePathIfSameFile(filePath: string, expected: Stats): Promise<void> {
  try {
    const current = await lstat(filePath);
    if (current.dev === expected.dev && current.ino === expected.ino) {
      await rm(filePath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function tryAcquireLinuxLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  const lockHandle = await open(
    lockPath,
    fsConstants.O_CREAT | fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let child;
  try {
    await lockHandle.chmod(0o600);
    const openedStat = await lockHandle.stat();
    const current = await lstat(lockPath);
    if (current.dev !== openedStat.dev || current.ino !== openedStat.ino) {
      throw new Error('Vault materializer identity lock ownership changed before acquisition');
    }
    child = spawn(
      '/bin/sh',
      [
        '-c',
        'flock -n -E 75 3 || exit $?; printf "sift-lock-ready\\n"; IFS= read -r _ || true',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe', lockHandle.fd],
        env: {PATH: '/usr/bin:/bin'},
      },
    );
  } catch (error) {
    await lockHandle.close();
    throw error;
  }
  const childStdin = child.stdin;
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (!childStdin || !childStdout || !childStderr) {
    child.kill('SIGTERM');
    await lockHandle.close();
    throw new Error('Vault materializer identity lock helper did not expose required pipes');
  }
  let output = '';
  let stderr = '';
  let spawnError: Error | null = null;
  let stdinError: Error | null = null;
  childStderr.on('data', chunk => {
    stderr = `${stderr}${chunk.toString()}`.slice(-512);
  });
  childStdin.on('error', error => {
    stdinError = error;
  });
  const ready = new Promise<'ready' | 'closed'>(resolve => {
    childStdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('sift-lock-ready\n')) resolve('ready');
    });
    child.once('error', error => {
      spawnError = error;
      resolve('closed');
    });
    child.once('close', () => resolve('closed'));
  });
  const closed = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve => {
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  // A contending helper may exit while the parent's descriptor close yields.
  // Subscribe first so its exit (and any spawn error) cannot be lost.
  try {
    await lockHandle.close();
  } catch (error) {
    child.kill('SIGTERM');
    childStdin.end();
    await closed;
    throw error;
  }
  const outcome = await Promise.race([
    ready,
    delay(LOCK_WAIT_MILLISECONDS).then(() => 'timeout' as const),
  ]);
  if (outcome === 'timeout') {
    child.kill('SIGTERM');
    childStdin.end();
    await closed;
    throw new Error('Vault materializer identity lock helper did not become ready');
  }
  if (outcome === 'closed') {
    const result = await closed;
    if (spawnError) {
      throw new Error('Vault materializer identity on Linux requires the util-linux flock command');
    }
    if (result.code === 75) return null;
    const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
    throw new Error(
      `Vault materializer identity lock helper exited with ${result.signal ?? `code ${result.code ?? 'unknown'}`}${detail}`,
    );
  }
  return async () => {
    childStdin.end();
    const result = await closed;
    if (result.code !== 0 || stdinError) {
      const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
      throw new Error(
        `Vault materializer identity lock helper exited with ${result.signal ?? `code ${result.code ?? 'unknown'}`}${detail}`,
      );
    }
  };
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  while (true) {
    if (process.platform === 'darwin') {
      const acquired = await new Promise<boolean>((resolve, reject) => {
        const child = spawn(
          '/usr/bin/shlock',
          ['-p', String(process.pid), '-f', lockPath],
          {
            stdio: 'ignore',
            env: {PATH: '/usr/bin:/bin'},
          },
        );
        child.on('error', reject);
        child.on('close', code => resolve(code === 0));
      });
      if (acquired) {
        return async () => {
          await rm(lockPath, {force: true});
        };
      }
      if (Date.now() - startedAt >= LOCK_WAIT_MILLISECONDS) {
        throw new Error('Another Siftable process is preparing the Vault materializer identity');
      }
      await delay(100);
      continue;
    }
    if (process.platform === 'linux') {
      const release = await tryAcquireLinuxLock(lockPath);
      if (release) return release;
      if (Date.now() - startedAt >= LOCK_WAIT_MILLISECONDS) {
        throw new Error('Another Siftable process is preparing the Vault materializer identity');
      }
      await delay(100);
      continue;
    }

    try {
      const handle = await open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      let ownedStat: Stats;
      try {
        await handle.writeFile(String(process.pid));
        await handle.sync();
        ownedStat = await handle.stat();
        const current = await lstat(lockPath);
        if (current.dev !== ownedStat.dev || current.ino !== ownedStat.ino) {
          throw new Error('Vault materializer identity lock ownership changed during acquisition');
        }
      } finally {
        await handle.close();
      }
      return async () => {
        await removePathIfSameFile(lockPath, ownedStat);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error('Another Siftable process is preparing the Vault materializer identity');
      }
      if (Date.now() - startedAt >= LOCK_WAIT_MILLISECONDS) {
        throw new Error('Another Siftable process is preparing the Vault materializer identity');
      }
      await delay(100);
    }
  }
}

async function readStoredIdentity(filePath: string): Promise<StoredIdentity | null> {
  try {
    await assertSecureRegularFile(filePath);
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as StoredIdentity;
    if (
      parsed.version !== IDENTITY_VERSION
      || parsed.algorithm !== 'aes-256-gcm'
      || typeof parsed.publicKeyPem !== 'string'
      || typeof parsed.ciphertext !== 'string'
      || typeof parsed.iv !== 'string'
      || typeof parsed.authTag !== 'string'
    ) {
      throw new Error('Vault materializer identity state has an unsupported format');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeStoredIdentity(
  filePath: string,
  state: StoredIdentity,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(
    tempPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(tempPath, 0o600);
  await rename(tempPath, filePath);
}

function materializeIdentity(
  state: StoredIdentity,
  wrappingKey: Buffer,
): MaterializerDeviceIdentity {
  const privateKeyPem = decryptPrivateKey(state, wrappingKey);
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    const publicKeyPem = createPublicKey(privateKey)
      .export({type: 'spki', format: 'pem'})
      .toString();
    if (publicKeyPem.trim() !== state.publicKeyPem.trim()) {
      throw new Error('Vault materializer identity public key does not match encrypted state');
    }
    return {
      publicKeyPem,
      privateKey,
      fingerprint: fingerprintMaterializerPublicKey(publicKeyPem),
    };
  } finally {
    privateKeyPem.fill(0);
  }
}

export async function loadOrCreateMaterializerDeviceIdentity(input: {
  apiUrl: string;
  stateDirectory?: string;
  store?: MaterializerIdentityStore;
}): Promise<MaterializerDeviceIdentity> {
  const store = input.store ?? macOsKeychainIdentityStore;
  const account = accountFor(input.apiUrl);
  const filePath = statePathFor(input.apiUrl, input.stateDirectory);
  await mkdir(path.dirname(filePath), {recursive: true, mode: 0o700});
  await chmod(path.dirname(filePath), 0o700);
  await assertSecureDirectory(path.dirname(filePath));
  const releaseLock = await acquireLock(`${filePath}.lock`);
  try {
    const state = await readStoredIdentity(filePath);
    const existingWrappingKey = await store.read(account);
    if (state && !existingWrappingKey) {
      throw new Error(
        'Vault materializer identity state exists but its OS credential-store key is missing',
      );
    }
    if (!state && existingWrappingKey) {
      existingWrappingKey.fill(0);
      // A process can terminate after committing the wrapping key but before
      // atomically renaming the encrypted state into place. The missing state
      // cannot be recovered, so remove the orphan while holding the origin
      // lock and restart enrollment with a fresh identity.
      await store.remove(account);
    }
    if (state && existingWrappingKey) {
      try {
        return materializeIdentity(state, existingWrappingKey);
      } finally {
        existingWrappingKey.fill(0);
      }
    }

    const pair = generateKeyPairSync('rsa', {modulusLength: 3072});
    const publicKeyPem = pair.publicKey.export({type: 'spki', format: 'pem'}).toString();
    const privateKeyPem = Buffer.from(
      pair.privateKey.export({type: 'pkcs8', format: 'pem'}).toString(),
      'utf8',
    );
    const wrappingKey = randomBytes(32);
    try {
      try {
        await store.write(account, wrappingKey);
        const encrypted = encryptPrivateKey(privateKeyPem, wrappingKey);
        await writeStoredIdentity(filePath, {
          version: IDENTITY_VERSION,
          algorithm: 'aes-256-gcm',
          ...encrypted,
          publicKeyPem,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        try {
          await store.remove(account);
        } catch (rollbackError) {
          throw new Error(
            `Vault materializer identity persistence failed and credential rollback failed: ${
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }`,
            {cause: error},
          );
        }
        throw error;
      }
      return {
        publicKeyPem,
        privateKey: pair.privateKey,
        fingerprint: fingerprintMaterializerPublicKey(publicKeyPem),
      };
    } finally {
      privateKeyPem.fill(0);
      wrappingKey.fill(0);
    }
  } finally {
    await releaseLock();
  }
}

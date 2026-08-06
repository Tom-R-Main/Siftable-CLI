import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile, readdir, realpath, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mkdtemp, rm} from 'node:fs/promises';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  buildMacOsKeychainWriteCommand,
  fingerprintMaterializerPublicKey,
  loadOrCreateMaterializerDeviceIdentity,
  type MaterializerIdentityStore,
} from './materializerDeviceIdentity.js';

class MemoryIdentityStore implements MaterializerIdentityStore {
  readonly values = new Map<string, Buffer>();

  async read(account: string): Promise<Buffer | null> {
    const value = this.values.get(account);
    return value ? Buffer.from(value) : null;
  }

  async write(account: string, value: Buffer): Promise<void> {
    this.values.set(account, Buffer.from(value));
  }
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'sift-materializer-identity-'));
  temporaryDirectories.push(directory);
  return realpath(directory);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, {recursive: true, force: true})
  )));
});

describe('materializer device identity', () => {
  it('fingerprints the canonical public key rather than its text encoding', async () => {
    const stateDirectory = await temporaryDirectory();
    const identity = await loadOrCreateMaterializerDeviceIdentity({
      apiUrl: 'https://siftable.io',
      stateDirectory,
      store: new MemoryIdentityStore(),
    });

    expect(fingerprintMaterializerPublicKey(
      identity.publicKeyPem.replaceAll('\n', '\r\n'),
    )).toBe(identity.fingerprint);
  });

  it('keeps Keychain secret data in interpreter stdin instead of process arguments', () => {
    const account = 'a'.repeat(64);
    const value = Buffer.from('11'.repeat(32), 'hex');
    const encodedValueHex = Buffer.from(value.toString('base64url'), 'utf8').toString('hex');

    const command = buildMacOsKeychainWriteCommand(account, value);
    expect(command).toBe(
      `add-generic-password -U -a ${account} -s io.siftable.cli.vault-materializer `
      + '-l "Siftable Vault materializer device identity" '
      + `-X ${encodedValueHex}`,
    );
    expect(command).not.toContain(value.toString('base64url'));
    expect(() => buildMacOsKeychainWriteCommand('unsafe account', value)).toThrow(
      'Keychain account is invalid',
    );
    expect(() => buildMacOsKeychainWriteCommand(account, Buffer.alloc(31))).toThrow(
      'must be 32 bytes',
    );
  });

  it('reuses one OS-protected identity for the same API origin', async () => {
    const stateDirectory = await temporaryDirectory();
    const store = new MemoryIdentityStore();
    const first = await loadOrCreateMaterializerDeviceIdentity({
      apiUrl: 'https://siftable.io/api',
      stateDirectory,
      store,
    });
    const second = await loadOrCreateMaterializerDeviceIdentity({
      apiUrl: 'https://siftable.io/another-path',
      stateDirectory,
      store,
    });

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
    expect(store.values.size).toBe(1);

    const [stateFile] = await readdir(stateDirectory);
    const serialized = await readFile(path.join(stateDirectory, stateFile), 'utf8');
    expect(serialized).not.toContain('BEGIN PRIVATE KEY');
    expect((await stat(path.join(stateDirectory, stateFile))).mode & 0o077).toBe(0);
  });

  it('refuses to silently replace identity state when the OS key is missing', async () => {
    const stateDirectory = await temporaryDirectory();
    const store = new MemoryIdentityStore();
    await loadOrCreateMaterializerDeviceIdentity({
      apiUrl: 'https://siftable.io',
      stateDirectory,
      store,
    });
    store.values.clear();

    await expect(loadOrCreateMaterializerDeviceIdentity({
      apiUrl: 'https://siftable.io',
      stateDirectory,
      store,
    })).rejects.toThrow('credential-store key is missing');
  });

  it('uses distinct identities for distinct API origins', async () => {
    const stateDirectory = await temporaryDirectory();
    const store = new MemoryIdentityStore();
    const production = await loadOrCreateMaterializerDeviceIdentity({
      apiUrl: 'https://siftable.io',
      stateDirectory,
      store,
    });
    const development = await loadOrCreateMaterializerDeviceIdentity({
      apiUrl: 'http://localhost:8080',
      stateDirectory,
      store,
    });

    expect(development.fingerprint).not.toBe(production.fingerprint);
    expect(store.values.size).toBe(2);
  });

  it.runIf(process.platform === 'linux')('uses the kernel lock even when its file already exists', async () => {
    const stateDirectory = await temporaryDirectory();
    const store = new MemoryIdentityStore();
    const account = 'https://siftable.io';
    const originHash = await import('node:crypto').then(({createHash}) => (
      createHash('sha256').update(new URL(account).origin).digest('hex')
    ));
    await writeFile(
      path.join(stateDirectory, `${originHash}.json.lock`),
      '2147483647',
      {mode: 0o600},
    );

    await expect(loadOrCreateMaterializerDeviceIdentity({
      apiUrl: account,
      stateDirectory,
      store,
    })).resolves.toEqual(expect.objectContaining({
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it.runIf(process.platform === 'linux')('serializes concurrent identity preparation', async () => {
    const stateDirectory = await temporaryDirectory();
    const store = new MemoryIdentityStore();
    const input = {apiUrl: 'https://siftable.io', stateDirectory, store};

    const [first, second] = await Promise.all([
      loadOrCreateMaterializerDeviceIdentity(input),
      loadOrCreateMaterializerDeviceIdentity(input),
    ]);

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(store.values.size).toBe(1);
  });

  it.runIf(process.platform === 'linux')('releases the kernel lock when its holder crashes', async () => {
    const stateDirectory = await temporaryDirectory();
    const store = new MemoryIdentityStore();
    const account = 'https://siftable.io';
    const originHash = await import('node:crypto').then(({createHash}) => (
      createHash('sha256').update(new URL(account).origin).digest('hex')
    ));
    const lockPath = path.join(stateDirectory, `${originHash}.json.lock`);
    const holder = spawn(
      'flock',
      ['-n', '-E', '75', lockPath, '/bin/sh', '-c', 'printf "ready\\n"; sleep 30'],
      {stdio: ['ignore', 'pipe', 'pipe'], env: {PATH: '/usr/bin:/bin'}},
    );
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout.on('data', chunk => {
        if (chunk.toString().includes('ready\n')) resolve();
      });
    });
    holder.kill('SIGKILL');
    await once(holder, 'close');

    await expect(loadOrCreateMaterializerDeviceIdentity({
      apiUrl: account,
      stateDirectory,
      store,
    })).resolves.toEqual(expect.objectContaining({
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

});

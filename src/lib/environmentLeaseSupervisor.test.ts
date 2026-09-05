import {fork, type ChildProcess} from 'node:child_process';
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {lstat, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {
  materializeEnvironmentLeaseArtifact,
  type EnvironmentLeaseRuntimeRoot,
} from './environmentLease.js';
import {startEnvironmentLeaseSupervisor} from './environmentLeaseSupervisor.js';
import {
  environmentBundleMemberSetDigest,
  type EnvironmentBundleContract,
} from './environmentBundle.js';

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

describe('environment lease supervisor', () => {
  it('rejects unsettled lifecycle promises when the supervisor exits by signal', async () => {
    const pair = generateKeyPairSync('rsa', {modulusLength: 3072});
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => undefined;
    child.send = ((_message: unknown, callback?: (error: Error | null) => void) => {
      callback?.(null);
      return true;
    }) as ChildProcess['send'];
    const supervisor = startEnvironmentLeaseSupervisor({
      runtimeRoot: '/synthetic/runtime',
      leaseId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      apiUrl: 'https://example.invalid',
      token: 'synthetic-test-pat',
      workspaceId: null,
      contextContractVersion: 1,
      runnerFingerprint: 'a'.repeat(64),
      materializerDigest: 'b'.repeat(64),
      privateKey: pair.privateKey,
      forkProcess: () => child,
    });
    child.emit('exit', null, 'SIGTERM');
    await expect(supervisor.armed).rejects.toThrow('lease_supervisor_signal_SIGTERM');
    await expect(supervisor.completed).rejects.toThrow('lease_supervisor_signal_SIGTERM');
  });

  it('survives independently and removes plaintext at the hard TTL', async () => {
    const checkoutRoot = await temporaryRoot('sift-supervisor-checkout-');
    const runtimeRoot = await temporaryRoot('sift-supervisor-runtime-');
    const runtime: EnvironmentLeaseRuntimeRoot = {root: runtimeRoot, pathClass: 'platform_runtime'};
    const members = [{
      name: 'SYNTHETIC_TOKEN',
      entryId: randomUUID(),
      field: 'value',
      destinationPath: path.join(checkoutRoot, '.env'),
    }];
    const contract: EnvironmentBundleContract = {
      checkoutRoot,
      owner: {owner_type: 'personal', owner_id: null},
      ownerAlias: 'personal',
      destinationPath: path.join(checkoutRoot, '.env'),
      relativeDestination: '.env',
      mode: '0400',
      members,
      memberSetDigest: environmentBundleMemberSetDigest(members),
    };
    const leaseId = randomUUID();
    const pair = generateKeyPairSync('rsa', {modulusLength: 3072});
    const expiresAt = new Date(Date.now() + 700).toISOString();
    const requests: Array<{method: string; url: string; body: string}> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        requests.push({
          method: request.method ?? 'GET',
          url: request.url ?? '/',
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.setHeader('content-type', 'application/json');
        response.end(request.method === 'POST'
          ? JSON.stringify({lease: {cleanup: {state: 'confirmed'}}})
          : JSON.stringify({lease: {lifecycle: 'written'}}));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    let supervisor: ReturnType<typeof startEnvironmentLeaseSupervisor> | undefined;
    try {
      const result = await materializeEnvironmentLeaseArtifact({
        contract,
        values: [Buffer.from('never-log-this-synthetic-value')],
        leaseId,
        consumer: 'fixture-consumer',
        holder: 'runner:fixture',
        purpose: 'prove detached hard TTL cleanup',
        authorizationId: randomUUID(),
        authorizationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        expiresAt,
        runnerFingerprint: 'a'.repeat(64),
        materializerDigest: 'b'.repeat(64),
        runtime,
        onPrepared: async () => {
          supervisor = startEnvironmentLeaseSupervisor({
            runtimeRoot,
            leaseId,
            expiresAt,
            apiUrl: `http://127.0.0.1:${address.port}`,
            token: 'synthetic-test-pat',
            workspaceId: null,
            contextContractVersion: 1,
            runnerFingerprint: 'a'.repeat(64),
            materializerDigest: 'b'.repeat(64),
            privateKey: pair.privateKey,
            forkProcess: (modulePath, args, options) => fork(
              path.resolve(__dirname, '../../dist/lib/environmentLeaseSupervisor.js'),
              args,
              options,
            ),
          });
          await supervisor.armed;
        },
      });
      expect((await lstat(result.artifactPath)).isFile()).toBe(true);
      const cleanup = await supervisor!.completed;
      expect(cleanup).toMatchObject({cleanupState: 'confirmed', cleanupReason: 'timeout'});
      await expect(lstat(result.artifactPath)).rejects.toMatchObject({code: 'ENOENT'});
      expect(requests.some(item => item.method === 'POST' && item.url.endsWith('/cleanup'))).toBe(true);
      expect(JSON.stringify(requests)).not.toContain('never-log-this-synthetic-value');
    } finally {
      server.close();
      supervisor?.dispose();
    }
  });

  it('keeps the hard TTL after the originating manager is killed', async () => {
    const checkoutRoot = await temporaryRoot('sift-supervisor-kill-checkout-');
    const runtimeRoot = await temporaryRoot('sift-supervisor-kill-runtime-');
    const managerRoot = await temporaryRoot('sift-supervisor-manager-');
    const managerPath = path.join(managerRoot, 'manager.mjs');
    const environmentLeaseUrl = pathToFileURL(path.resolve(
      __dirname,
      '../../dist/lib/environmentLease.js',
    )).href;
    const environmentBundleUrl = pathToFileURL(path.resolve(
      __dirname,
      '../../dist/lib/environmentBundle.js',
    )).href;
    const supervisorUrl = pathToFileURL(path.resolve(
      __dirname,
      '../../dist/lib/environmentLeaseSupervisor.js',
    )).href;
    await writeFile(managerPath, `
      import {generateKeyPairSync, randomUUID} from 'node:crypto';
      import path from 'node:path';
      import {materializeEnvironmentLeaseArtifact} from ${JSON.stringify(environmentLeaseUrl)};
      import {environmentBundleMemberSetDigest} from ${JSON.stringify(environmentBundleUrl)};
      import {startEnvironmentLeaseSupervisor} from ${JSON.stringify(supervisorUrl)};
      const pair = generateKeyPairSync('rsa', {modulusLength: 3072});
      process.once('message', async config => {
        const members = [{name: 'SYNTHETIC_TOKEN', entryId: randomUUID(), field: 'value'}];
        const contract = {
          owner: {owner_type: 'personal', owner_id: null}, ownerAlias: 'personal',
          checkoutRoot: config.checkoutRoot,
          destinationPath: path.join(config.checkoutRoot, '.env'), relativeDestination: '.env',
          mode: '0400', members, memberSetDigest: environmentBundleMemberSetDigest(members),
        };
        let supervisor;
        const result = await materializeEnvironmentLeaseArtifact({
          contract, values: [Buffer.from('manager-kill-synthetic-value')],
          leaseId: config.leaseId, consumer: 'fixture-consumer', holder: 'runner:fixture',
          purpose: 'prove manager kill cleanup', authorizationId: randomUUID(),
          authorizationExpiresAt: config.authorizationExpiresAt, expiresAt: config.expiresAt,
          runnerFingerprint: 'a'.repeat(64), materializerDigest: 'b'.repeat(64),
          runtime: {root: config.runtimeRoot, pathClass: 'platform_runtime'},
          onPrepared: async () => {
            supervisor = startEnvironmentLeaseSupervisor({
              runtimeRoot: config.runtimeRoot, leaseId: config.leaseId,
              expiresAt: config.expiresAt, apiUrl: config.apiUrl, token: 'synthetic-test-pat',
              workspaceId: null, contextContractVersion: 1,
              runnerFingerprint: 'a'.repeat(64), materializerDigest: 'b'.repeat(64),
              privateKey: pair.privateKey,
            });
            await supervisor.armed;
          },
        });
        process.send({type: 'ready', artifactPath: result.artifactPath});
        setInterval(() => undefined, 1000);
      });
      process.send({type: 'initialized'});
    `, {mode: 0o600});
    const requests: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        requests.push(Buffer.concat(chunks).toString('utf8'));
        response.setHeader('content-type', 'application/json');
        response.end(request.method === 'POST'
          ? JSON.stringify({lease: {cleanup: {state: 'confirmed'}}})
          : JSON.stringify({lease: {lifecycle: 'written'}}));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const manager = fork(managerPath, [], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    const leaseId = randomUUID();
    try {
      // Imports and key generation must finish before this test starts its short lease.
      await new Promise<void>((resolve, reject) => {
        manager.once('message', message => {
          if ((message as {type?: string}).type === 'initialized') resolve();
          else reject(new Error('manager sent an unexpected initialization message'));
        });
        manager.once('error', reject);
        manager.once('exit', (code, signal) => reject(new Error(`manager exited before initialization: ${code ?? signal}`)));
      });
      const expiresAt = new Date(Date.now() + 1_200).toISOString();
      const ready = new Promise<{artifactPath: string}>((resolve, reject) => {
        manager.once('message', message => resolve(message as {artifactPath: string}));
        manager.once('error', reject);
        manager.once('exit', code => {
          if (code) reject(new Error(`manager exited ${code}`));
        });
      });
      manager.send({
        checkoutRoot,
        runtimeRoot,
        leaseId,
        expiresAt,
        authorizationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        apiUrl: `http://127.0.0.1:${address.port}`,
      });
      const {artifactPath} = await ready;
      expect((await lstat(artifactPath)).isFile()).toBe(true);
      manager.kill('SIGKILL');
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        try {
          await lstat(artifactPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await expect(lstat(artifactPath)).rejects.toMatchObject({code: 'ENOENT'});
      expect(JSON.stringify(requests)).not.toContain('manager-kill-synthetic-value');
    } finally {
      manager.kill('SIGKILL');
      server.close();
    }
  });
});

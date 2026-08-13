import {randomUUID} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  environmentBundleMemberSetDigest,
  type EnvironmentBundleContract,
} from './environmentBundle.js';
import {
  cleanupEnvironmentLeaseArtifact,
  environmentLeaseArtifactPath,
  materializeEnvironmentLeaseArtifact,
  prepareEnvironmentLeaseRuntime,
  readEnvironmentLeaseRecord,
  removeEnvironmentLeaseRecord,
  resolveEnvironmentLeaseRuntimeRoot,
  sweepEnvironmentLeases,
  type EnvironmentLeaseRuntimeRoot,
} from './environmentLease.js';

const temporaryRoots: string[] = [];
const RUNNER_DIGEST = 'b'.repeat(64);
const MATERIALIZER_DIGEST = 'c'.repeat(64);

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const canonical = await realpath(root);
  temporaryRoots.push(canonical);
  return canonical;
}

function contract(checkoutRoot: string): EnvironmentBundleContract {
  const members = [
    {name: 'GITHUB_TOKEN', entryId: randomUUID(), field: 'token'},
    {name: 'GITHUB_APP_ID', entryId: randomUUID(), field: 'app_id'},
  ];
  return {
    owner: {owner_type: 'personal', owner_id: 'self'},
    ownerAlias: 'personal',
    checkoutRoot,
    destinationPath: path.join(checkoutRoot, '.env'),
    relativeDestination: '.env',
    mode: '0400',
    members,
    memberSetDigest: environmentBundleMemberSetDigest(members),
  };
}

function timestamps() {
  return {
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    authorizationExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
}

async function fixture(input: {
  consumerPid?: number;
  expiresAt?: string;
  runtime?: EnvironmentLeaseRuntimeRoot;
} = {}) {
  const checkoutRoot = await temporaryRoot('sift-lease-checkout-');
  const runtimeRoot = input.runtime?.root ?? await temporaryRoot('sift-lease-runtime-');
  const runtime = input.runtime ?? {root: runtimeRoot, pathClass: 'platform_runtime' as const};
  const times = timestamps();
  const leaseId = randomUUID();
  const result = await materializeEnvironmentLeaseArtifact({
    contract: contract(checkoutRoot),
    values: [Buffer.from('synthetic-token'), Buffer.from('synthetic-app-id')],
    leaseId,
    consumer: 'github-pr-publisher',
    holder: 'runner:test',
    purpose: 'publish one reviewed pull request',
    authorizationId: randomUUID(),
    authorizationExpiresAt: times.authorizationExpiresAt,
    expiresAt: input.expiresAt ?? times.expiresAt,
    runnerFingerprint: RUNNER_DIGEST,
    materializerDigest: MATERIALIZER_DIGEST,
    consumerPid: input.consumerPid,
    runtime,
  });
  return {checkoutRoot, runtime, leaseId, result};
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

describe('environment lease runtime', () => {
  it('selects XDG, Linux tmpfs, and platform runtime roots deterministically', () => {
    expect(resolveEnvironmentLeaseRuntimeRoot({
      environment: {XDG_RUNTIME_DIR: '/runtime/user'},
      platform: 'linux',
      uid: 42,
    })).toEqual({root: '/runtime/user/siftable/vault-leases', pathClass: 'xdg_runtime'});
    expect(resolveEnvironmentLeaseRuntimeRoot({
      environment: {}, platform: 'linux', uid: 42, linuxRuntimeAvailable: true,
    }))
      .toEqual({root: '/run/user/42/siftable/vault-leases', pathClass: 'tmpfs'});
    expect(resolveEnvironmentLeaseRuntimeRoot({
      environment: {},
      platform: 'linux',
      uid: 42,
      linuxRuntimeAvailable: false,
      temporaryDirectory: '/private/runtime',
    })).toEqual({root: '/private/runtime/siftable-vault-leases-42', pathClass: 'platform_runtime'});
    expect(resolveEnvironmentLeaseRuntimeRoot({
      environment: {},
      platform: 'darwin',
      uid: 42,
      temporaryDirectory: '/private/runtime',
    })).toEqual({root: '/private/runtime/siftable-vault-leases-42', pathClass: 'platform_runtime'});
  });

  it('creates an owner-only artifact outside the worktree and stores no values in metadata', async () => {
    const {checkoutRoot, runtime, leaseId, result} = await fixture();
    expect(result.artifactPath.startsWith(checkoutRoot)).toBe(false);
    expect(result.record).toMatchObject({
      leaseId,
      owner: 'personal',
      bundleDigest: result.record.bundleDigest,
      consumer: 'github-pr-publisher',
      cleanupState: 'pending',
      artifactPathClass: 'platform_runtime',
    });
    const info = await lstat(result.artifactPath);
    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o777).toBe(0o400);
    const metadata = await readFile(path.join(runtime.root, 'records', `${leaseId}.json`), 'utf8');
    expect(metadata).not.toContain('synthetic-token');
    expect(metadata).not.toContain('synthetic-app-id');
    expect(await readEnvironmentLeaseRecord(runtime.root, leaseId)).toEqual(result.record);
  });

  it('refuses worktree roots, symlink escapes, and artifacts that outlive authorization', async () => {
    const checkoutRoot = await temporaryRoot('sift-lease-unsafe-checkout-');
    await expect(prepareEnvironmentLeaseRuntime({
      workspaceRoot: checkoutRoot,
      runtime: {root: path.join(checkoutRoot, '.runtime'), pathClass: 'platform_runtime'},
    })).rejects.toThrow('outside every Git worktree');

    const outside = await temporaryRoot('sift-lease-symlink-target-');
    const link = path.join(await temporaryRoot('sift-lease-symlink-parent-'), 'runtime-link');
    await symlink(outside, link);
    await expect(prepareEnvironmentLeaseRuntime({
      workspaceRoot: checkoutRoot,
      runtime: {root: link, pathClass: 'platform_runtime'},
    })).rejects.toThrow('symlink');

    const otherWorktree = await temporaryRoot('sift-lease-other-worktree-');
    await writeFile(path.join(otherWorktree, '.git'), 'gitdir: synthetic');
    await expect(prepareEnvironmentLeaseRuntime({
      workspaceRoot: checkoutRoot,
      runtime: {root: path.join(otherWorktree, '.runtime'), pathClass: 'platform_runtime'},
    })).rejects.toThrow('outside every Git worktree');

    const runtime = {root: await temporaryRoot('sift-lease-expiry-'), pathClass: 'platform_runtime' as const};
    const authorizationExpiresAt = new Date(Date.now() + 60_000).toISOString();
    await expect(materializeEnvironmentLeaseArtifact({
      contract: contract(checkoutRoot),
      values: [Buffer.from('fixture-a'), Buffer.from('fixture-b')],
      leaseId: randomUUID(),
      consumer: 'consumer',
      holder: 'holder',
      purpose: 'test bounded expiry',
      authorizationId: randomUUID(),
      authorizationExpiresAt,
      expiresAt: authorizationExpiresAt,
      runnerFingerprint: RUNNER_DIGEST,
      materializerDigest: MATERIALIZER_DIGEST,
      runtime,
    })).rejects.toThrow('strictly earlier');
  });

  it('makes concurrent cleanup idempotently confirmed', async () => {
    const {runtime, leaseId, result} = await fixture();
    const [left, right] = await Promise.all([
      cleanupEnvironmentLeaseArtifact({runtimeRoot: runtime.root, leaseId, reason: 'revoke'}),
      cleanupEnvironmentLeaseArtifact({runtimeRoot: runtime.root, leaseId, reason: 'revoke'}),
    ]);
    expect(left.cleanupState).toBe('confirmed');
    expect(right.cleanupState).toBe('confirmed');
    await expect(lstat(result.artifactPath)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('does not recreate plaintext when cleanup wins during preparation', async () => {
    const checkoutRoot = await temporaryRoot('sift-lease-prepare-race-checkout-');
    const runtime = {
      root: await temporaryRoot('sift-lease-prepare-race-runtime-'),
      pathClass: 'platform_runtime' as const,
    };
    const leaseId = randomUUID();
    const times = timestamps();
    await expect(materializeEnvironmentLeaseArtifact({
      contract: contract(checkoutRoot),
      values: [Buffer.from('fixture-a'), Buffer.from('fixture-b')],
      leaseId,
      consumer: 'consumer',
      holder: 'holder',
      purpose: 'prove prepare-to-ready fencing',
      authorizationId: randomUUID(),
      ...times,
      runnerFingerprint: RUNNER_DIGEST,
      materializerDigest: MATERIALIZER_DIGEST,
      runtime,
      onPrepared: async () => {
        const cleaned = await cleanupEnvironmentLeaseArtifact({
          runtimeRoot: runtime.root,
          leaseId,
          reason: 'revoke',
        });
        expect(cleaned.cleanupState).toBe('confirmed');
      },
    })).rejects.toThrow('prepare-to-ready race');
    await expect(lstat(environmentLeaseArtifactPath(runtime.root, leaseId)))
      .rejects.toMatchObject({code: 'ENOENT'});
    expect(await readEnvironmentLeaseRecord(runtime.root, leaseId))
      .toMatchObject({cleanupState: 'confirmed', cleanupReason: 'revoke'});
  });

  it('reports changed artifact identity as unknowable instead of deleting it', async () => {
    const {runtime, leaseId, result} = await fixture();
    await rm(result.artifactPath);
    await writeFile(result.artifactPath, 'replacement', {mode: 0o600});
    const cleaned = await cleanupEnvironmentLeaseArtifact({
      runtimeRoot: runtime.root,
      leaseId,
      reason: 'startup_sweep',
    });
    expect(cleaned).toMatchObject({cleanupState: 'unknowable', cleanupErrorCode: 'artifact_identity_changed'});
    expect(await readFile(result.artifactPath, 'utf8')).toBe('replacement');
  });

  it('sweeps expired artifacts and stale consumer processes after restart', async () => {
    const expired = await fixture();
    const expiredSweep = await sweepEnvironmentLeases({
      runtimeRoot: expired.runtime.root,
      now: Date.parse(expired.result.record.expiresAt) + 1,
    });
    expect(expiredSweep[0]).toMatchObject({cleanupState: 'confirmed', cleanupReason: 'startup_sweep'});

    const stale = await fixture({consumerPid: 2_147_483_647});
    const staleSweep = await sweepEnvironmentLeases({runtimeRoot: stale.runtime.root});
    expect(staleSweep[0]).toMatchObject({cleanupState: 'confirmed', cleanupReason: 'crash_recovery'});

    const retry = await sweepEnvironmentLeases({runtimeRoot: stale.runtime.root});
    expect(retry[0]).toMatchObject({cleanupState: 'confirmed', cleanupReason: 'crash_recovery'});
    await removeEnvironmentLeaseRecord(stale.runtime.root, stale.leaseId);
    expect(await readEnvironmentLeaseRecord(stale.runtime.root, stale.leaseId)).toBeUndefined();

    const crashed = await fixture();
    const crashedRecordPath = path.join(crashed.runtime.root, 'records', `${crashed.leaseId}.json`);
    await writeFile(crashedRecordPath, JSON.stringify({
      ...crashed.result.record,
      artifactState: 'preparing',
      managerPid: 2_147_483_647,
    }));
    const crashSweep = await sweepEnvironmentLeases({runtimeRoot: crashed.runtime.root});
    expect(crashSweep[0]).toMatchObject({
      cleanupState: 'confirmed',
      cleanupReason: 'crash_recovery',
    });
  });

  it('ignores mixed-version metadata and never logs plaintext', async () => {
    const checkoutRoot = await temporaryRoot('sift-lease-version-checkout-');
    const runtime = {root: await temporaryRoot('sift-lease-version-runtime-'), pathClass: 'platform_runtime' as const};
    await prepareEnvironmentLeaseRuntime({workspaceRoot: checkoutRoot, runtime});
    const leaseId = randomUUID();
    await writeFile(path.join(runtime.root, 'records', `${leaseId}.json`), JSON.stringify({schemaVersion: 2}));
    expect(await readEnvironmentLeaseRecord(runtime.root, leaseId)).toBeUndefined();
    const malformedLeaseId = randomUUID();
    await writeFile(path.join(runtime.root, 'records', `${malformedLeaseId}.json`), '{');
    expect(await readEnvironmentLeaseRecord(runtime.root, malformedLeaseId)).toBeUndefined();

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await fixture();
    expect(log).not.toHaveBeenCalled();
  });

  it('rejects a pre-existing special artifact path', async () => {
    const checkoutRoot = await temporaryRoot('sift-lease-special-checkout-');
    const runtime = {root: await temporaryRoot('sift-lease-special-runtime-'), pathClass: 'platform_runtime' as const};
    await prepareEnvironmentLeaseRuntime({workspaceRoot: checkoutRoot, runtime});
    const leaseId = randomUUID();
    await mkdir(environmentLeaseArtifactPath(runtime.root, leaseId));
    const times = timestamps();
    await expect(materializeEnvironmentLeaseArtifact({
      contract: contract(checkoutRoot),
      values: [Buffer.from('fixture-a'), Buffer.from('fixture-b')],
      leaseId,
      consumer: 'consumer',
      holder: 'holder',
      purpose: 'reject special file',
      authorizationId: randomUUID(),
      ...times,
      runnerFingerprint: RUNNER_DIGEST,
      materializerDigest: MATERIALIZER_DIGEST,
      runtime,
    })).rejects.toMatchObject({code: 'EEXIST'});
  });
});

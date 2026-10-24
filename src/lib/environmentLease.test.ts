import {randomUUID} from 'node:crypto';
import {link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  environmentBundleMemberSetDigest,
  type EnvironmentBundleContract,
} from './environmentBundle.js';
import {
  cleanupEnvironmentLeaseArtifact,
  environmentLeaseAnchorPath,
  environmentLeaseArtifactPath,
  materializeEnvironmentLeaseArtifact,
  prepareEnvironmentLeaseRuntime,
  readEnvironmentLeaseRecord,
  removeEnvironmentLeaseRecord,
  resolveEnvironmentLeaseRuntimeRoot,
  sweepEnvironmentLeases,
  type EnvironmentLeaseRuntimeRoot,
} from './environmentLease.js';
import {systemdMaterializerIdentityStoreUsable} from './localMaterializer.js';

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

function quarantinePath(artifactPath: string, leaseId: string): string {
  return path.join(path.dirname(artifactPath), `.cleanup-${leaseId}-${randomUUID()}`);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

describe('environment lease runtime', () => {
  it('requires a successful systemd credential round trip before selecting the store', async () => {
    let stored: Buffer | null = null;
    const usable = await systemdMaterializerIdentityStoreUsable({
      available: async () => true,
      store: {
        read: async () => stored ? Buffer.from(stored) : null,
        write: async (_account, value) => {
          stored = Buffer.from(value);
        },
        remove: async () => {
          stored?.fill(0);
          stored = null;
        },
      },
    });
    expect(usable).toBe(true);

    const inaccessible = await systemdMaterializerIdentityStoreUsable({
      available: async () => true,
      store: {
        read: async () => null,
        write: async () => {
          throw new Error('host credential key is inaccessible');
        },
        remove: async () => undefined,
      },
    });
    expect(inaccessible).toBe(false);
  });

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
    const anchorPath = environmentLeaseAnchorPath(runtime.root, leaseId);
    expect(result.record.artifactAnchorPath).toBe(anchorPath);
    expect(await lstat(anchorPath)).toMatchObject({dev: info.dev, ino: info.ino});
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
    await expect(lstat(environmentLeaseAnchorPath(runtime.root, leaseId))).rejects.toMatchObject({code: 'ENOENT'});
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
    await expect(lstat(environmentLeaseAnchorPath(runtime.root, leaseId)))
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

  it('refuses to delete a replacement whose device, inode, and birth time all match the record', async () => {
    const {runtime, leaseId, result} = await fixture();
    await rm(result.artifactPath);
    await writeFile(result.artifactPath, 'replacement', {mode: 0o600});
    const replacement = await lstat(result.artifactPath, {bigint: true});
    // Model a recycled inode in the same birth-time tick: every recorded identity field names the replacement.
    await writeFile(path.join(runtime.root, 'records', `${leaseId}.json`), JSON.stringify({
      ...result.record,
      artifactDevice: Number(replacement.dev),
      artifactInode: Number(replacement.ino),
      artifactBirthtimeNs: replacement.birthtimeNs.toString(),
    }));
    const cleaned = await cleanupEnvironmentLeaseArtifact({
      runtimeRoot: runtime.root,
      leaseId,
      reason: 'startup_sweep',
    });
    expect(cleaned.cleanupState).toBe('unknowable');
    expect(await readFile(result.artifactPath, 'utf8')).toBe('replacement');
  });

  it('does not delete an artifact whose record predates the anchor', async () => {
    const {runtime, leaseId, result} = await fixture();
    const legacyRecord: Partial<typeof result.record> = {...result.record};
    delete legacyRecord.artifactAnchorPath;
    await writeFile(path.join(runtime.root, 'records', `${leaseId}.json`), JSON.stringify(legacyRecord));
    expect(await readEnvironmentLeaseRecord(runtime.root, leaseId)).toMatchObject({leaseId, cleanupState: 'pending'});
    const cleaned = await cleanupEnvironmentLeaseArtifact({
      runtimeRoot: runtime.root,
      leaseId,
      reason: 'startup_sweep',
    });
    expect(cleaned).toMatchObject({cleanupState: 'unknowable', cleanupErrorCode: 'artifact_identity_unverifiable'});
    expect((await lstat(result.artifactPath)).isFile()).toBe(true);
  });

  it('sweeps an interrupted quarantine and its anchor to confirmed', async () => {
    const {runtime, leaseId, result} = await fixture();
    const leftover = quarantinePath(result.artifactPath, leaseId);
    await rename(result.artifactPath, leftover);
    const swept = await sweepEnvironmentLeases({
      runtimeRoot: runtime.root,
      now: Date.parse(result.record.expiresAt) + 1,
    });
    expect(swept[0]).toMatchObject({cleanupState: 'confirmed', cleanupErrorCode: null});
    await expect(lstat(leftover)).rejects.toMatchObject({code: 'ENOENT'});
    await expect(lstat(environmentLeaseAnchorPath(runtime.root, leaseId))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('converges to confirmed after an interruption during quarantine reconciliation', async () => {
    const anchorOnly = await fixture();
    await rm(anchorOnly.result.artifactPath);
    expect(await cleanupEnvironmentLeaseArtifact({
      runtimeRoot: anchorOnly.runtime.root,
      leaseId: anchorOnly.leaseId,
      reason: 'crash_recovery',
    })).toMatchObject({cleanupState: 'confirmed'});
    await expect(lstat(environmentLeaseAnchorPath(anchorOnly.runtime.root, anchorOnly.leaseId)))
      .rejects.toMatchObject({code: 'ENOENT'});

    const partial = await fixture();
    const removedFirst = quarantinePath(partial.result.artifactPath, partial.leaseId);
    const remaining = quarantinePath(partial.result.artifactPath, partial.leaseId);
    await link(partial.result.artifactPath, removedFirst);
    await rename(partial.result.artifactPath, remaining);
    await rm(removedFirst);
    expect(await cleanupEnvironmentLeaseArtifact({
      runtimeRoot: partial.runtime.root,
      leaseId: partial.leaseId,
      reason: 'crash_recovery',
    })).toMatchObject({cleanupState: 'confirmed'});
    await expect(lstat(remaining)).rejects.toMatchObject({code: 'ENOENT'});
    await expect(lstat(environmentLeaseAnchorPath(partial.runtime.root, partial.leaseId)))
      .rejects.toMatchObject({code: 'ENOENT'});
  });

  it('removes an extra owned quarantine alongside a present artifact', async () => {
    const {runtime, leaseId, result} = await fixture();
    const extra = quarantinePath(result.artifactPath, leaseId);
    await link(result.artifactPath, extra);
    expect(await cleanupEnvironmentLeaseArtifact({
      runtimeRoot: runtime.root,
      leaseId,
      reason: 'revoke',
    })).toMatchObject({cleanupState: 'confirmed'});
    await expect(lstat(result.artifactPath)).rejects.toMatchObject({code: 'ENOENT'});
    await expect(lstat(extra)).rejects.toMatchObject({code: 'ENOENT'});
    await expect(lstat(environmentLeaseAnchorPath(runtime.root, leaseId))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('preserves foreign entries under quarantine names and keeps the anchor while unexplained links remain', async () => {
    const unrelated = await fixture();
    const foreign = quarantinePath(unrelated.result.artifactPath, unrelated.leaseId);
    await writeFile(foreign, 'foreign', {mode: 0o600});
    const victim = path.join(await temporaryRoot('sift-lease-symlink-victim-'), 'victim');
    await writeFile(victim, 'victim', {mode: 0o600});
    const pointer = quarantinePath(unrelated.result.artifactPath, unrelated.leaseId);
    await symlink(victim, pointer);
    expect(await cleanupEnvironmentLeaseArtifact({
      runtimeRoot: unrelated.runtime.root,
      leaseId: unrelated.leaseId,
      reason: 'revoke',
    })).toMatchObject({cleanupState: 'confirmed'});
    expect(await readFile(foreign, 'utf8')).toBe('foreign');
    expect((await lstat(pointer)).isSymbolicLink()).toBe(true);
    expect(await readFile(victim, 'utf8')).toBe('victim');

    const linked = await fixture();
    const unexplained = path.join(path.dirname(linked.result.artifactPath), `.cleanup-${linked.leaseId}-not-a-uuid`);
    await link(linked.result.artifactPath, unexplained);
    expect(await cleanupEnvironmentLeaseArtifact({
      runtimeRoot: linked.runtime.root,
      leaseId: linked.leaseId,
      reason: 'revoke',
    })).toMatchObject({cleanupState: 'unknowable', cleanupErrorCode: 'artifact_links_remain'});
    expect((await lstat(unexplained)).isFile()).toBe(true);
    expect((await lstat(environmentLeaseAnchorPath(linked.runtime.root, linked.leaseId))).isFile()).toBe(true);
  });

  it('keeps an artifact whose anchor is missing', async () => {
    const {runtime, leaseId, result} = await fixture();
    await rm(environmentLeaseAnchorPath(runtime.root, leaseId));
    expect(await cleanupEnvironmentLeaseArtifact({
      runtimeRoot: runtime.root,
      leaseId,
      reason: 'crash_recovery',
    })).toMatchObject({cleanupState: 'unknowable', cleanupErrorCode: 'artifact_anchor_missing'});
    expect((await lstat(result.artifactPath)).isFile()).toBe(true);
  });

  it('fails preparation before writing values when the anchor cannot be linked', async () => {
    const checkoutRoot = await temporaryRoot('sift-lease-anchor-checkout-');
    const runtime = {root: await temporaryRoot('sift-lease-anchor-runtime-'), pathClass: 'platform_runtime' as const};
    await prepareEnvironmentLeaseRuntime({workspaceRoot: checkoutRoot, runtime});
    const leaseId = randomUUID();
    const blocker = environmentLeaseAnchorPath(runtime.root, leaseId);
    await mkdir(blocker);
    const onPrepared = vi.fn(async () => undefined);
    await expect(materializeEnvironmentLeaseArtifact({
      contract: contract(checkoutRoot),
      values: [Buffer.from('fixture-a'), Buffer.from('fixture-b')],
      leaseId,
      consumer: 'consumer',
      holder: 'holder',
      purpose: 'refuse undisposable artifacts',
      authorizationId: randomUUID(),
      ...timestamps(),
      runnerFingerprint: RUNNER_DIGEST,
      materializerDigest: MATERIALIZER_DIGEST,
      runtime,
      onPrepared,
    })).rejects.toMatchObject({code: 'EEXIST'});
    expect(onPrepared).not.toHaveBeenCalled();
    await expect(lstat(environmentLeaseArtifactPath(runtime.root, leaseId))).rejects.toMatchObject({code: 'ENOENT'});
    expect(await readEnvironmentLeaseRecord(runtime.root, leaseId)).toBeUndefined();
    expect((await lstat(blocker)).isDirectory()).toBe(true);
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

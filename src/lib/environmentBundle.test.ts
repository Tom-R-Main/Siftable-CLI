import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {hostname} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  buildEnvironmentBundleContract,
  assertManagedEnvironmentBundleGitSafety,
  inspectManagedEnvironmentBundle,
  materializeManagedEnvironmentBundle,
  privateObservedEnvironmentDigest,
  readManagedEnvironmentBundleReceipt,
  removeManagedEnvironmentBundle,
  writeManagedEnvironmentBundleReceipt,
} from './environmentBundle.js';
import type {EnvironmentManifest} from './environmentManifest.js';

const roots: string[] = [];
const manifest: EnvironmentManifest = {
  schema_version: 1,
  kind: 'sift.environment.contract',
  owners: {personal: {owner_type: 'personal', owner_id: 'self'}},
  members: [
    {name: 'API_USER', kind: 'vault_field', owner: 'personal', entry_id: '11111111-1111-4111-8111-111111111111', field: 'username', sensitivity: 'confidential', destination: {path: '.runtime/.env.local', mode: '0600'}},
    {name: 'API_PASSWORD', kind: 'vault_field', owner: 'personal', entry_id: '22222222-2222-4222-8222-222222222222', field: 'password', sensitivity: 'secret', destination: {path: '.runtime/.env.local', mode: '0600'}},
  ],
};

afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))));

async function prepareCheckout(root: string): Promise<void> {
  execFileSync('git', ['init', '--quiet'], {cwd: root});
  await writeFile(path.join(root, '.gitignore'), '.runtime/\n');
  await mkdir(path.join(root, '.sift'));
  await writeFile(path.join(root, '.sift', 'environment.yaml'), `
schema_version: 1
kind: sift.environment.contract
owners:
  personal: {owner_type: personal, owner_id: self}
members:
  - name: API_USER
    kind: vault_field
    owner: personal
    entry_id: 11111111-1111-4111-8111-111111111111
    field: username
    sensitivity: confidential
    destination: {path: .runtime/.env.local, mode: "0600"}
  - name: API_PASSWORD
    kind: vault_field
    owner: personal
    entry_id: 22222222-2222-4222-8222-222222222222
    field: password
    sensitivity: secret
    destination: {path: .runtime/.env.local, mode: "0600"}
`);
}

describe('governed environment bundles', () => {
  it('rejects tracked and unignored managed destinations before approval', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'sift-env-bundle-'));
    roots.push(root);
    execFileSync('git', ['init', '--quiet'], {cwd: root});
    const contract = buildEnvironmentBundleContract(manifest, root, '.runtime/.env.local');
    await expect(assertManagedEnvironmentBundleGitSafety(contract))
      .rejects.toThrow('must be ignored');
    await writeFile(path.join(root, '.gitignore'), '.runtime/\n');
    await expect(assertManagedEnvironmentBundleGitSafety(contract)).resolves.toBeUndefined();
    await mkdir(path.join(root, '.runtime'));
    await writeFile(contract.destinationPath, 'synthetic');
    execFileSync('git', ['add', '-f', contract.relativeDestination], {cwd: root});
    await expect(assertManagedEnvironmentBundleGitSafety(contract))
      .rejects.toThrow('tracked by Git');
  });

  it('requires repository ignore coverage for the lock sidecar as well as the destination', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'sift-env-bundle-'));
    roots.push(root);
    execFileSync('git', ['init', '--quiet'], {cwd: root});
    await writeFile(path.join(root, '.gitignore'), '.runtime/.env.local\n');
    const contract = buildEnvironmentBundleContract(manifest, root, '.runtime/.env.local');
    await expect(assertManagedEnvironmentBundleGitSafety(contract))
      .rejects.toThrow('lock sidecar');
  });

  it('binds and invalidates the exact ordered entry and field set', () => {
    const first = buildEnvironmentBundleContract(manifest, '/workspace', '.runtime/.env.local');
    const reordered = buildEnvironmentBundleContract({...manifest, members: [...manifest.members].reverse()}, '/workspace', '.runtime/.env.local');
    const substituted = buildEnvironmentBundleContract({...manifest, members: [manifest.members[0], {...manifest.members[1], field: 'alternate'}]}, '/workspace', '.runtime/.env.local');
    expect(first.members.map(member => member.name)).toEqual(['API_USER', 'API_PASSWORD']);
    expect(first.memberSetDigest).toBe(createHash('sha256').update(JSON.stringify([
      {name: 'API_USER', vaultEntryId: '11111111-1111-4111-8111-111111111111', credentialField: 'username'},
      {name: 'API_PASSWORD', vaultEntryId: '22222222-2222-4222-8222-222222222222', credentialField: 'password'},
    ])).digest('hex'));
    expect(reordered.memberSetDigest).not.toBe(first.memberSetDigest);
    expect(substituted.memberSetDigest).not.toBe(first.memberSetDigest);
  });

  it('writes one fully managed file atomically and keeps receipts value-free', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'sift-env-bundle-'));
    roots.push(root);
    await prepareCheckout(root);
    await mkdir(path.join(root, '.runtime'));
    const contract = buildEnvironmentBundleContract(manifest, root, '.runtime/.env.local');
    const onCommitted = vi.fn();
    const onCleanup = vi.fn();
    const receipt = await materializeManagedEnvironmentBundle({
      contract,
      values: [Buffer.from('synthetic-user'), Buffer.from('synthetic-password')],
      expectedAbsence: true,
      onCommitted,
      onCleanup,
    });
    const contents = await readFile(contract.destinationPath, 'utf8');
    expect(contents).toContain('# Sift-managed environment bundle. Do not edit.');
    expect(contents).toContain('# Local overrides: use .env.local or the framework-equivalent override file.');
    expect(contents).toContain('API_USER="synthetic-user"');
    expect(contents).toContain('API_PASSWORD="synthetic-password"');
    expect(JSON.stringify(receipt)).not.toContain('synthetic-');
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(onCleanup).toHaveBeenCalledWith(true);
    expect(receipt.memberSetDigest).toBe(contract.memberSetDigest);
  });

  it('persists only value-free refresh metadata and removes the exact managed file', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'sift-env-bundle-'));
    roots.push(root);
    await prepareCheckout(root);
    await mkdir(path.join(root, '.runtime'));
    const contract = buildEnvironmentBundleContract(manifest, root, '.runtime/.env.local');
    const written = await materializeManagedEnvironmentBundle({
      contract,
      values: [Buffer.from('synthetic-user'), Buffer.from('synthetic-password')],
      expectedAbsence: true,
    });
    const receipt = {
      ...written,
      lastCheckedAt: '2026-08-06T00:00:00.000Z',
      sourceVersionDigest: 'a'.repeat(64),
    };
    await writeManagedEnvironmentBundleReceipt(contract, receipt);
    const restored = await readManagedEnvironmentBundleReceipt(contract);
    expect(restored).toEqual(receipt);
    expect(JSON.stringify(restored)).not.toContain('synthetic-');

    await expect(removeManagedEnvironmentBundle(contract, restored)).resolves.toEqual({
      removed: true,
      destination: '.runtime/.env.local',
    });
    await expect(readFile(contract.destinationPath)).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readManagedEnvironmentBundleReceipt(contract)).resolves.toBeUndefined();
  });

  it('refuses removal after local content or file identity changes', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'sift-env-bundle-'));
    roots.push(root);
    await prepareCheckout(root);
    await mkdir(path.join(root, '.runtime'));
    const contract = buildEnvironmentBundleContract(manifest, root, '.runtime/.env.local');
    const receipt = await materializeManagedEnvironmentBundle({
      contract,
      values: [Buffer.from('synthetic-user'), Buffer.from('synthetic-password')],
      expectedAbsence: true,
    });
    await writeManagedEnvironmentBundleReceipt(contract, receipt);
    await writeFile(contract.destinationPath, '# locally replaced\n');

    await expect(removeManagedEnvironmentBundle(contract, receipt))
      .rejects.toThrow(/modified_locally|changed/i);
    expect(await readFile(contract.destinationPath, 'utf8')).toBe('# locally replaced\n');
  });

  it('clears every resolved buffer when the approved member set no longer matches', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'sift-env-bundle-'));
    roots.push(root);
    await prepareCheckout(root);
    await mkdir(path.join(root, '.runtime'));
    const contract = buildEnvironmentBundleContract(manifest, root, '.runtime/.env.local');
    contract.members.reverse();
    const values = [Buffer.from('synthetic-one'), Buffer.from('synthetic-two')];
    await expect(materializeManagedEnvironmentBundle({contract, values, expectedAbsence: true}))
      .rejects.toThrow('member set changed');
    expect(values.every(value => value.every(byte => byte === 0))).toBe(true);
    await expect(readFile(contract.destinationPath)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('honors an existing advisory lock without removing it or writing bytes', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'sift-env-bundle-'));
    roots.push(root);
    await mkdir(path.join(root, '.runtime'));
    const contract = buildEnvironmentBundleContract(manifest, root, '.runtime/.env.local');
    const lockPath = `${contract.destinationPath}.sift-lock`;
    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      lockId: '11111111-1111-4111-8111-111111111111',
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    })}\n`, {mode: 0o600});
    await expect(materializeManagedEnvironmentBundle({
      contract,
      values: [Buffer.from('synthetic-one'), Buffer.from('synthetic-two')],
      expectedAbsence: true,
    })).rejects.toThrow('holds the destination lock');
    expect(await readFile(lockPath, 'utf8')).toContain(String(process.pid));
    await expect(readFile(contract.destinationPath)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('reports modified_locally and requires replacement consent bound to the observed file', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'sift-env-bundle-'));
    roots.push(root);
    await prepareCheckout(root);
    await mkdir(path.join(root, '.runtime'));
    const contract = buildEnvironmentBundleContract(manifest, root, '.runtime/.env.local');
    const first = await materializeManagedEnvironmentBundle({contract, values: [Buffer.from('one'), Buffer.from('two')], expectedAbsence: true});
    await writeFile(contract.destinationPath, '# hand edited\n');
    const inspection = await inspectManagedEnvironmentBundle(contract, first);
    expect(inspection.state).toBe('modified_locally');
    const privateDigest = privateObservedEnvironmentDigest(inspection);
    if (!privateDigest) throw new Error('expected private observation digest');
    expect(privateDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(inspection)).not.toContain(privateDigest);
    await expect(materializeManagedEnvironmentBundle({
      contract,
      values: [Buffer.from('new-one'), Buffer.from('new-two')],
      expectedAbsence: false,
      expectedDestinationState: inspection.observedState,
      expectedDestinationDigest: privateDigest,
    })).rejects.toThrow('replacement consent');
    await materializeManagedEnvironmentBundle({
      contract,
      values: [Buffer.from('new-one'), Buffer.from('new-two')],
      expectedAbsence: false,
      expectedDestinationState: inspection.observedState,
      expectedDestinationDigest: privateDigest,
      replacementConsentState: inspection.observedState,
    });
    expect(await readFile(contract.destinationPath, 'utf8')).toContain('API_USER="new-one"');
  });

  it('recovers a demonstrably stale lock without weakening the destination checks', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'sift-env-bundle-'));
    roots.push(root);
    await prepareCheckout(root);
    await mkdir(path.join(root, '.runtime'));
    const contract = buildEnvironmentBundleContract(manifest, root, '.runtime/.env.local');
    await writeFile(`${contract.destinationPath}.sift-lock`, `${JSON.stringify({
      schemaVersion: 1,
      lockId: '22222222-2222-4222-8222-222222222222',
      pid: 2_147_483_647,
      hostname: hostname(),
      createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    })}\n`, {mode: 0o600});
    await expect(materializeManagedEnvironmentBundle({
      contract,
      values: [Buffer.from('one'), Buffer.from('two')],
      expectedAbsence: true,
    })).resolves.toMatchObject({memberSetDigest: contract.memberSetDigest});
    await expect(readFile(`${contract.destinationPath}.sift-lock`)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('fails closed when the destination becomes Git-tracked while the lock is held', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'sift-env-bundle-'));
    roots.push(root);
    await prepareCheckout(root);
    await mkdir(path.join(root, '.runtime'));
    const contract = buildEnvironmentBundleContract(manifest, root, '.runtime/.env.local');
    const values = [Buffer.from('one'), Buffer.from('two')];
    await expect(materializeManagedEnvironmentBundle({
      contract,
      values,
      expectedAbsence: true,
      beforeCommit: async () => {
        const objectId = execFileSync('git', ['hash-object', '-w', '--stdin'], {
          cwd: root,
          input: 'tracked placeholder\n',
          encoding: 'utf8',
        }).trim();
        execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${objectId},${contract.relativeDestination}`], {cwd: root});
      },
    })).rejects.toThrow('tracked by Git');
    expect(values.every(value => value.every(byte => byte === 0))).toBe(true);
    await expect(readFile(contract.destinationPath)).rejects.toMatchObject({code: 'ENOENT'});
  });
});

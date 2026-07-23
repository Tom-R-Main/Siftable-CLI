import {execFile} from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it} from 'vitest';
import {
  createMaterializationCredentialBinding,
  inspectMaterializationDestination,
  materializeApprovedPlaintext,
  validateMaterializationPath,
} from './localMaterializer.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function workspace(): Promise<string> {
  const canonicalTempRoot = await realpath(tmpdir());
  const root = await mkdtemp(path.join(canonicalTempRoot, 'sift-materializer-test-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, {recursive: true, force: true});
});

describe('local Vault materializer', () => {
  it('writes only the approved destination atomically with restrictive permissions', async () => {
    const root = await workspace();
    const parent = path.join(root, 'runtime');
    const destination = path.join(parent, 'materialized-value');
    await mkdir(parent);
    const precondition = await inspectMaterializationDestination({
      destinationPath: destination,
      workspaceRoot: root,
      trackedFileException: false,
      policyAllowsTrackedException: false,
    });
    const receipt = await materializeApprovedPlaintext({
      plaintext: 'SENTINEL_MATERIALIZATION_PLAINTEXT',
      destinationPath: destination,
      workspaceRoot: root,
      mode: '0400',
      expectedAbsence: precondition.expectedAbsence,
      trackedFileException: false,
      policyAllowsTrackedException: false,
    });
    expect(await readFile(destination, 'utf8')).toBe('SENTINEL_MATERIALIZATION_PLAINTEXT');
    expect((await lstat(destination)).mode & 0o777).toBe(0o400);
    expect(JSON.stringify(receipt)).not.toContain('SENTINEL_MATERIALIZATION_PLAINTEXT');
    expect((await readdir(parent)).filter(name => name.startsWith('.sift-materialize-')))
      .toEqual([]);

    await expect(materializeApprovedPlaintext({
      plaintext: 'SHOULD_NOT_REPLACE',
      destinationPath: destination,
      workspaceRoot: root,
      mode: '0400',
      expectedAbsence: true,
      trackedFileException: false,
      policyAllowsTrackedException: false,
    })).rejects.toThrow('Destination appeared');
    expect(await readFile(destination, 'utf8')).toBe('SENTINEL_MATERIALIZATION_PLAINTEXT');
  });

  it('signals commit and reports observed cleanup before returning a receipt', async () => {
    const root = await workspace();
    const parent = path.join(root, 'runtime');
    const destination = path.join(parent, 'materialized-value');
    await mkdir(parent);
    const events: string[] = [];
    const receipt = await materializeApprovedPlaintext({
      plaintext: 'SENTINEL_MATERIALIZATION_PLAINTEXT',
      destinationPath: destination,
      workspaceRoot: root,
      mode: '0600',
      expectedAbsence: true,
      trackedFileException: false,
      policyAllowsTrackedException: false,
      onCommitted: () => events.push('committed'),
      onCleanup: succeeded => events.push(`cleanup:${succeeded}`),
    });
    expect(events).toEqual(['committed', 'cleanup:true']);
    expect(receipt.cleanupSucceeded).toBe(true);
  });

  it('signals an absent-destination commit before any post-link failure', async () => {
    const root = await workspace();
    const parent = path.join(root, 'runtime');
    const destination = path.join(parent, 'materialized-value');
    await mkdir(parent);
    let committed = false;
    let cleanupSucceeded = false;
    await expect(materializeApprovedPlaintext({
      plaintext: 'SENTINEL_MATERIALIZATION_PLAINTEXT',
      destinationPath: destination,
      workspaceRoot: root,
      mode: '0600',
      expectedAbsence: true,
      trackedFileException: false,
      policyAllowsTrackedException: false,
      onCommitted: () => {
        committed = true;
        throw new Error('simulated post-link failure');
      },
      onCleanup: succeeded => {
        cleanupSucceeded = succeeded;
      },
    })).rejects.toThrow('simulated post-link failure');
    expect(committed).toBe(true);
    expect(cleanupSucceeded).toBe(true);
    expect(await readFile(destination, 'utf8')).toBe('SENTINEL_MATERIALIZATION_PLAINTEXT');
    expect((await readdir(parent)).filter(name => name.startsWith('.sift-materialize-')))
      .toEqual([]);
  });

  it('rejects traversal, destination symlinks, and symlinked parent components', async () => {
    const root = await workspace();
    await expect(validateMaterializationPath({
      destinationPath: path.join(root, '..', 'escape'),
      workspaceRoot: root,
    })).rejects.toThrow('inside the workspace');

    const parent = path.join(root, 'runtime');
    await mkdir(parent);
    const target = path.join(root, 'target');
    await writeFile(target, 'safe');
    const destination = path.join(parent, 'materialized-value');
    await symlink(target, destination);
    await expect(validateMaterializationPath({
      destinationPath: destination,
      workspaceRoot: root,
    })).rejects.toThrow(/symlink|special/i);

    await rm(destination);
    const realParent = path.join(root, 'real-parent');
    const linkedParent = path.join(root, 'linked-parent');
    await mkdir(realParent);
    await symlink(realParent, linkedParent);
    await expect(validateMaterializationPath({
      destinationPath: path.join(linkedParent, 'credential'),
      workspaceRoot: root,
    })).rejects.toThrow('symlink');
  });

  it('fails closed on stale digest, unexpected appearance, and cleans temporary files', async () => {
    const root = await workspace();
    const parent = path.join(root, 'runtime');
    const destination = path.join(parent, 'materialized-value');
    await mkdir(parent);
    await writeFile(destination, 'old');
    const precondition = await inspectMaterializationDestination({
      destinationPath: destination,
      workspaceRoot: root,
      trackedFileException: false,
      policyAllowsTrackedException: false,
    });
    await chmod(destination, 0o600);
    await writeFile(destination, 'changed');
    await expect(materializeApprovedPlaintext({
      plaintext: 'SENTINEL_MATERIALIZATION_PLAINTEXT',
      destinationPath: destination,
      workspaceRoot: root,
      mode: '0600',
      expectedAbsence: false,
      expectedDestinationDigest: precondition.expectedDestinationDigest,
      trackedFileException: false,
      policyAllowsTrackedException: false,
    })).rejects.toThrow('digest changed');
    expect(await readFile(destination, 'utf8')).toBe('changed');

    await rm(destination);
    await expect(materializeApprovedPlaintext({
      plaintext: 'SENTINEL_MATERIALIZATION_PLAINTEXT',
      destinationPath: destination,
      workspaceRoot: root,
      mode: '0600',
      expectedAbsence: true,
      trackedFileException: false,
      policyAllowsTrackedException: false,
      beforeCommit: async () => {
        await writeFile(destination, 'attacker');
      },
    })).rejects.toThrow('Destination appeared');
    expect(await readFile(destination, 'utf8')).toBe('attacker');
    expect((await readdir(parent)).filter(name => name.startsWith('.sift-materialize-')))
      .toEqual([]);
  });

  it('denies tracked and secret-risk paths unless approval and local policy both allow', async () => {
    const root = await workspace();
    await execFileAsync('git', ['init', '--quiet'], {cwd: root});
    const destination = path.join(root, 'credential.txt');
    await writeFile(destination, 'placeholder');
    await execFileAsync('git', ['add', 'credential.txt'], {cwd: root});
    await expect(inspectMaterializationDestination({
      destinationPath: destination,
      workspaceRoot: root,
      trackedFileException: false,
      policyAllowsTrackedException: false,
    })).rejects.toThrow('tracked by Git');
    await expect(inspectMaterializationDestination({
      destinationPath: destination,
      workspaceRoot: root,
      trackedFileException: true,
      policyAllowsTrackedException: true,
    })).resolves.toEqual(expect.objectContaining({tracked: true}));
  });

  it('binds wrong runner, path, mode, field-level purpose, and nonce changes', () => {
    const base = {
      materializationId: 'materialization-1',
      sourceEntry: 'entry-1',
      sourceField: 'value',
      runnerFingerprint: 'a'.repeat(64),
      materializerDigest: 'b'.repeat(64),
      destinationPath: '/workspace/runtime/credential',
      workspaceRoot: '/workspace',
      mode: '0600' as const,
      expectedAbsence: true,
      trackedFileException: false,
      purpose: 'Write migration credential',
      nonce: 'n'.repeat(32),
    };
    const expected = createMaterializationCredentialBinding(base);
    for (const changed of [
      {...base, runnerFingerprint: 'c'.repeat(64)},
      {...base, sourceField: 'alternate'},
      {...base, destinationPath: '/workspace/runtime/other'},
      {...base, mode: '0400' as const},
      {...base, purpose: 'Different purpose'},
      {...base, nonce: 'x'.repeat(32)},
    ]) {
      expect(createMaterializationCredentialBinding(changed)).not.toBe(expected);
    }
  });
});

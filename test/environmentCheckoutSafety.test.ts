import {execFileSync} from 'node:child_process';
import {lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {assertDestinationSafeBeforeApproval} from '../src/lib/environmentCheckoutSafety.js';
import {resolveGitCheckout, runReadOnlyGit} from '../src/lib/gitCheckoutContext.js';
import {evaluateGitIgnore} from '../src/lib/gitIgnoreEvaluation.js';

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map(item => rm(item, {recursive: true, force: true}))));

async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sift-env-checkout-')));
  cleanup.push(root);
  execFileSync('git', ['init', '-q'], {cwd: root});
  execFileSync('git', ['config', 'user.email', 'test@siftable.local'], {cwd: root});
  execFileSync('git', ['config', 'user.name', 'Sift Test'], {cwd: root});
  await writeFile(path.join(root, '.gitignore'), '.runtime/\n');
  execFileSync('git', ['add', '.gitignore'], {cwd: root});
  execFileSync('git', ['commit', '-qm', 'fixture'], {cwd: root});
  return root;
}

describe('environment checkout safety', () => {
  it.each(['../escape', '/tmp/escape', '.git/config', 'nested/.git/file', 'bad\\path', 'e\u0301.env'])
  ('rejects adversarial destination %s before approval [AC3] [AC5]', async destination => {
    const root = await fixture();
    await expect(assertDestinationSafeBeforeApproval(root, destination)).rejects.toMatchObject({
      name: 'EnvironmentCheckoutSafetyError',
    });
  });

  it('rejects symlinked and writable ancestors [AC3]', async () => {
    const root = await fixture();
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'sift-env-outside-')));
    cleanup.push(outside);
    await symlink(outside, path.join(root, 'linked'));
    await expect(assertDestinationSafeBeforeApproval(root, 'linked/secret')).rejects.toMatchObject({code: 'symlinked_ancestor'});
    await mkdir(path.join(root, 'writable'));
    await chmod(path.join(root, 'writable'), 0o777);
    await expect(assertDestinationSafeBeforeApproval(root, 'writable/secret')).rejects.toMatchObject({code: 'writable_ancestor'});
  });

  it('reports the effective winning ignore rule and tracked failure without index mutation [AC4]', async () => {
    const root = await fixture();
    await mkdir(path.join(root, '.runtime'));
    const index = path.join(root, '.git', 'index');
    const before = await lstat(index);
    const ignored = await evaluateGitIgnore(root, '.runtime/service.env');
    expect(ignored).toMatchObject({covered: true, strength: 'strong'});
    if (ignored.covered) expect(ignored.rule).toEqual(expect.objectContaining({pattern: '.runtime/'}));
    const after = await lstat(index);
    expect(after.mtimeNs).toBe(before.mtimeNs);

    await writeFile(path.join(root, 'tracked.env'), 'placeholder');
    execFileSync('git', ['add', '-f', 'tracked.env'], {cwd: root});
    expect(await evaluateGitIgnore(root, 'tracked.env')).toMatchObject({tracked: true, covered: false});
  });

  it('honors a winning negation and rejects case-fold collisions [AC4] [AC5]', async () => {
    const root = await fixture();
    await writeFile(path.join(root, '.gitignore'), '.runtime/*\n!.runtime/allowed.env\n');
    await mkdir(path.join(root, '.runtime'));
    await writeFile(path.join(root, '.runtime', 'Existing.env'), 'placeholder');
    expect(await evaluateGitIgnore(root, '.runtime/allowed.env')).toMatchObject({covered: false});
    await expect(assertDestinationSafeBeforeApproval(root, '.runtime/existing.env'))
      .rejects.toMatchObject({code: 'case_collision'});
  });

  it('does not classify an NFD on-disk spelling of the same NFC segment as a case collision [AC5]', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'e\u0301.env'), 'placeholder');
    await expect(assertDestinationSafeBeforeApproval(root, '\u00e9.env')).resolves.toMatchObject({
      relativeDestination: '\u00e9.env',
    });
  });

  it('marks global-only ignores weak [AC4] [AC5]', async () => {
    const root = await fixture();
    await writeFile(path.join(root, '.gitignore'), '');
    const globalIgnore = path.join(root, 'global-ignore');
    await writeFile(globalIgnore, 'global.env\n');
    const result = await evaluateGitIgnore(root, 'global.env', {GIT_CONFIG_GLOBAL: globalIgnore + '.config'});
    // A missing hermetic config means no accidental host global ignore is consulted.
    expect(result).toMatchObject({covered: false});
    execFileSync('git', ['config', '--file', globalIgnore + '.config', 'core.excludesFile', globalIgnore]);
    expect(await evaluateGitIgnore(root, 'global.env', {GIT_CONFIG_GLOBAL: globalIgnore + '.config'}))
      .toMatchObject({covered: true, strength: 'weak'});
  });

  it('classifies main, linked, submodule, bare, and non-Git contexts deterministically [AC5]', async () => {
    const root = await fixture();
    expect(await resolveGitCheckout(root)).toMatchObject({kind: 'main_worktree'});
    const linked = `${root}-linked`;
    cleanup.push(linked);
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'linked-test', linked], {cwd: root});
    expect(await resolveGitCheckout(linked)).toMatchObject({kind: 'linked_worktree'});

    const bare = `${root}-bare`;
    cleanup.push(bare);
    execFileSync('git', ['clone', '-q', '--bare', root, bare]);
    expect(await resolveGitCheckout(bare)).toMatchObject({kind: 'bare'});
    const plain = await realpath(await mkdtemp(path.join(tmpdir(), 'sift-env-plain-')));
    cleanup.push(plain);
    expect(await resolveGitCheckout(plain)).toEqual({kind: 'not_a_repository'});

    const parent = await fixture();
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', root, 'child'], {cwd: parent});
    expect(await resolveGitCheckout(path.join(parent, 'child'))).toMatchObject({kind: 'submodule'});
  });

  it('allowlists read-only Git primitives [AC4]', async () => {
    const root = await fixture();
    await expect(runReadOnlyGit(root, ['add', '.'])).rejects.toThrow('read-only allowlist');
  });
});

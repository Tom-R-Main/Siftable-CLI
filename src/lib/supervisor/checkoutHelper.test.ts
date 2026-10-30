import {execFileSync} from 'node:child_process';
import {mkdtempSync, promises as fs, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {admitBase, buildPatch, CheckoutRefused, checkGit, checkTree, fetchBase, frozenChanges, type Git, gitEnvironment, hostGit, INSTALL_LOG,
  materialize, materializeVerify, NPM_CI_ARGS, writeResultCommit, hostNpm, type Npm, PATCH_FILE, pinBase, repoPath, resolveFrozen, runInstall} from './checkoutHelper.js';

/** Fixture setup uses plain git; the code under test uses only the controlled environment. */
const plain = (cwd: string, ...args: string[]) => execFileSync('git', args, {cwd, env: {...process.env, GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'}}).toString().trim();

let root: string;
let fixture: string;
let base: string;
const LF = 'export const a = 1;\nexport const b = 2;\n';

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'sift-checkout-'));
  fixture = path.join(root, 'fixture');
  await fs.mkdir(path.join(fixture, 'src', 'lib'), {recursive: true});
  await fs.mkdir(path.join(fixture, 'test'), {recursive: true});
  await fs.writeFile(path.join(fixture, 'src', 'lib', 'a.ts'), LF);
  await fs.writeFile(path.join(fixture, 'test', 'a.test.ts'), 'test\n');
  await fs.writeFile(path.join(fixture, 'notes.txt'), 'n\n');
  // Attributes that would rewrite bytes or run a driver if attributes were read.
  await fs.writeFile(path.join(fixture, '.gitattributes'), '* text eol=crlf\n*.ts filter=planted diff=planted\n');
  await fs.symlink('test', path.join(fixture, 'linked'));
  plain(fixture, 'init', '--quiet');
  plain(fixture, 'add', '-A');
  // A submodule entry; its commit need not exist here.
  plain(fixture, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},vendored`);
  plain(fixture, 'commit', '--quiet', '-m', 'base');
  base = plain(fixture, 'rev-parse', 'HEAD');
});

afterAll(async () => { await fs.rm(root, {recursive: true, force: true}); });

/** A fresh /src holding the fixture's objects, as the fetch would leave it, and a fresh home for the controlled git. */
async function staged(name: string): Promise<{git: Git; src: string; work: string}> {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'home'), {recursive: true});
  const src = path.join(dir, 'src');
  plain(root, 'clone', '--quiet', '--bare', '--no-hardlinks', fixture, src);
  const git = hostGit(path.join(dir, 'home'));
  await pinBase(git, src, base);
  return {git, src, work: path.join(dir, 'work')};
}

const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => (error as CheckoutRefused).code);

describe('checkout helper', () => {
  it('runs on this git with a working --attr-source', async () => {
    await expect(checkGit(hostGit(path.join(root, 'h0')), await fs.mkdtemp(path.join(root, 'probe-')))).resolves.toBeUndefined();
  });

  it('carries every control in the environment, with no config files to read', () => {
    const env = gitEnvironment('/tmp/h');
    expect(env).toMatchObject({GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '9', HOME: '/tmp/h'});
    const pairs = Array.from({length: 9}, (_, i) => `${env[`GIT_CONFIG_KEY_${i}`]}=${env[`GIT_CONFIG_VALUE_${i}`]}`);
    expect(pairs).toEqual(expect.arrayContaining(['protocol.allow=never', 'protocol.https.allow=always', 'http.followRedirects=false',
      'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'credential.helper=']));
  });

  it('refuses to fetch over any transport but https', async () => {
    const git = hostGit(path.join(root, 'h1'));
    await fs.mkdir(path.join(root, 'h1'), {recursive: true});
    for (const [i, url] of [`file://${fixture}`, fixture, 'http://127.0.0.1:9/x', 'git://127.0.0.1:9/x'].entries()) {
      expect(await refusal(fetchBase(git, path.join(root, `fetch-${i}`), url, base)), url).toBe('checkout_failed');
    }
  });

  it('admits the base by its exact blob bytes and entry count', async () => {
    const {git, src} = await staged('admit');
    const admitted = await admitBase(git, src, base, ['src/lib', 'test']);
    // Three trees, five blobs (the symlink is a blob), one submodule.
    expect(admitted.entries).toBe(9);
    expect(admitted.blobBytes).toBe(Buffer.byteLength(LF) + 'test\n'.length + 'n\n'.length
      + '* text eol=crlf\n*.ts filter=planted diff=planted\n'.length + 'test'.length);
  });

  it('refuses a scope through a symlink, a submodule, a file or a missing directory', async () => {
    const {git, src} = await staged('scopes');
    expect(await refusal(admitBase(git, src, base, ['linked']))).toBe('scope_invalid');
    expect(await refusal(admitBase(git, src, base, ['vendored']))).toBe('scope_invalid');
    expect(await refusal(admitBase(git, src, base, ['notes.txt']))).toBe('scope_invalid');
    expect(await refusal(admitBase(git, src, base, ['src/new']))).toBe('scope_invalid');
    expect(await refusal(admitBase(git, src, base, ['src/lib/a.ts']))).toBe('scope_invalid');
  });

  it('checks out byte-identical to the blobs, ignoring every attribute, at exactly the base', async () => {
    const {git, src, work} = await staged('materialize');
    await materialize(git, src, work, base, ['src/lib', 'test']);
    expect(readFileSync(path.join(work, 'src', 'lib', 'a.ts'), 'utf8')).toBe(LF);
    expect(plain(work, 'rev-parse', 'HEAD')).toBe(base);
    expect((await fs.lstat(path.join(work, 'linked'))).isSymbolicLink()).toBe(true);
  });

  it('refuses a checkout whose scope is not a real directory on disk', async () => {
    const {git, src, work} = await staged('ondisk');
    // admitBase would refuse this first; the on-disk check is the second line.
    expect(await refusal(materialize(git, src, work, base, ['linked']))).toBe('scope_invalid');
  });

  describe('patch', () => {
    /** A checkout the writer has worked in, and an output directory on the attempt filesystem. */
    async function written(name: string) {
      const {git, src, work} = await staged(name);
      await materialize(git, src, work, base, ['src/lib', 'test']);
      const out = path.join(root, name, 'out');
      await fs.mkdir(out);
      return {git, work, out};
    }

    it('is only its header, but still written, when the writer changed nothing', async () => {
      const {git, work, out} = await written('p-empty');
      const header = `# sift patch v1: base ${base}, write scope ["src/lib"]\n`;
      expect(await buildPatch(git, work, out, base, ['src/lib'])).toEqual({bytes: header.length, changed: []});
      // Never empty, so its digest cannot match an empty log's (V502 requires distinct digests).
      expect(readFileSync(path.join(out, PATCH_FILE), 'utf8')).toBe(header);
    });

    it('holds exactly the write scope\'s changes, binary included, and applies to the base', async () => {
      const {git, work, out} = await written('p-scope');
      await fs.writeFile(path.join(work, 'src', 'lib', 'a.ts'), 'export const a = 3;\n');
      await fs.writeFile(path.join(work, 'src', 'lib', 'new.ts'), 'export {};\n');
      await fs.writeFile(path.join(work, 'src', 'lib', 'bin.dat'), Buffer.from([0, 1, 2, 255]));
      await fs.rm(path.join(work, 'test', 'a.test.ts'));
      // Outside the scope given to the patch: never in it.
      await fs.writeFile(path.join(work, 'notes.txt'), 'changed\n');
      expect((await buildPatch(git, work, out, base, ['src/lib'])).changed).toEqual(['src/lib/a.ts', 'src/lib/bin.dat', 'src/lib/new.ts']);
      const patch = readFileSync(path.join(out, PATCH_FILE), 'utf8');
      expect(patch).toContain('src/lib/a.ts');
      expect(patch).toContain('src/lib/new.ts');
      expect(patch).toContain('GIT binary patch');
      expect(patch).not.toContain('notes.txt');
      expect(patch).not.toContain('a.test.ts');
      const fresh = path.join(root, 'p-scope', 'fresh');
      plain(root, 'clone', '--quiet', fixture, fresh);
      // Applied to the index, which holds blob bytes; plain git would rewrite the work tree by the fixture's eol rule.
      plain(fresh, 'apply', '--cached', '--binary', path.join(out, PATCH_FILE));
      expect(plain(fresh, 'show', ':src/lib/a.ts')).toBe('export const a = 3;');
    });

    it('never reads the writer\'s git directory: planted fsmonitor, hooks, filters and textconv do not run', async () => {
      const {git, work, out} = await written('p-traps');
      const marker = path.join(root, 'p-traps', 'ran');
      const touch = `touch ${marker}`;
      for (const [key, value] of [['core.fsmonitor', touch], ['core.hooksPath', path.join(root, 'p-traps')], ['filter.planted.clean', touch],
        ['filter.planted.smudge', touch], ['diff.planted.textconv', touch], ['diff.external', touch]]) {
        plain(work, 'config', key, value);
      }
      await fs.writeFile(path.join(root, 'p-traps', 'pre-commit'), `#!/bin/sh\n${touch}\n`, {mode: 0o755});
      await fs.writeFile(path.join(work, '.git', 'info', 'attributes'), '* filter=planted diff=planted\n');
      await fs.writeFile(path.join(work, 'src', 'lib', 'a.ts'), 'export const a = 4;\n');
      await buildPatch(git, work, out, base, ['src/lib']);
      expect(readFileSync(path.join(out, PATCH_FILE), 'utf8')).toContain('export const a = 4;');
      await expect(fs.access(marker)).rejects.toThrow();
    });

    it('refuses a patch over its cap and leaves no partial file', async () => {
      const {git, work, out} = await written('p-cap');
      await fs.writeFile(path.join(work, 'src', 'lib', 'big.txt'), 'x'.repeat(10_000));
      expect(await refusal(buildPatch(git, work, out, base, ['src/lib'], 1_000))).toBe('patch_too_large');
      await expect(fs.access(path.join(out, PATCH_FILE))).rejects.toThrow();
    });
  });

  describe('install', () => {
    const PROXY = 'http://sift-a-r1-proxy:3128';
    async function build(name: string) {
      const dir = path.join(root, name);
      await fs.mkdir(path.join(dir, 'build'), {recursive: true});
      await fs.writeFile(path.join(dir, 'build', 'package.json'), JSON.stringify({name: 'w', version: '1.0.0'}));
      await fs.writeFile(path.join(dir, 'build', 'package-lock.json'),
        JSON.stringify({name: 'w', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {'': {name: 'w', version: '1.0.0'}}}));
      return {build: path.join(dir, 'build'), home: path.join(dir, 'home')};
    }

    it('runs npm ci with scripts off, dev included, and an environment that inherits nothing', async () => {
      const paths = await build('i-args');
      const seen: Array<{args: string[]; cwd: string; env: NodeJS.ProcessEnv}> = [];
      const configs: string[] = [];
      const npm: Npm = async (args, options) => {
        seen.push({args, cwd: options.cwd, env: options.env});
        for (const file of [options.env.npm_config_userconfig!, options.env.npm_config_globalconfig!]) configs.push(await fs.readFile(file, 'utf8'));
        await fs.mkdir(path.join(options.cwd, 'node_modules'));
        await fs.mkdir(options.env.npm_config_cache!, {recursive: true});
        return 0;
      };
      process.env.NODE_ENV = 'production';
      try {
        expect(await runInstall(paths, PROXY, npm)).toEqual({ok: true});
      } finally {
        delete process.env.NODE_ENV;
      }
      expect(seen[0].args).toEqual(NPM_CI_ARGS);
      // Two distinct, existing, empty configs: npm refuses one file for both, and nothing may set the registry or scripts.
      expect(configs).toEqual(['', '']);
      expect(seen[0].env.npm_config_userconfig).not.toBe(seen[0].env.npm_config_globalconfig);
      expect(NPM_CI_ARGS).toEqual(expect.arrayContaining(['ci', '--ignore-scripts', '--include=dev']));
      expect(seen[0].cwd).toBe(paths.build);
      expect(seen[0].env.NODE_ENV).toBeUndefined();
      expect(seen[0].env).toMatchObject({npm_config_userconfig: path.join(paths.home, '.npmrc-user'),
        npm_config_globalconfig: path.join(paths.home, '.npmrc-global'),
        npm_config_registry: 'https://registry.npmjs.org/', npm_config_ignore_scripts: 'true', npm_config_https_proxy: PROXY});
      // The cache never stays in the deps volume the writer will see.
      await expect(fs.access(path.join(paths.build, '.npm-cache'))).rejects.toThrow();
    });

    it('refuses without a proxy, without the admitted manifests, or when npm ci fails', async () => {
      const ok: Npm = async (_args, options) => { await fs.mkdir(path.join(options.cwd, 'node_modules')); return 0; };
      expect(await runInstall(await build('i-noproxy'), '', ok)).toMatchObject({ok: false, code: 'dependency_install_failed'});
      expect(await runInstall(await build('i-badproxy'), 'http://evil.example:3128/?x', ok)).toMatchObject({ok: false});
      const missing = await build('i-missing');
      await fs.rm(path.join(missing.build, 'package-lock.json'));
      expect(await runInstall(missing, PROXY, ok)).toMatchObject({ok: false, detail: expect.stringContaining('package-lock.json')});
      expect(await runInstall(await build('i-fails'), PROXY, async () => 1)).toMatchObject({ok: false, detail: expect.stringContaining('exited 1')});
      const linked = await build('i-linked');
      expect(await runInstall(linked, PROXY, async (_args, options) => { await fs.symlink('/etc', path.join(options.cwd, 'node_modules')); return 0; }))
        .toMatchObject({ok: false, detail: expect.stringContaining('not a directory')});
    });

    it('works with the real npm and this exact environment, writing its output to the log', async () => {
      const paths = await build('i-real');
      // Only PATH differs from the container (npm lives elsewhere on this host); every npm setting is the real one.
      const npm: Npm = (args, options) => hostNpm(args, {...options, env: {...options.env, PATH: process.env.PATH}});
      expect(await runInstall(paths, 'http://127.0.0.1:9', npm)).toEqual({ok: true});
      expect((await fs.stat(path.join(paths.build, 'node_modules'))).isDirectory()).toBe(true);
      await expect(fs.access(path.join(paths.build, INSTALL_LOG))).resolves.toBeUndefined();
    }, 60_000);
  });
  describe('verify', () => {
    /** A writer checkout with a change in src/lib and its patch, as the verifier receives them. */
    async function patched(name: string) {
      const {git, src, work} = await staged(name);
      await materialize(git, src, work, base, ['src/lib', 'test']);
      await fs.writeFile(path.join(work, 'src', 'lib', 'a.ts'), 'export const a = 3;\n');
      await fs.writeFile(path.join(work, 'test', 'a.test.ts'), 'weakened\n');
      const out = path.join(root, name, 'out');
      await fs.mkdir(out);
      const {changed} = await buildPatch(git, work, out, base, ['src/lib', 'test']);
      const file = path.join(out, PATCH_FILE);
      const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
      return {git, objects: path.join(work, '.git', 'objects'), changed, patch: {file, sha256}, runs: path.join(root, name, 'verify')};
    }

    it('materializes the base exactly, checked against the base tree, with its own git directory', async () => {
      const {git, objects, runs} = await patched('v-base');
      await fs.mkdir(runs);
      const {treeId, env} = await materializeVerify(git, objects, path.join(runs, 'base'), base);
      expect(treeId).toBe(plain(fixture, 'rev-parse', `${base}^{tree}`));
      // Blob bytes, not the fixture's eol=crlf rule; the patch's change is not there.
      expect(readFileSync(path.join(runs, 'base', 'src', 'src', 'lib', 'a.ts'), 'utf8')).toBe(LF);
      expect(readFileSync(path.join(runs, 'base', 'src', 'test', 'a.test.ts'), 'utf8')).toBe('test\n');
      expect(await checkTree(git, env, env.GIT_WORK_TREE as string, treeId)).toEqual([]);
    });

    it('applies the frozen patch only by its digest, and records the patched tree', async () => {
      const {git, objects, patch, runs} = await patched('v-patch');
      await fs.mkdir(runs);
      const {treeId} = await materializeVerify(git, objects, path.join(runs, 'selected'), base, patch);
      expect(treeId).not.toBe(plain(fixture, 'rev-parse', `${base}^{tree}`));
      expect(readFileSync(path.join(runs, 'selected', 'src', 'src', 'lib', 'a.ts'), 'utf8')).toBe('export const a = 3;\n');
      const wrong = materializeVerify(git, objects, path.join(runs, 'wrong'), base, {...patch, sha256: '0'.repeat(64)});
      expect(await refusal(wrong)).toBe('patch_apply_failed');
      await fs.writeFile(path.join(root, 'v-patch', 'bad.patch'), 'diff --git a/nope b/nope\n--- a/nope\n+++ b/nope\n@@ -1 +1 @@\n-x\n+y\n');
      const bad = path.join(root, 'v-patch', 'bad.patch');
      const badSha = createHash('sha256').update(readFileSync(bad)).digest('hex');
      expect(await refusal(materializeVerify(git, objects, path.join(runs, 'bad'), base, {file: bad, sha256: badSha}))).toBe('patch_apply_failed');
    });

    it('finds every tracked change after a run, and ignores untracked files', async () => {
      const {git, objects, runs} = await patched('v-tree');
      await fs.mkdir(runs);
      const fresh = async (name: string) => {
        const dir = path.join(runs, name);
        const {treeId, env} = await materializeVerify(git, objects, dir, base);
        return {tree: path.join(dir, 'src'), check: () => checkTree(git, env, path.join(dir, 'src'), treeId)};
      };
      const untracked = await fresh('untracked');
      await fs.mkdir(path.join(untracked.tree, 'node_modules', '.cache'), {recursive: true});
      await fs.writeFile(path.join(untracked.tree, 'coverage.json'), '{}');
      expect(await untracked.check()).toEqual([]);
      const edited = await fresh('edited');
      await fs.writeFile(path.join(edited.tree, 'src', 'lib', 'a.ts'), 'export const a = 9;\n');
      expect(await edited.check()).toEqual(['src/lib/a.ts']);
      const sameSize = await fresh('same-size');
      await fs.writeFile(path.join(sameSize.tree, 'notes.txt'), 'm\n');
      expect(await sameSize.check()).toEqual(['notes.txt']);
      const deleted = await fresh('deleted');
      await fs.rm(path.join(deleted.tree, 'test', 'a.test.ts'));
      expect(await deleted.check()).toEqual(['test/a.test.ts']);
      const chmod = await fresh('chmod');
      await fs.chmod(path.join(chmod.tree, 'notes.txt'), 0o755);
      expect(await chmod.check()).toEqual(['notes.txt']);
      const relinked = await fresh('relinked');
      await fs.rm(path.join(relinked.tree, 'linked'));
      await fs.symlink('src', path.join(relinked.tree, 'linked'));
      expect(await relinked.check()).toEqual(['linked']);
      // A directory swapped for a symlink to an identical copy still fails: every prefix must be a real directory.
      const swapped = await fresh('swapped');
      await fs.rename(path.join(swapped.tree, 'test'), path.join(swapped.tree, 'test-copy'));
      await fs.symlink('test-copy', path.join(swapped.tree, 'test'));
      expect(await swapped.check()).toEqual(['test/a.test.ts']);
    });

    it('resolves the frozen set against the base tree, ignoring selector words, refusing unknown named paths', async () => {
      const {git, objects, runs} = await patched('v-frozen');
      await fs.mkdir(runs);
      const {env} = await materializeVerify(git, objects, path.join(runs, 'base'), base);
      const frozen = await resolveFrozen(git, env, base, [{path: '/workspace/test/a.test.ts', source: 'files'},
        {path: 'test', source: 'selector'}, {path: 'adds', source: 'selector'}, {path: '--grep', source: 'selector'}]);
      expect(frozen).toEqual([{path: 'test', kind: 'dir'}, {path: 'test/a.test.ts', kind: 'file'}]);
      for (const bad of ['linked', 'missing.ts', '../x', 'linked/a.test.ts', 'vendored', '.git/config']) {
        expect(await refusal(resolveFrozen(git, env, base, [{path: bad, source: 'files'}])), bad).toBe('frozen_path_invalid');
        expect(await refusal(resolveFrozen(git, env, base, [{path: bad, source: 'report'}])), bad).toBe('frozen_path_invalid');
      }
      expect(await refusal(resolveFrozen(git, env, base, [{path: 'adds', source: 'selector'}]))).toBe('frozen_tests_unknown');
    });

    // Release on #1384: a path list past the bound is refused with its own code, never truncated.
    it('refuses a changed-path list or frozen set past its serialized bound', async () => {
      const {git, src, work} = await staged('v-bound');
      await materialize(git, src, work, base, ['src/lib', 'test']);
      await fs.writeFile(path.join(work, 'src', 'lib', 'a.ts'), 'export const a = 3;\n');
      const out = path.join(root, 'v-bound', 'out');
      await fs.mkdir(out);
      // ["src/lib/a.ts"] is 16 bytes.
      expect((await buildPatch(git, work, out, base, ['src/lib'], undefined, 16)).changed).toEqual(['src/lib/a.ts']);
      expect(await refusal(buildPatch(git, work, out, base, ['src/lib'], undefined, 15))).toBe('patch_too_many_paths');
      const {objects, runs} = {objects: path.join(work, '.git', 'objects'), runs: path.join(root, 'v-bound', 'verify')};
      const {env} = await materializeVerify(git, objects, path.join(runs, 'base'), base);
      const candidates = [{path: 'test', source: 'files' as const}];
      expect(await resolveFrozen(git, env, base, candidates, 100)).toEqual([{path: 'test', kind: 'dir'}]);
      expect(await refusal(resolveFrozen(git, env, base, candidates, 10))).toBe('frozen_path_invalid');
    });

    // U3-2 contract rev 2 R-D3/R9: the reviewer sees the base and result through the git directory alone.
    it('writes a deterministic result commit whose whole closure a reader reaches through the alternates file alone', async () => {
      const {git, objects, patch, runs} = await patched('v-result');
      await fs.mkdir(runs);
      const {treeId, env} = await materializeVerify(git, objects, path.join(runs, 'selected'), base, patch);
      const head = await writeResultCommit(git, env, treeId, base, objects);
      // The same tree gives the same head, wherever it is committed.
      const {treeId: sameTree, env: other} = await materializeVerify(git, objects, path.join(runs, 'again'), base, patch);
      expect(await writeResultCommit(git, other, sameTree, base, objects)).toBe(head);
      // The reader: only GIT_DIR and GIT_WORK_TREE, no alternates variable.
      const reader = {GIT_DIR: env.GIT_DIR, GIT_WORK_TREE: env.GIT_WORK_TREE, GIT_INDEX_FILE: env.GIT_INDEX_FILE};
      const read = (args: string[]) => git(args, {env: reader});
      const blob = (spec: string) => plain(fixture, 'rev-parse', spec);
      for (const object of [base, head, `${head}^{tree}`, blob(`${base}:notes.txt`)]) {
        expect((await read(['cat-file', '-e', object])).code, object).toBe(0);
      }
      const changed = (await read(['rev-parse', `${head}:src/lib/a.ts`])).stdout.toString().trim();
      expect(changed).not.toBe(blob(`${base}:src/lib/a.ts`));
      expect((await read(['cat-file', '-p', changed])).stdout.toString()).toBe('export const a = 3;\n');
      expect((await read(['merge-base', base, head])).stdout.toString().trim()).toBe(base);
      expect((await read(['rev-parse', 'HEAD'])).stdout.toString().trim()).toBe(head);
      expect((await read(['log', '-1', '--format=%an %ae %at %P', head])).stdout.toString().trim()).toBe(`sift sift@localhost 0 ${base}`);
      // Release R11: a process that starts in the tree with no git variables at all (the review's pre-pass and ratchet)
      // finds the repository through the gitfile and reads the head's file list and the base.
      const tree = env.GIT_WORK_TREE as string;
      const bare = (args: string[]) => git(args, {cwd: tree, env: {GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined}});
      expect((await bare(['rev-parse', 'HEAD'])).stdout.toString().trim()).toBe(head);
      expect((await bare(['rev-parse', '--show-toplevel'])).stdout.toString().trim()).toBe(await fs.realpath(tree));
      expect((await bare(['ls-tree', '-r', '--name-only', head])).stdout.toString()).toContain('src/lib/a.ts');
      expect((await bare(['cat-file', '-e', base])).code).toBe(0);
      expect((await bare(['status', '--porcelain', '--untracked-files=no'])).stdout.toString()).toBe('');
      // Without the alternates file the base commit is out of reach.
      await fs.rm(path.join(env.GIT_DIR as string, 'objects', 'info', 'alternates'));
      expect((await read(['cat-file', '-e', base])).code).not.toBe(0);
    });

    it('names the changed paths that are frozen', async () => {
      const {changed} = await patched('v-changes');
      expect(changed).toEqual(['src/lib/a.ts', 'test/a.test.ts']);
      expect(frozenChanges(changed, [{path: 'test', kind: 'dir'}])).toEqual(['test/a.test.ts']);
      expect(frozenChanges(changed, [{path: 'test/a.test.ts', kind: 'file'}])).toEqual(['test/a.test.ts']);
      expect(frozenChanges(['testing/x.ts', 'test.ts'], [{path: 'test', kind: 'dir'}])).toEqual([]);
      expect(repoPath('./test//a.ts')).toBeUndefined();
      expect(repoPath('./test/a.ts/')).toBe('test/a.ts');
    });
  });
});

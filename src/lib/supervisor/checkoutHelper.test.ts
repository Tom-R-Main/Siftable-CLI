import {execFileSync} from 'node:child_process';
import {mkdtempSync, promises as fs, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {admitBase, buildPatch, CheckoutRefused, checkGit, fetchBase, type Git, gitEnvironment, hostGit, materialize, PATCH_FILE, pinBase} from './checkoutHelper.js';

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
      expect(await buildPatch(git, work, out, base, ['src/lib'])).toEqual({bytes: header.length});
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
      await buildPatch(git, work, out, base, ['src/lib']);
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
});

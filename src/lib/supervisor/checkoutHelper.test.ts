import {execFileSync} from 'node:child_process';
import {mkdtempSync, promises as fs, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {admitBase, CheckoutRefused, checkGit, fetchBase, type Git, gitEnvironment, hostGit, materialize, pinBase} from './checkoutHelper.js';

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
});

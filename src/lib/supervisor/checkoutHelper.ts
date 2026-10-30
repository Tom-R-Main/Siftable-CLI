/**
 * The checkout helper's entrypoint (first-run U5b-2c, checkout contract rev
 * 5), run with the image's node from a read-only mount, as uid 10001, on a
 * bridge of its own. It fetches the plan's base commit into /src, admits it
 * (size, entry count, write scope against the base tree), checks it out into
 * /workspace and verifies the result. It never runs repository code: git has
 * no system, global or repository config to read, hooks point at /dev/null,
 * and `--attr-source` is the empty tree, so no attribute (eol, encoding,
 * filter, diff) applies. Self-contained: Node built-ins only.
 *
 * Output is one JSON line on stdout. Exit 0 means the checkout is ready.
 */
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const MAX_BLOB_BYTES = 2 * 1024 ** 3;
export const MAX_ENTRIES = 200_000;
const MIN_GIT: [number, number] = [2, 41];

/** Every git process gets these, so no invocation can miss a control. */
export function gitEnvironment(home: string): NodeJS.ProcessEnv {
  const controls: Array<[string, string]> = [
    ['protocol.allow', 'never'], ['protocol.https.allow', 'always'], ['credential.helper', ''],
    ['http.followRedirects', 'false'], ['fetch.recurseSubmodules', 'false'], ['submodule.recurse', 'false'],
    ['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ['core.symlinks', 'true'],
  ];
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', GIT_CONFIG_COUNT: String(controls.length),
    ...Object.fromEntries(controls.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])),
  };
}

export type Git = (args: string[], options?: {cwd?: string}) => Promise<{code: number; stdout: Buffer; stderr: string}>;

export function hostGit(home: string): Git {
  return (args, options = {}) => new Promise((resolve) => {
    const child = spawn('git', ['--attr-source', EMPTY_TREE, ...args], {cwd: options.cwd ?? '/', env: gitEnvironment(home),
      stdio: ['ignore', 'pipe', 'pipe']});
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => { if (err.length < 8192) err += chunk.toString(); });
    child.once('error', (error) => resolve({code: 127, stdout: Buffer.alloc(0), stderr: error.message}));
    child.once('close', (code) => resolve({code: code ?? 1, stdout: Buffer.concat(out), stderr: err}));
  });
}

export class CheckoutRefused extends Error {
  constructor(readonly code: string, detail: string) {
    super(detail);
  }
}

async function must(git: Git, code: string, args: string[], options?: {cwd?: string}): Promise<Buffer> {
  const result = await git(args, options);
  if (result.code !== 0) throw new CheckoutRefused(code, `git ${args[0]} exited ${result.code}: ${result.stderr.trim().slice(0, 500)}`);
  return result.stdout;
}

/** git 2.41 or later, and `--attr-source` must actually work, not just parse. */
export async function checkGit(git: Git, scratch: string): Promise<void> {
  const version = (await must(git, 'image_git_too_old', ['version'])).toString();
  const match = /git version (\d+)\.(\d+)/.exec(version);
  const [major, minor] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) throw new CheckoutRefused('image_git_too_old', version.trim());
  const probe = path.join(scratch, 'probe');
  await must(git, 'image_git_too_old', ['init', '--quiet', probe]);
  await must(git, 'image_git_too_old', ['check-attr', '--all', '--', 'probe'], {cwd: probe});
}

/** Fetches exactly the base commit into a fresh bare repository and pins it as the only branch. */
export async function fetchBase(git: Git, src: string, url: string, baseSha: string): Promise<void> {
  await must(git, 'checkout_failed', ['init', '--quiet', '--bare', src]);
  await must(git, 'checkout_failed', ['--git-dir', src, 'fetch', '--quiet', '--depth=1', '--no-tags', url, baseSha]);
  await pinBase(git, src, baseSha);
}

export async function pinBase(git: Git, src: string, baseSha: string): Promise<void> {
  await must(git, 'checkout_failed', ['--git-dir', src, 'cat-file', '-e', `${baseSha}^{commit}`]);
  await must(git, 'checkout_failed', ['--git-dir', src, 'update-ref', 'refs/heads/sift-base', baseSha]);
  await must(git, 'checkout_failed', ['--git-dir', src, 'symbolic-ref', 'HEAD', 'refs/heads/sift-base']);
}

const TREE = '040000';

/**
 * Admits the base before anything is checked out. With no attributes or
 * filters, checkout writes exactly the blob bytes listed here. Every prefix
 * of every write scope must be a directory in the base tree: a symlink, file,
 * submodule or missing path anywhere along it is refused.
 */
export async function admitBase(git: Git, src: string, baseSha: string, writeScope: string[]): Promise<{blobBytes: number; entries: number}> {
  const listing = await must(git, 'checkout_failed', ['--git-dir', src, 'ls-tree', '-r', '-t', '-l', '-z', '--full-tree', baseSha]);
  const modes = new Map<string, string>();
  let blobBytes = 0;
  let entries = 0;
  for (const record of listing.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, , size] = record.slice(0, tab).split(/\s+/);
    modes.set(record.slice(tab + 1), mode);
    entries += 1;
    if (type === 'blob') blobBytes += Number(size);
  }
  if (entries > MAX_ENTRIES) throw new CheckoutRefused('checkout_too_large', `${entries} entries; at most ${MAX_ENTRIES}`);
  if (blobBytes > MAX_BLOB_BYTES) throw new CheckoutRefused('checkout_too_large', `${blobBytes} bytes; at most ${MAX_BLOB_BYTES}`);
  for (const scope of writeScope) {
    const segments = scope.split('/');
    for (let i = 1; i <= segments.length; i += 1) {
      const prefix = segments.slice(0, i).join('/');
      const mode = modes.get(prefix);
      if (mode !== TREE) {
        throw new CheckoutRefused('scope_invalid', `${scope}: ${prefix} is ${mode === undefined ? 'missing' : mode === '120000' ? 'a symlink'
          : mode === '160000' ? 'a submodule' : 'not a directory'} at the base commit`);
      }
    }
  }
  return {blobBytes, entries};
}

/** Checks the pinned base out into the work volume and verifies the result on disk. */
export async function materialize(git: Git, src: string, work: string, baseSha: string, writeScope: string[]): Promise<void> {
  // The only invocation that may use the file transport, and only from the literal source path.
  await must(git, 'checkout_failed', ['-c', 'protocol.file.allow=always', 'clone', '--quiet', '--no-checkout', '--no-hardlinks', src, work]);
  await must(git, 'checkout_failed', ['checkout', '--quiet', '--detach', baseSha], {cwd: work});
  const head = (await must(git, 'checkout_failed', ['rev-parse', 'HEAD'], {cwd: work})).toString().trim();
  if (head !== baseSha) throw new CheckoutRefused('checkout_failed', `HEAD is ${head}, not the base`);
  for (const scope of writeScope) {
    const segments = scope.split('/');
    for (let i = 1; i <= segments.length; i += 1) {
      const stat = await fs.lstat(path.join(work, ...segments.slice(0, i))).catch(() => null);
      if (!stat?.isDirectory()) throw new CheckoutRefused('scope_invalid', `${scope} is not a real directory in the checkout`);
    }
  }
}

export interface CheckoutRequest {repositoryUrl: string; baseSha: string; writeScope: string[]}

export async function runCheckout(request: CheckoutRequest, paths = {src: '/src', work: '/workspace', home: '/tmp/h'},
  git: Git = hostGit(paths.home)): Promise<Record<string, unknown>> {
  try {
    await fs.mkdir(paths.home, {recursive: true});
    await checkGit(git, paths.home);
    await fetchBase(git, paths.src, request.repositoryUrl, request.baseSha);
    const admitted = await admitBase(git, paths.src, request.baseSha, request.writeScope);
    await materialize(git, paths.src, paths.work, request.baseSha, request.writeScope);
    // The objects now live in the checkout; the fetched copy's space goes back to the attempt.
    for (const entry of await fs.readdir(paths.src)) await fs.rm(path.join(paths.src, entry), {recursive: true, force: true});
    return {ok: true, ...admitted};
  } catch (error) {
    if (error instanceof CheckoutRefused) return {ok: false, code: error.code, detail: error.message};
    return {ok: false, code: 'checkout_failed', detail: (error as Error).message.slice(0, 500)};
  }
}

if (require.main === module) {
  const request = JSON.parse(process.env.SIFT_CHECKOUT ?? '{}') as CheckoutRequest;
  runCheckout(request).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok ? 0 : 2);
  }, () => process.exit(1));
}

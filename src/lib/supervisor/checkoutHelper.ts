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
 * The same program builds the patch after the writer stops (SIFT_MODE=patch),
 * in a container with no network that sees the checkout read-only. It never
 * uses the checkout's own git directory, which the writer controlled: a fresh
 * GIT_DIR on the attempt filesystem reads the base objects through
 * alternates, as data only, and diffs the write scope against the base.
 *
 * A third mode (SIFT_MODE=install) installs the admitted dependencies:
 * `npm ci --ignore-scripts --include=dev` in the deps volume, which holds only
 * the admitted package.json and package-lock.json, with no user or global
 * npm config, the public registry, and the registry-only proxy as its route.
 * npm's own output goes to a capped log file, never stdout.
 *
 * Output is one JSON line on stdout. Exit 0 means the step succeeded.
 */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream, promises as fs} from 'node:fs';
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

export interface GitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Streams stdout to this file instead of memory, after `prefix`, up to maxBytes in all; past it the process
   * is killed and `truncated` set.
   */
  toFile?: {path: string; maxBytes: number; prefix?: string};
}

export type Git = (args: string[], options?: GitOptions) => Promise<{code: number; stdout: Buffer; stderr: string; bytes?: number; truncated?: boolean}>;

export function hostGit(home: string): Git {
  return (args, options = {}) => new Promise((resolve) => {
    const child = spawn('git', ['--attr-source', EMPTY_TREE, ...args], {cwd: options.cwd ?? '/', env: {...gitEnvironment(home), ...options.env},
      stdio: ['ignore', 'pipe', 'pipe']});
    const out: Buffer[] = [];
    let err = '';
    let bytes = 0;
    let truncated = false;
    const sink = options.toFile ? createWriteStream(options.toFile.path, {mode: 0o644}) : undefined;
    if (sink && options.toFile?.prefix) {
      sink.write(options.toFile.prefix);
      bytes = Buffer.byteLength(options.toFile.prefix);
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (!sink) { out.push(chunk); return; }
      if (truncated) return;
      bytes += chunk.length;
      if (bytes > (options.toFile as {maxBytes: number}).maxBytes) {
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      sink.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { if (err.length < 8192) err += chunk.toString(); });
    child.once('error', (error) => resolve({code: 127, stdout: Buffer.alloc(0), stderr: error.message}));
    child.once('close', (code) => {
      const done = () => resolve({code: code ?? 1, stdout: Buffer.concat(out), stderr: err, bytes, truncated});
      if (sink) sink.end(done);
      else done();
    });
  });
}

export class CheckoutRefused extends Error {
  constructor(readonly code: string, detail: string) {
    super(detail);
  }
}

async function must(git: Git, code: string, args: string[], options?: {cwd?: string; env?: NodeJS.ProcessEnv}): Promise<Buffer> {
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

export const MAX_PATCH_BYTES = 64 * 1024 * 1024;
export const PATCH_FILE = 'sift.patch';
/**
 * The most a path list in a helper's result may take serialized (the patch's changed paths, the frozen set). Past it
 * the step is refused with its own code; a list is never truncated. The supervisor reads results a little above this.
 */
export const MAX_PATH_LIST_BYTES = 15 * 1024 * 1024;

function boundedPathList<T>(list: T[], code: string, what: string, max: number): T[] {
  const bytes = Buffer.byteLength(JSON.stringify(list));
  if (bytes > max) throw new CheckoutRefused(code, `${what} takes ${bytes} bytes serialized; at most ${max}`);
  return list;
}

/** The write scope as literal pathspecs: no glob or magic in a directory name applies. */
const literal = (scopes: string[]) => scopes.map((scope) => `:(literal)${scope}`);

/**
 * The write scope's changes against the base, as a binary git diff, written to
 * `<out>/sift.patch` and capped at 64 MiB. The writer's .git (config, hooks,
 * attributes, fsmonitor, index) is never read: a fresh git directory in
 * `<out>/g` takes the base objects through alternates and its own index, and
 * new blobs land in its own object directory.
 */
export async function buildPatch(git: Git, work: string, out: string, baseSha: string, writeScope: string[],
  maxBytes = MAX_PATCH_BYTES, maxListBytes = MAX_PATH_LIST_BYTES): Promise<{bytes: number; changed: string[]}> {
  const gitDir = path.join(out, 'g');
  await fs.rm(gitDir, {recursive: true, force: true});
  await must(git, 'patch_failed', ['init', '--quiet', '--bare', gitDir]);
  const env = {GIT_DIR: gitDir, GIT_WORK_TREE: work, GIT_OBJECT_DIRECTORY: path.join(gitDir, 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(work, '.git', 'objects'), GIT_INDEX_FILE: path.join(gitDir, 'index')};
  await must(git, 'patch_failed', ['read-tree', baseSha], {cwd: work, env});
  await must(git, 'patch_failed', ['add', '--all', '--', ...literal(writeScope)], {cwd: work, env});
  const file = path.join(out, PATCH_FILE);
  // A manifest's files must have distinct digests (V502), and an empty patch would match an empty log. The header
  // names what the patch is against; git apply skips text before the first diff.
  const prefix = `# sift patch v1: base ${baseSha}, write scope ${JSON.stringify(writeScope)}\n`;
  const diff = await git(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--no-color', baseSha, '--', ...literal(writeScope)],
    {cwd: work, env, toFile: {path: file, maxBytes, prefix}});
  if (diff.truncated) {
    await fs.rm(file, {force: true});
    throw new CheckoutRefused('patch_too_large', `more than ${maxBytes} bytes`);
  }
  if (diff.code !== 0) throw new CheckoutRefused('patch_failed', `git diff exited ${diff.code}: ${diff.stderr.trim().slice(0, 500)}`);
  // Every path the patch touches, renames as a delete plus an add, for the frozen-test check (U3).
  const names = await must(git, 'patch_failed', ['diff', '--cached', '--name-only', '-z', '--no-renames', baseSha, '--', ...literal(writeScope)],
    {cwd: work, env});
  await fs.rm(gitDir, {recursive: true, force: true});
  const changed = boundedPathList(names.toString('utf8').split('\0').filter(Boolean), 'patch_too_many_paths', 'the changed-path list', maxListBytes);
  return {bytes: diff.bytes ?? 0, changed};
}

export const INSTALL_LOG = 'install.log';
export const MAX_INSTALL_LOG_BYTES = 4 * 1024 * 1024;
export const NPM_CI_ARGS = ['ci', '--ignore-scripts', '--include=dev', '--no-audit', '--no-fund'];

/** Empty user and global npm configs in the helper's private home; npm refuses one file (or /dev/null) for both. */
export const NPM_USER_CONFIG = '.npmrc-user';
export const NPM_GLOBAL_CONFIG = '.npmrc-global';

/**
 * npm's whole environment: nothing inherited, so no NODE_ENV=production can drop dev dependencies and no user,
 * global or project config can change the registry, auth or scripts. The user and global configs are empty files
 * the helper writes; the project directory holds only the admitted manifests, so there is no .npmrc to read either.
 */
export function npmEnvironment(home: string, cache: string, proxy: string): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home,
    npm_config_userconfig: path.join(home, NPM_USER_CONFIG), npm_config_globalconfig: path.join(home, NPM_GLOBAL_CONFIG),
    npm_config_registry: 'https://registry.npmjs.org/', npm_config_ignore_scripts: 'true', npm_config_audit: 'false',
    npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_cache: cache,
    npm_config_https_proxy: proxy, npm_config_proxy: proxy, HTTPS_PROXY: proxy, HTTP_PROXY: proxy,
  };
}

export type Npm = (args: string[], options: {cwd: string; env: NodeJS.ProcessEnv; logFile: string; maxLogBytes: number}) => Promise<number>;

export const hostNpm: Npm = (args, options) => new Promise((resolve) => {
  const log = createWriteStream(options.logFile, {mode: 0o644});
  let written = 0;
  const child = spawn('npm', args, {cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe']});
  const capture = (chunk: Buffer) => {
    if (written >= options.maxLogBytes) return;
    const part = chunk.subarray(0, options.maxLogBytes - written);
    written += part.length;
    log.write(part);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.once('error', () => log.end(() => resolve(127)));
  child.once('close', (code) => log.end(() => resolve(code ?? 1)));
});

/** Installs the admitted dependencies into `<build>/node_modules`; the npm cache is removed afterwards. */
export async function runInstall(paths = {build: '/build', home: '/tmp/h'}, proxy = process.env.SIFT_PROXY ?? '',
  npm: Npm = hostNpm): Promise<Record<string, unknown>> {
  try {
    if (!/^http:\/\/[a-z0-9.-]+:\d+$/.test(proxy)) throw new CheckoutRefused('dependency_install_failed', 'no registry proxy was given');
    for (const file of ['package.json', 'package-lock.json']) {
      const stat = await fs.lstat(path.join(paths.build, file)).catch(() => null);
      if (!stat?.isFile()) throw new CheckoutRefused('dependency_install_failed', `the admitted ${file} is missing`);
    }
    await fs.mkdir(paths.home, {recursive: true});
    for (const config of [NPM_USER_CONFIG, NPM_GLOBAL_CONFIG]) await fs.writeFile(path.join(paths.home, config), '', {mode: 0o444});
    const cache = path.join(paths.build, '.npm-cache');
    const code = await npm(NPM_CI_ARGS, {cwd: paths.build, env: npmEnvironment(paths.home, cache, proxy),
      logFile: path.join(paths.build, INSTALL_LOG), maxLogBytes: MAX_INSTALL_LOG_BYTES});
    await fs.rm(cache, {recursive: true, force: true});
    if (code !== 0) throw new CheckoutRefused('dependency_install_failed', `npm ci exited ${code}`);
    // A project with no dependencies gets no node_modules from npm; the writer's read-only mount needs the directory.
    const target = path.join(paths.build, 'node_modules');
    const installed = await fs.lstat(target).catch(() => null);
    if (!installed) await fs.mkdir(target);
    else if (!installed.isDirectory()) throw new CheckoutRefused('dependency_install_failed', 'npm ci left node_modules that is not a directory');
    return {ok: true};
  } catch (error) {
    if (error instanceof CheckoutRefused) return {ok: false, code: error.code, detail: error.message};
    return {ok: false, code: 'dependency_install_failed', detail: (error as Error).message.slice(0, 500)};
  }
}

/** A repository-relative path, or undefined: no absolute path (but a `/workspace/` prefix), `..`, `.git`, or empty segment. */
export function repoPath(raw: string): string | undefined {
  let candidate = raw.trim();
  if (candidate.startsWith('/workspace/')) candidate = candidate.slice('/workspace/'.length);
  while (candidate.startsWith('./')) candidate = candidate.slice(2);
  candidate = candidate.replace(/\/+$/, '');
  if (!candidate || candidate.startsWith('/') || /[\\\0]/.test(candidate)) return undefined;
  const segments = candidate.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment === '.git')) return undefined;
  return segments.join('/');
}

export interface FrozenPath {path: string; kind: 'file' | 'dir'}
export type FrozenSource = 'files' | 'selector' | 'report';

/**
 * The frozen set (verification contract rev 2, D3), checked against the base tree: every prefix a directory, the
 * path itself a regular file or a directory. A selector token that is not such a path is not a path and is ignored;
 * an entry from `test.files` or a report `file` attribute that is not one fails closed.
 */
export async function resolveFrozen(git: Git, env: NodeJS.ProcessEnv, baseSha: string,
  candidates: Array<{path: string; source: FrozenSource}>, maxListBytes = MAX_PATH_LIST_BYTES): Promise<FrozenPath[]> {
  const listing = await must(git, 'verify_failed', ['ls-tree', '-r', '-t', '-z', '--full-tree', baseSha], {env});
  const modes = new Map<string, string>();
  for (const record of listing.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    modes.set(record.slice(tab + 1), record.slice(0, tab).split(/\s+/)[0]);
  }
  const frozen = new Map<string, FrozenPath>();
  for (const candidate of candidates) {
    const normalized = repoPath(candidate.path);
    const segments = normalized?.split('/') ?? [];
    const prefixesAreTrees = segments.slice(0, -1).every((_, i) => modes.get(segments.slice(0, i + 1).join('/')) === TREE);
    const mode = normalized ? modes.get(normalized) : undefined;
    const kind = mode === TREE ? 'dir' : mode === '100644' || mode === '100755' ? 'file' : undefined;
    if (!normalized || !prefixesAreTrees || !kind) {
      if (candidate.source === 'selector') continue;
      throw new CheckoutRefused('frozen_path_invalid', `${candidate.source} names ${JSON.stringify(candidate.path)}, which is not a file or directory at the base`);
    }
    frozen.set(normalized, {path: normalized, kind});
  }
  if (frozen.size === 0) throw new CheckoutRefused('frozen_tests_unknown', 'no test file or directory could be identified to freeze');
  return boundedPathList([...frozen.values()].sort((a, b) => (a.path < b.path ? -1 : 1)), 'frozen_path_invalid', 'the frozen set', maxListBytes);
}

/** The changed paths that are frozen: equal to a frozen file, or under a frozen directory. */
export function frozenChanges(changed: string[], frozen: FrozenPath[]): string[] {
  return changed.filter((file) => frozen.some((entry) => file === entry.path || (entry.kind === 'dir' && file.startsWith(`${entry.path}/`))));
}

const sha256Hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A verifier run's own git directory (`<dir>/g`) and tree (`<dir>/src`), reading the base objects through alternates. */
export function verifyEnv(dir: string, objects: string): NodeJS.ProcessEnv {
  const gitDir = path.join(dir, 'g');
  return {GIT_DIR: gitDir, GIT_WORK_TREE: path.join(dir, 'src'), GIT_OBJECT_DIRECTORY: path.join(gitDir, 'objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: objects, GIT_INDEX_FILE: path.join(gitDir, 'index')};
}

/**
 * A fresh tree for one verifier run (rev 2, R1): baseSha checked out from the base objects through alternates into
 * `<dir>/src` with a git directory of its own at `<dir>/g`, then, for the selected and regression runs, the frozen
 * patch applied by its digest. Returns the index tree id the run is checked against afterwards.
 */
export async function materializeVerify(git: Git, objects: string, dir: string, baseSha: string,
  patch?: {file: string; sha256: string}, dependencies = false): Promise<{treeId: string; env: NodeJS.ProcessEnv}> {
  const env = verifyEnv(dir, objects);
  const gitDir = env.GIT_DIR as string;
  const tree = env.GIT_WORK_TREE as string;
  // The run directory may exist (a volume subpath); the tree inside it must not.
  await fs.mkdir(dir, {recursive: true, mode: 0o755});
  await fs.mkdir(tree, {mode: 0o755});
  await must(git, 'verify_failed', ['init', '--quiet', '--bare', gitDir]);
  await must(git, 'verify_failed', ['read-tree', baseSha], {cwd: tree, env});
  await must(git, 'verify_failed', ['checkout-index', '--all', '-u'], {cwd: tree, env});
  if (patch) {
    const stat = await fs.lstat(patch.file).catch(() => undefined);
    if (!stat?.isFile() || stat.size > MAX_PATCH_BYTES) throw new CheckoutRefused('patch_apply_failed', 'the patch is not a regular file within its cap');
    const bytes = await fs.readFile(patch.file);
    if (sha256Hex(bytes) !== patch.sha256) throw new CheckoutRefused('patch_apply_failed', 'the patch does not match its frozen digest');
    // Applied from a private copy, so the bytes checked are the bytes applied.
    const copy = path.join(gitDir, 'apply.patch');
    await fs.writeFile(copy, bytes, {mode: 0o600, flag: 'wx'});
    await must(git, 'patch_apply_failed', ['apply', '--index', '--whitespace=nowarn', copy], {cwd: tree, env});
  }
  const treeId = (await must(git, 'verify_failed', ['write-tree'], {cwd: tree, env})).toString().trim();
  if (!patch) {
    const baseTree = (await must(git, 'verify_failed', ['rev-parse', `${baseSha}^{tree}`], {cwd: tree, env})).toString().trim();
    if (treeId !== baseTree) throw new CheckoutRefused('verify_failed', `the base checkout is tree ${treeId}, not ${baseTree}`);
  }
  // The installed dependencies are mounted read-only over an empty, untracked directory; a tracked one is refused.
  if (dependencies) {
    await fs.mkdir(path.join(tree, 'node_modules'), {mode: 0o755}).catch((error: NodeJS.ErrnoException) => {
      throw new CheckoutRefused('unsupported_dependency_source', error.code === 'EEXIST' ? 'the tree tracks a top-level node_modules' : error.message);
    });
  }
  return {treeId, env};
}

/** git's object id for a blob of these bytes (SHA-1 repositories). */
async function blobId(read: () => AsyncIterable<Buffer> | Buffer[], size: number): Promise<{id: string; bytes: number}> {
  const hash = createHash('sha1').update(`blob ${size}\0`);
  let bytes = 0;
  for await (const chunk of read()) { hash.update(chunk); bytes += chunk.length; }
  return {id: hash.digest('hex'), bytes};
}

/**
 * After a run, every tracked path of the recorded tree must still be what the tree says (rev 2, R1): a real
 * directory at every prefix, the same type and executable bit, and the same blob id computed from the bytes on
 * disk. `git update-index --refresh` would keep the indexed ids, so nothing here trusts the index. Untracked and
 * ignored files are not checked. Returns the paths that differ, at most 20.
 */
export async function checkTree(git: Git, env: NodeJS.ProcessEnv, tree: string, treeId: string): Promise<string[]> {
  const format = (await must(git, 'verify_failed', ['rev-parse', '--show-object-format'], {cwd: tree, env})).toString().trim();
  if (format !== 'sha1') throw new CheckoutRefused('verify_failed', `object format ${format} is not supported`);
  const listing = await must(git, 'verify_failed', ['ls-tree', '-r', '-z', '--full-tree', treeId], {cwd: tree, env});
  const changed: string[] = [];
  const directories = new Map<string, boolean>();
  const realDirectory = async (relative: string) => {
    if (!directories.has(relative)) directories.set(relative, Boolean((await fs.lstat(path.join(tree, relative)).catch(() => undefined))?.isDirectory()));
    return directories.get(relative) as boolean;
  };
  for (const record of listing.toString('utf8').split('\0')) {
    if (!record || changed.length >= 20) continue;
    const tab = record.indexOf('\t');
    const [mode, , id] = record.slice(0, tab).split(/\s+/);
    const relative = record.slice(tab + 1);
    const segments = relative.split('/');
    let parentsReal = true;
    for (let i = 1; i < segments.length && parentsReal; i += 1) parentsReal = await realDirectory(segments.slice(0, i).join('/'));
    const file = path.join(tree, relative);
    const stat = parentsReal ? await fs.lstat(file).catch(() => undefined) : undefined;
    let same = false;
    if (stat && mode === '120000' && stat.isSymbolicLink()) {
      const target = await fs.readlink(file, {encoding: 'buffer'});
      same = (await blobId(() => [target], target.length)).id === id;
    } else if (stat && (mode === '100644' || mode === '100755') && stat.isFile() && ((stat.mode & 0o100) !== 0) === (mode === '100755')) {
      const read = await blobId(() => createReadStream(file), stat.size);
      same = read.bytes === stat.size && read.id === id;
    } else if (stat && mode === '160000') {
      same = stat.isDirectory();
    }
    if (!same) changed.push(relative);
  }
  return changed;
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

export async function runPatch(request: CheckoutRequest, paths = {work: '/workspace', out: '/out', home: '/tmp/h'},
  git: Git = hostGit(paths.home)): Promise<Record<string, unknown>> {
  try {
    await fs.mkdir(paths.home, {recursive: true});
    return {ok: true, ...await buildPatch(git, paths.work, paths.out, request.baseSha, request.writeScope)};
  } catch (error) {
    if (error instanceof CheckoutRefused) return {ok: false, code: error.code, detail: error.message};
    return {ok: false, code: 'patch_failed', detail: (error as Error).message.slice(0, 500)};
  }
}

/** Where every container that reads a verify git directory mounts the base objects (the writer's checkout, read-only). */
export const BASE_OBJECTS = '/workspace/.git/objects';

/**
 * The result head (U3-2 contract rev 2, R-D3): a commit of the verified tree with the base as its parent, and a fixed
 * author, committer and date, so the same tree always yields the same id. The git directory gets a file-based
 * alternates entry naming the base objects at the path every reader mounts them, so a reader needs no alternates
 * variable to see the base commit and the unchanged blobs. The base was fetched at depth 1, so the git directory also
 * names it as a shallow boundary, as the fetch did for its own repository; without that, `git merge-base` (the
 * review's) looks for the base's parent, which never arrived.
 */
export async function writeResultCommit(git: Git, env: NodeJS.ProcessEnv, treeId: string, baseSha: string,
  objects = BASE_OBJECTS): Promise<string> {
  const gitDir = env.GIT_DIR as string;
  await fs.mkdir(path.join(gitDir, 'objects', 'info'), {recursive: true});
  await fs.writeFile(path.join(gitDir, 'objects', 'info', 'alternates'), `${objects}\n`, {mode: 0o644});
  await fs.writeFile(path.join(gitDir, 'shallow'), `${baseSha}\n`, {mode: 0o644});
  const fixed = {...env, GIT_AUTHOR_NAME: 'sift', GIT_AUTHOR_EMAIL: 'sift@localhost', GIT_AUTHOR_DATE: '@0 +0000',
    GIT_COMMITTER_NAME: 'sift', GIT_COMMITTER_EMAIL: 'sift@localhost', GIT_COMMITTER_DATE: '@0 +0000'};
  const head = (await must(git, 'verify_failed', ['commit-tree', treeId, '-p', baseSha, '-m', 'sift verified result'], {env: fixed}))
    .toString().trim();
  await must(git, 'verify_failed', ['update-ref', 'refs/heads/sift-result', head], {env});
  await must(git, 'verify_failed', ['symbolic-ref', 'HEAD', 'refs/heads/sift-result'], {env});
  // A real work tree for every reader that starts in it, the review's own child processes included (Release R11):
  // a gitfile naming the git directory beside it, which is no longer bare.
  await must(git, 'verify_failed', ['config', 'core.bare', 'false'], {env});
  await fs.writeFile(path.join(env.GIT_WORK_TREE as string, '.git'), 'gitdir: ../g\n', {mode: 0o644, flag: 'wx'});
  return head;
}

export interface VerifyRequest {
  baseSha: string;
  /** The frozen patch's digest; absent for the base run. */
  patchSha256?: string;
  /** Base run's tree check only: the frozen-set candidates to resolve against the base tree. */
  frozen?: Array<{path: string; source: FrozenSource}>;
  /** Make the empty node_modules the installed dependencies are mounted over. */
  dependencies?: boolean;
}

const VERIFY_PATHS = {objects: BASE_OBJECTS, dir: '/verify', patch: '/out/sift.patch', home: '/tmp/h'};

async function refusalOf(work: () => Promise<Record<string, unknown>>, fallback: string): Promise<Record<string, unknown>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CheckoutRefused) return {ok: false, code: error.code, detail: error.message};
    return {ok: false, code: fallback, detail: (error as Error).message.slice(0, 500)};
  }
}

/** SIFT_MODE=verify-checkout: a fresh tree for one run, with the patch for the selected and regression runs. */
export function runVerifyCheckout(request: VerifyRequest, paths = VERIFY_PATHS, git: Git = hostGit(paths.home)): Promise<Record<string, unknown>> {
  return refusalOf(async () => {
    await fs.mkdir(paths.home, {recursive: true});
    const {treeId} = await materializeVerify(git, paths.objects, paths.dir, request.baseSha,
      request.patchSha256 ? {file: paths.patch, sha256: request.patchSha256} : undefined, request.dependencies === true);
    return {ok: true, treeId};
  }, 'verify_failed');
}

/**
 * SIFT_MODE=tree-check: after the run, the tracked paths that no longer match the recorded tree; for the base run,
 * also the frozen set, now that the base report's file attributes are known.
 */
export function runTreeCheck(request: {treeId: string; baseSha?: string; frozen?: VerifyRequest['frozen']}, paths = VERIFY_PATHS,
  git: Git = hostGit(paths.home)): Promise<Record<string, unknown>> {
  return refusalOf(async () => {
    await fs.mkdir(paths.home, {recursive: true});
    const env = verifyEnv(paths.dir, paths.objects);
    const changed = await checkTree(git, env, env.GIT_WORK_TREE as string, request.treeId);
    const frozen = request.frozen && request.baseSha ? await resolveFrozen(git, env, request.baseSha, request.frozen) : undefined;
    return {ok: true, changed, ...(frozen ? {frozen} : {})};
  }, 'verify_failed');
}

/** SIFT_MODE=result-commit: the result head for the selected run's verified tree (writable /verify). */
export function runResultCommit(request: {treeId: string; baseSha: string}, paths = VERIFY_PATHS,
  git: Git = hostGit(paths.home)): Promise<Record<string, unknown>> {
  return refusalOf(async () => {
    await fs.mkdir(paths.home, {recursive: true});
    return {ok: true, head: await writeResultCommit(git, verifyEnv(paths.dir, paths.objects), request.treeId, request.baseSha)};
  }, 'verify_failed');
}

if (require.main === module) {
  const request = JSON.parse(process.env.SIFT_CHECKOUT ?? '{}') as CheckoutRequest;
  const verify = JSON.parse(process.env.SIFT_VERIFY ?? '{}') as VerifyRequest & {treeId: string};
  const mode = process.env.SIFT_MODE;
  (mode === 'patch' ? runPatch(request) : mode === 'install' ? runInstall() : mode === 'verify-checkout' ? runVerifyCheckout(verify)
    : mode === 'tree-check' ? runTreeCheck(verify) : mode === 'result-commit' ? runResultCommit(verify) : runCheckout(request)).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok ? 0 : 2);
  }, () => process.exit(1));
}

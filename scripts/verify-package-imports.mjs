#!/usr/bin/env node
/**
 * Pre-publish gate: verify that every relative import (and statically-referenced
 * runtime asset) in the SHIPPED file set resolves to another shipped file.
 *
 * Why this exists: the monorepo always has every file on disk, so a gap in the
 * package.json `files` allowlist is invisible locally and only crashes after a
 * clean `npm install`. Two such gaps shipped before this gate:
 *   - native lib*.{dylib,so} were excluded (fell back to TS silently)
 *   - interactive-tui/planning/** and assets/** were excluded because the glob
 *     was `interactive-tui/*.ts` (top-level only) -> `sift interactive` crashed
 *     with "Cannot find module ./planning/agentWork".
 *
 * The authoritative shipped set comes from `npm pack --dry-run` (so it reflects
 * the real `files` + .npmignore semantics). We run with --ignore-scripts so this
 * does NOT recursively re-trigger prepack.
 *
 * Exits non-zero (failing the publish) if anything is unresolved.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EMITTED_IMPORTS_ONLY = process.argv.includes('--emitted-imports-only');
const HARNESS_IDENTITY = 'siftable-agent-harness';
const HARNESS_SOURCE_ROOT = 'agent-harness';
const HARNESS_ENTRYPOINT = 'agent-harness/index.ts';
const REQUIRED_HARNESS_INPUTS = Object.freeze([
  HARNESS_ENTRYPOINT,
  'agent-harness/framework/chat-agent.ts',
  'agent-harness/framework/session.ts',
  'agent-harness/framework/tool.ts',
  'agent-harness/providers/siftable/index.ts',
  'agent-harness/providers/siftable/client.ts',
  'agent-harness/providers/siftable/tools.ts',
]);

function shippedFiles() {
  const out = execSync('npm pack --dry-run --ignore-scripts --json', {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const json = JSON.parse(out);
  return json[0].files.map((f) => f.path.replace(/\\/g, '/'));
}

// Strip comments so we don't flag `import` examples inside JSDoc/block comments
// or full-line `//` comments. (Inline trailing `//` is left as-is; a fake import
// after real code on one line is not a real-world case.)
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments incl. JSDoc
    .replace(/^[ \t]*\/\/.*$/gm, ''); // full-line // comments
}

const IMPORT_PATTERNS = [
  /(?:^|[\s;])(?:import|export)\b[^'"`]*?\bfrom\s*["'](\.[^"']+)["']/g, // import/export ... from '.'
  /(?:^|[\s;])import\s*["'](\.[^"']+)["']/g, // side-effect import '.'
  /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g, // dynamic import('.')
  /\brequire\s*\(\s*["'](\.[^"']+)["']\s*\)/g, // require('.')
];
// new URL('./x', import.meta.url) — runtime file/dir refs (assets, native libs).
const URL_PATTERN = /new\s+URL\(\s*[`"'](\.[^`"']*)/g;
const FORBIDDEN_WORKSPACE_IMPORT =
  /@execufunction\/shared|shared\/dist|(?:\.\.\/){2,}shared(?:\/|["'])/;

const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js'];

function resolvesAsModule(abs, shipped) {
  if (RESOLVE_EXTS.some((e) => shipped.has(abs + e))) return true;
  // bun/ts resolve a `.js` specifier to a sibling `.ts`/`.tsx`
  if (abs.endsWith('.js')) {
    const base = abs.replace(/\.js$/, '');
    if (shipped.has(base + '.ts') || shipped.has(base + '.tsx')) return true;
  }
  return false;
}

function emittedFilesOnDisk(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (/\.(?:[cm]?js|d\.ts)$/.test(entry.name)) {
        files.push(absolute);
      }
    }
  };
  visit(root);
  return files;
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function sourceFilesUnder(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(absolute);
    }
  };
  visit(root);
  return files.sort();
}

function sourceTreeSha256(tuiRoot, files) {
  const hash = createHash('sha256');
  for (const file of files) {
    const sourcePath = path.relative(tuiRoot, file).replaceAll('\\', '/');
    const contents = readFileSync(file);
    hash.update(`${Buffer.byteLength(sourcePath)}:`);
    hash.update(sourcePath);
    hash.update(`:${contents.byteLength}:`);
    hash.update(contents);
  }
  return hash.digest('hex');
}

function verifyPackagedInteractiveRuntime(files, shipped, problems) {
  const manifestPath = 'interactive-tui/runtime/runtime-manifest.json';
  if (!shipped.has(manifestPath)) {
    problems.push(`${manifestPath}\n    packaged interactive runtime manifest is missing`);
    return;
  }

  const manifest = JSON.parse(readFileSync(path.join(ROOT, manifestPath), 'utf8'));
  const expectedPlatforms = [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-arm64',
    'win32-x64',
  ];
  if (manifest.schemaVersion !== 2) {
    problems.push(`${manifestPath}\n    unsupported or missing schemaVersion`);
  }
  if (manifest.opentuiVersion !== '0.3.1') {
    problems.push(`${manifestPath}\n    OpenTUI version drifted from 0.3.1`);
  }
  if (manifest.autoInstall !== false) {
    problems.push(`${manifestPath}\n    packaged runtime does not disable Bun auto-install`);
  }
  if (JSON.stringify(manifest.platforms) !== JSON.stringify(expectedPlatforms)) {
    problems.push(`${manifestPath}\n    packaged runtime platform inventory drifted`);
  }

  if (manifest.bunLockSha256 !== sha256File(path.join(ROOT, 'interactive-tui/bun.lock'))) {
    problems.push(`${manifestPath}\n    bun.lock SHA-256 does not match the authoritative private package lock`);
  }

  const harness = manifest.harness;
  if (!harness || typeof harness !== 'object' || Array.isArray(harness)) {
    problems.push(`${manifestPath}\n    agent harness identity and source metadata are missing`);
  } else {
    if (harness.identity !== HARNESS_IDENTITY) {
      problems.push(`${manifestPath}\n    agent harness identity drifted from '${HARNESS_IDENTITY}'`);
    }
    if (harness.sourceRoot !== HARNESS_SOURCE_ROOT || harness.entrypoint !== HARNESS_ENTRYPOINT) {
      problems.push(`${manifestPath}\n    agent harness source boundary or entrypoint drifted`);
    }
    const bundledInputs = Array.isArray(harness.bundledInputs) ? harness.bundledInputs : [];
    const safeBundledInputs = bundledInputs.every((input) => (
      typeof input === 'string'
      && input.startsWith(`${HARNESS_SOURCE_ROOT}/`)
      && path.posix.normalize(input) === input
    ));
    if (!safeBundledInputs || new Set(bundledInputs).size !== bundledInputs.length) {
      problems.push(`${manifestPath}\n    agent harness metafile inventory is unsafe or contains duplicates`);
    }
    const missingInputs = REQUIRED_HARNESS_INPUTS.filter((input) => !bundledInputs.includes(input));
    if (missingInputs.length > 0) {
      problems.push(`${manifestPath}\n    statically bundled agent harness inputs are missing: ${missingInputs.join(', ')}`);
    }

    const tuiRoot = path.join(ROOT, 'interactive-tui');
    const harnessSourceFiles = sourceFilesUnder(path.join(tuiRoot, HARNESS_SOURCE_ROOT));
    if (harnessSourceFiles.length === 0) {
      problems.push(`${manifestPath}\n    authoritative agent harness source is missing`);
    } else {
      if (harness.sourceFileCount !== harnessSourceFiles.length) {
        problems.push(`${manifestPath}\n    agent harness source file count does not match the build input`);
      }
      if (!/^[0-9a-f]{64}$/u.test(harness.sourceSha256 ?? '')
        || harness.sourceSha256 !== sourceTreeSha256(tuiRoot, harnessSourceFiles)) {
        problems.push(`${manifestPath}\n    agent harness source SHA-256 does not match the build input`);
      }
    }
  }

  const manifestEntries = Array.isArray(manifest.files) ? manifest.files : [];
  const manifestPaths = [];
  const uniquePaths = new Set();
  for (const entry of manifestEntries) {
    const safePath = typeof entry.path === 'string'
      && entry.path.length > 0
      && !entry.path.startsWith('/')
      && !entry.path.includes('\\')
      && !entry.path.includes('\0')
      && path.posix.normalize(entry.path) === entry.path
      && entry.path !== '..'
      && !entry.path.startsWith('../');
    if (!safePath || uniquePaths.has(entry.path)) {
      problems.push(`${manifestPath}\n    contains an unsafe or duplicate runtime path`);
      continue;
    }
    uniquePaths.add(entry.path);
    manifestPaths.push(entry.path);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[0-9a-f]{64}$/u.test(entry.sha256)) {
      problems.push(`${manifestPath}\n    contains invalid bytes or SHA-256 metadata for '${entry.path}'`);
      continue;
    }
    const shippedPath = `interactive-tui/runtime/${entry.path}`;
    const absolute = path.join(ROOT, shippedPath);
    if (!shipped.has(shippedPath)) {
      problems.push(`${manifestPath}\n    declares '${entry.path}', but it is not shipped`);
      continue;
    }
    if (sha256File(absolute) !== entry.sha256) {
      problems.push(`${shippedPath}\n    content does not match runtime manifest SHA-256`);
    }
    if (readFileSync(absolute).byteLength !== entry.bytes) {
      problems.push(`${shippedPath}\n    byte length does not match runtime manifest`);
    }
  }

  const actualRuntimePaths = files
    .filter((file) => file.startsWith('interactive-tui/runtime/') && file !== manifestPath)
    .map((file) => file.slice('interactive-tui/runtime/'.length))
    .sort();
  if (JSON.stringify([...manifestPaths].sort()) !== JSON.stringify(actualRuntimePaths)) {
    problems.push(`${manifestPath}\n    runtime file inventory is not an exact match for shipped files`);
  }

  const required = [
    'interactive-tui/runtime/index.js',
    'interactive-tui/runtime/headless.js',
    'interactive-tui/runtime/parser.worker.js',
    'interactive-tui/runtime/bunfig.toml',
    'interactive-tui/runtime/licenses/NOTICE.json',
    'interactive-tui/runtime/skills/mermaid/SKILL.md',
    ...expectedPlatforms.map((platform) => `interactive-tui/runtime/platform/${platform}/index.js`),
  ];
  for (const requiredPath of required) {
    if (!shipped.has(requiredPath)) problems.push(`${requiredPath}\n    required packaged runtime file is missing`);
  }

  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const parentRuntimeDependencies = Object.keys(packageJson.dependencies ?? {})
    .filter((name) => name.startsWith('@opentui/') || name === 'solid-js');
  if (parentRuntimeDependencies.length) {
    problems.push(`package.json\n    parent CLI still owns TUI dependencies: ${parentRuntimeDependencies.join(', ')}`);
  }

  const entrySource = readFileSync(path.join(ROOT, 'interactive-tui/runtime/index.js'), 'utf8');
  if (entrySource.includes('@opentui/core-')) {
    problems.push(`${manifestPath}\n    packaged bundle retains a bare OpenTUI platform import`);
  }
  if (!entrySource.includes('./platform/${process.platform}-${process.arch}/index.js')) {
    problems.push(`${manifestPath}\n    packaged bundle does not resolve the vendored platform runtime`);
  }
  const forbiddenLegacyHarnessLoaders = [
    ['EXECUTERM_OPENFUNCTION_PATH', /EXECUTERM_OPENFUNCTION_PATH/u],
    ['openfunction/framework path', /openfunction[\\/]framework/iu],
    ['computed openfunction/framework path', /["']openfunction["']\s*,\s*["']framework["']/iu],
  ];
  for (const [description, pattern] of forbiddenLegacyHarnessLoaders) {
    if (pattern.test(entrySource)) {
      problems.push(`${manifestPath}\n    packaged bundle retains legacy ${description}`);
    }
  }

  const bunfig = readFileSync(path.join(ROOT, 'interactive-tui/runtime/bunfig.toml'), 'utf8');
  if (!/\[install\][\s\S]*auto\s*=\s*["']disable["']/u.test(bunfig)) {
    problems.push(`interactive-tui/runtime/bunfig.toml\n    Bun auto-install is not disabled`);
  }

  const unexpectedNodeModules = files.filter((file) => file.startsWith('interactive-tui/node_modules/'));
  if (unexpectedNodeModules.length) {
    problems.push(`interactive-tui/node_modules\n    dependency tree leaked into package (${unexpectedNodeModules.length} files)`);
  }
  const hostArtifacts = files.filter((file) => (
    /^interactive-tui\/runtime\/lib.*\.(?:dylib|so|dll)$/u.test(file)
    || file === 'interactive-tui/runtime/native/cell-render'
    || /^interactive-tui\/native\/lib.*\.(?:dylib|so|dll)$/u.test(file)
    || file === 'interactive-tui/native/cell-render'
  ));
  if (hostArtifacts.length) {
    problems.push(`interactive-tui/runtime\n    host-only native artifacts leaked into universal package: ${hostArtifacts.join(', ')}`);
  }

  const notice = JSON.parse(readFileSync(path.join(ROOT, 'interactive-tui/runtime/licenses/NOTICE.json'), 'utf8'));
  const missingLicenseFiles = (notice.packages ?? []).filter((entry) => !entry.licenseFile);
  if (missingLicenseFiles.length) {
    problems.push(`interactive-tui/runtime/licenses/NOTICE.json\n    ${missingLicenseFiles.length} bundled dependency licenses lack a shipped text`);
  }
}

function verifyEmittedImportsOnly() {
  const packageRoots = [
    path.join(ROOT, 'dist'),
    path.resolve(ROOT, '../exf-mcp-server/dist'),
  ];
  const packageFiles = packageRoots.map((root) => ({
    root,
    files: emittedFilesOnDisk(root),
  }));
  const missingPackages = packageFiles.filter(({ files }) => files.length === 0);
  const files = packageFiles.flatMap(({ files }) => files);
  const problems = files
    .filter((file) => FORBIDDEN_WORKSPACE_IMPORT.test(readFileSync(file, 'utf8')))
    .map((file) => `${path.relative(path.dirname(ROOT), file)}\n    contains an escaping shared workspace import`);

  if (missingPackages.length) {
    const missing = missingPackages
      .map(({ root }) => path.relative(path.dirname(ROOT), root))
      .join(', ');
    console.error(`✗ verify-package-imports: no compiled JS or declaration files found under ${missing}.`);
    process.exit(1);
  }
  if (problems.length) {
    console.error(`\n✗ verify-package-imports: ${problems.length} escaping workspace import(s):\n`);
    for (const problem of problems) console.error(`  ${problem}\n`);
    process.exit(1);
  }

  console.log(`✓ verify-package-imports: emitted imports stay within public package boundaries (${files.length} files scanned).`);
}

function main() {
  if (EMITTED_IMPORTS_ONLY) {
    verifyEmittedImportsOnly();
    return;
  }

  const files = shippedFiles();
  const shipped = new Set(files);
  const tsFiles = files.filter((f) => /^interactive-tui\/.*\.(ts|tsx)$/.test(f) || /^bin\//.test(f));
  const emittedFiles = files.filter((f) => /^dist\/.*\.(?:[cm]?js|d\.ts)$/.test(f));

  const problems = [];
  verifyPackagedInteractiveRuntime(files, shipped, problems);

  for (const f of tsFiles) {
    let src;
    try {
      src = stripComments(readFileSync(path.join(ROOT, f), 'utf8'));
    } catch {
      continue;
    }
    const dir = path.posix.dirname(f);

    for (const re of IMPORT_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const spec = m[1];
        const abs = path.posix.normalize(path.posix.join(dir, spec));
        if (!resolvesAsModule(abs, shipped)) {
          problems.push(`${f}\n    imports '${spec}' -> ${abs} (NOT in package)`);
        }
      }
    }

    URL_PATTERN.lastIndex = 0;
    let u;
    while ((u = URL_PATTERN.exec(src))) {
      // Take the static prefix up to any template interpolation (e.g. ./lib${x}.so).
      let spec = u[1];
      const interp = spec.indexOf('${');
      const isTemplatePrefix = interp !== -1;
      if (isTemplatePrefix) spec = spec.slice(0, interp);
      const abs = path.posix.normalize(path.posix.join(dir, spec));
      // OK if it resolves to a shipped file, OR `abs` is a shipped directory
      // (e.g. new URL('./skills', ...) or './assets/sounds/'), OR it's a
      // template file-prefix whose siblings are shipped (e.g. ./lib${suffix}).
      const ok =
        resolvesAsModule(abs, shipped) ||
        shipped.has(abs) ||
        files.some((s) => s.startsWith(abs.replace(/\/$/, '') + '/')) ||
        (isTemplatePrefix && files.some((s) => s.startsWith(abs)));
      if (!ok) {
        problems.push(`${f}\n    new URL('${u[1]}...') -> ${abs} (no shipped files under this path)`);
      }
    }
  }

  for (const f of emittedFiles) {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    if (FORBIDDEN_WORKSPACE_IMPORT.test(src)) {
      problems.push(`${f}\n    contains an escaping shared workspace import`);
    }
  }

  if (problems.length) {
    console.error(`\n✗ verify-package-imports: ${problems.length} unresolved reference(s) in the shipped package:\n`);
    for (const p of problems) console.error('  ' + p + '\n');
    console.error('Fix the `files` allowlist in package.json so these ship, then re-run.\n');
    process.exit(1);
  }

  console.log(`✓ verify-package-imports: package-relative references resolve and emitted imports stay within declared packages (${tsFiles.length + emittedFiles.length} files scanned, ${files.length} shipped).`);
}

main();

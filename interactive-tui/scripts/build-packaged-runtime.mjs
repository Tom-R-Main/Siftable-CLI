#!/usr/bin/env bun

import {createHash} from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, relative, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import solidPlugin from '@opentui/solid/bun-plugin';

const TUI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_ROOT = resolve(TUI_ROOT, '..', '..', '..');
const RUNTIME_ROOT = join(TUI_ROOT, 'runtime');
const OPENTUI_VERSION = '0.3.1';
const PLATFORM_PACKAGES = Object.freeze({
  'darwin-arm64': 'sha512-krvVfiBpeBY+727R8yogdqIcxkK3RUVcI97bqjl8jTeDMcWOkFFfHezssRMPmbR5x++1tX669Fz3fuxoe7XUIg==',
  'darwin-x64': 'sha512-D/6ec5H8SPpSBMr01/sqgSddIl1Qc1QMKsDl/wV5MpbxYc7Qvie9qlNvvoSsWNfAXAbafLRb1jQBzouk41cp1w==',
  'linux-arm64': 'sha512-E/FFBoAsWJyS/EO/cF7h7DuEENYa9nAdSv1W/TIyKXpBisN6K3U1Xgbk528TkfWjrwJjhGs+9OMYdXuAHd5LTw==',
  'linux-x64': 'sha512-Btb7Q4BOC55Aj2qCs0VoxGuj87DNfUEaSx0z89oeU4npTN+6SpJApyGZTCNNeSe2sdmOGeh/8eAR4X96ORjcKg==',
  'win32-arm64': 'sha512-+lt24u3KwEPG69oXDOLz9N484wPcAHvrPbDNU77OT6DvWew+StAjh40eY+Zeu0TkTNDWfj7qnQKV0GKWtFA3cw==',
  'win32-x64': 'sha512-eVkKMYirYgpn92lI0YT/GKru4J+UiXjzwyzNRFX+P59OHXvL3GFdqJMcJmX4/zvyjg4c8HDnU79YLnyG+TlXLw==',
});
const PLATFORM_IMPORT = 'await import(`@opentui/core-${process.platform}-${process.arch}`)';
const PACKAGED_PLATFORM_IMPORT = 'await import(`./platform/${process.platform}-${process.arch}/index.js`)';

function fail(message) {
  throw new Error(message);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function run(command, args, cwd = TUI_ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {...process.env, CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1'},
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function filesUnder(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function packageRootForBundledInput(input) {
  const marker = `${join('', 'node_modules')}/`;
  for (const base of [process.cwd(), TUI_ROOT, REPOSITORY_ROOT]) {
    const normalized = resolve(base, input).replaceAll('\\', '/');
    const markerIndex = normalized.lastIndexOf('/node_modules/');
    if (markerIndex === -1) continue;
    const dependencyRoot = normalized.slice(0, markerIndex + marker.length + 1);
    const remainder = normalized.slice(markerIndex + '/node_modules/'.length);
    const segments = remainder.split('/');
    const packageSegments = segments[0].startsWith('@') ? segments.slice(0, 2) : segments.slice(0, 1);
    const packageRoot = join(dependencyRoot, ...packageSegments);
    if (existsSync(join(packageRoot, 'package.json'))) return packageRoot;
  }
  return null;
}

function copyDependencyLicenses(inputs) {
  const licenseRoot = join(RUNTIME_ROOT, 'licenses');
  mkdirSync(licenseRoot, {recursive: true});
  const packages = [];
  const dependencyInputs = inputs.filter((input) => input.replaceAll('\\', '/').includes('node_modules/'));
  const unresolvedInputs = dependencyInputs.filter((input) => !packageRootForBundledInput(input));
  if (unresolvedInputs.length > 0) {
    fail(`could not resolve package roots for bundled dependencies:\n${unresolvedInputs.join('\n')}`);
  }
  const packageRoots = [...new Set(dependencyInputs.map(packageRootForBundledInput))].sort();
  if (packageRoots.length === 0) fail('bundled runtime did not report any third-party dependencies');
  for (const packageRoot of packageRoots) {
    const manifestPath = join(packageRoot, 'package.json');
    if (!existsSync(manifestPath)) fail(`bundled dependency has no package manifest: ${packageRoot}`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const license = readdirSync(packageRoot).find((name) => /^licen[cs]e(?:\.|$)/iu.test(name));
    const stem = `${String(manifest.name ?? basename(packageRoot)).replaceAll('/', '-')}-${manifest.version ?? 'unknown'}`;
    const fallback = typeof manifest.license === 'string'
      ? join(TUI_ROOT, 'scripts', 'licenses', `${manifest.license}.txt`)
      : null;
    const licenseFile = license
      ? `${stem}-${license}`
      : fallback && existsSync(fallback)
        ? `${stem}-${manifest.license}.txt`
        : null;
    if (license) cpSync(join(packageRoot, license), join(licenseRoot, licenseFile));
    else if (licenseFile) cpSync(fallback, join(licenseRoot, licenseFile));
    packages.push({
      name: manifest.name ?? basename(packageRoot),
      version: manifest.version ?? null,
      license: manifest.license ?? null,
      licenseFile,
      licenseSource: license ? 'package' : licenseFile ? 'spdx-fallback' : null,
    });
  }
  packages.sort((first, second) => String(first.name).localeCompare(String(second.name)));
  writeFileSync(join(licenseRoot, 'NOTICE.json'), `${JSON.stringify({packages}, null, 2)}\n`);
}

function assertDependencyVersion(name, expected) {
  const path = join(TUI_ROOT, 'node_modules', ...name.split('/'), 'package.json');
  if (!existsSync(path)) fail(`missing ${name}; run bun install --frozen-lockfile in interactive-tui`);
  const actual = JSON.parse(readFileSync(path, 'utf8')).version;
  if (actual !== expected) fail(`${name} resolved ${actual}; expected ${expected}`);
}

function vendorPlatformPackages(tempRoot) {
  const platformRoot = join(RUNTIME_ROOT, 'platform');
  mkdirSync(platformRoot, {recursive: true});
  for (const [platform, expectedIntegrity] of Object.entries(PLATFORM_PACKAGES)) {
    const packageName = `@opentui/core-${platform}`;
    const packRoot = join(tempRoot, platform);
    const extractRoot = join(packRoot, 'extract');
    mkdirSync(extractRoot, {recursive: true});
    const packed = JSON.parse(run('npm', [
      'pack',
      `${packageName}@${OPENTUI_VERSION}`,
      '--pack-destination',
      packRoot,
      '--json',
      '--ignore-scripts',
    ]));
    if (packed.length !== 1 || packed[0].integrity !== expectedIntegrity) {
      fail(`${packageName} integrity drifted from the reviewed ${OPENTUI_VERSION} artifact`);
    }
    const archive = join(packRoot, packed[0].filename);
    run('tar', ['-xzf', archive, '-C', extractRoot]);
    const source = join(extractRoot, 'package');
    const target = join(platformRoot, platform);
    cpSync(source, target, {recursive: true});
    if (!existsSync(join(target, 'index.js'))) fail(`${packageName} did not contain index.js`);
  }
}

function copyRuntimeAssets(inputs) {
  for (const directory of ['assets', 'skills']) {
    cpSync(join(TUI_ROOT, directory), join(RUNTIME_ROOT, directory), {recursive: true});
  }

  // Do not copy host-built Zig libraries or cell-render into this universal
  // artifact. The bundled engines deliberately take their TypeScript/PATH
  // fallbacks when no correctly keyed platform binary is present.
  copyDependencyLicenses(inputs);
}

async function buildBundle() {
  const coreRoot = join(TUI_ROOT, 'node_modules', '@opentui', 'core');
  const appResult = await Bun.build({
    entrypoints: [join(TUI_ROOT, 'index.tsx')],
    outdir: RUNTIME_ROOT,
    target: 'bun',
    minify: true,
    packages: 'bundle',
    plugins: [solidPlugin],
    metafile: true,
  });
  if (!appResult.success) fail(`Bun app bundle failed:\n${appResult.logs.join('\n')}`);
  const workerResult = await Bun.build({
    entrypoints: [join(coreRoot, 'parser.worker.js')],
    outdir: RUNTIME_ROOT,
    target: 'bun',
    minify: true,
    packages: 'bundle',
    metafile: true,
  });
  if (!workerResult.success) fail(`Bun worker bundle failed:\n${workerResult.logs.join('\n')}`);

  const entry = join(RUNTIME_ROOT, 'index.js');
  let source = readFileSync(entry, 'utf8');
  const occurrences = source.split(PLATFORM_IMPORT).length - 1;
  if (occurrences !== 1) fail(`expected one OpenTUI platform import, found ${occurrences}`);
  source = source.replace(PLATFORM_IMPORT, PACKAGED_PLATFORM_IMPORT);
  if (source.includes('@opentui/core-')) fail('bare OpenTUI platform import remains in bundle');
  writeFileSync(entry, source);
  return [...Object.keys(appResult.metafile.inputs), ...Object.keys(workerResult.metafile.inputs)];
}

async function main() {
  assertDependencyVersion('@opentui/core', OPENTUI_VERSION);
  assertDependencyVersion('@opentui/solid', OPENTUI_VERSION);
  assertDependencyVersion('@opentui/keymap', OPENTUI_VERSION);

  rmSync(RUNTIME_ROOT, {recursive: true, force: true});
  mkdirSync(RUNTIME_ROOT, {recursive: true});
  const tempRoot = mkdtempSync(join(tmpdir(), 'sift-opentui-runtime-'));
  try {
    const bundledInputs = await buildBundle();
    vendorPlatformPackages(tempRoot);
    copyRuntimeAssets(bundledInputs);
    writeFileSync(join(RUNTIME_ROOT, 'bunfig.toml'), 'telemetry = false\n\n[install]\nauto = "disable"\n');

    const files = filesUnder(RUNTIME_ROOT)
      .filter((path) => basename(path) !== 'runtime-manifest.json')
      .map((path) => ({
        path: relative(RUNTIME_ROOT, path).replaceAll('\\', '/'),
        bytes: readFileSync(path).byteLength,
        sha256: sha256(path),
      }));
    const manifest = {
      schemaVersion: 1,
      opentuiVersion: OPENTUI_VERSION,
      bunVersion: Bun.version,
      bunLockSha256: sha256(join(TUI_ROOT, 'bun.lock')),
      autoInstall: false,
      platforms: Object.keys(PLATFORM_PACKAGES),
      files,
    };
    writeFileSync(join(RUNTIME_ROOT, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Packaged offline TUI runtime: ${files.length} files, ${files.reduce((sum, file) => sum + file.bytes, 0)} bytes`);
  } finally {
    rmSync(tempRoot, {recursive: true, force: true});
  }
}

await main();

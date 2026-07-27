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
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

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
const FORBIDDEN_WORKSPACE_IMPORT = /shared\/dist|(?:\.\.\/){2,}shared(?:\/|["'])/;

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

function main() {
  const files = shippedFiles();
  const shipped = new Set(files);
  const tsFiles = files.filter((f) => /^interactive-tui\/.*\.(ts|tsx)$/.test(f) || /^bin\//.test(f));
  const emittedFiles = files.filter((f) => /^dist\/.*\.(?:[cm]?js|d\.ts)$/.test(f));

  const problems = [];

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

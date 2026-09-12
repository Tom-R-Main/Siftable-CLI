#!/usr/bin/env node
// Exercise the shipped CLI outside the checkout, with existing installed
// dependencies. This checks the packed artifact without a network installation.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredCases = [
  'actual read/write loop, JSONL receipts, and no hosted credential',
  'streamed text arrives before completion and prints exactly once',
  'verification passed is candidate-bound and durably recorded',
  'verification failed is candidate-bound and durably recorded',
  'verification stale is candidate-bound and durably recorded',
  'JSON output is exactly one object',
  'background jobs survive tool calls and drain at shutdown',
  'shell results project one output body and retain diagnostic receipts',
  'final answer excludes tool progress and failed partial text stays separate',
  'streamed tool progress and final answer retain separate response boundaries',
  'configured failed check reaches the model, repairs and passes in the same turn',
  'cleanup edits invalidate a previously passing check',
  'a withdrawn user-directed answer never becomes the result; a streamed one is marked in place',
];

export function assertAcceptanceReport(xml) {
  // Bun writes these fixed JUnit elements. Refuse absent cases, skips and
  // nonterminal/error results even when the runner happens to exit successfully.
  const cases = [...xml.matchAll(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/gu)]
    .map(match => match[0])
    .filter(entry => /name="cli-packaged:/u.test(entry));
  if (cases.some(entry => /<(?:skipped|failure|error)\b/u.test(entry))) {
    throw new Error('Packaged acceptance contains skipped or failed tests.');
  }
  for (const expected of requiredCases) {
    const name = `cli-packaged: ${expected}`;
    if (cases.filter(entry => entry.includes(`name="${name}"`)).length !== 1) {
      throw new Error(`Packaged acceptance needs exactly one result for: ${name}`);
    }
  }
  if (cases.length !== requiredCases.length) {
    throw new Error(`Expected ${requiredCases.length} packaged acceptance cases; received ${cases.length}.`);
  }
  return cases.length;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: 'utf8', timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024, ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status ?? result.signal}:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return result;
}

export function main() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'sift-packed-acceptance-'));
  try {
    const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--dry-run=false', '--json', '--pack-destination', temporaryRoot]).stdout);
    if (packed.length !== 1 || basename(packed[0].filename) !== packed[0].filename) {
      throw new Error('npm pack did not produce one local artifact.');
    }
    run('tar', ['-xzf', join(temporaryRoot, packed[0].filename), '-C', temporaryRoot]);
    const packageRoot = join(temporaryRoot, 'package');
    for (const file of ['bin/run.js', 'dist/commands/agent/run.js', 'interactive-tui/runtime/headless.js']) {
      if (!existsSync(join(packageRoot, file))) throw new Error(`Packed artifact is missing ${file}.`);
    }
    if (existsSync(join(packageRoot, 'interactive-tui/headless.ts'))) {
      throw new Error('Acceptance must not have the source headless runtime available.');
    }
    // Dependency resolution is intentionally reused, not reinstalled. The CLI
    // entrypoint and bundled brain must come from the archive under test.
    symlinkSync(resolve(root, '../../node_modules'), join(packageRoot, 'node_modules'), 'dir');
    const reportPath = join(temporaryRoot, 'acceptance.xml');
    const result = run('bun', ['test', 'test/headless.test.ts', '--test-name-pattern', 'cli-packaged:',
      '--reporter', 'junit', '--reporter-outfile', reportPath], {
      cwd: join(root, 'interactive-tui'),
      env: {...process.env, SIFT_TEST_PACKAGED_RUNTIME: '1', SIFT_TEST_CLI_PACKAGE_ROOT: packageRoot, SIFT_TEST_NODE: process.execPath},
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    const count = assertAcceptanceReport(readFileSync(reportPath, 'utf8'));
    console.log(`Packaged acceptance: ${count} passed, zero packaged cases skipped; npm artifact ${packed[0].integrity}.`);
  } finally {
    rmSync(temporaryRoot, {recursive: true, force: true});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

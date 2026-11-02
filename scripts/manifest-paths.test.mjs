import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {sourcePaths} from './manifest-paths.mjs';

const manifest = (...paths) => ({commands: Object.fromEntries(paths.map((path, i) => [`c${i}`, {relativePath: path.split('/')}]))});

test('accepts commands that point at built JavaScript', () => {
  assert.deepEqual(sourcePaths(manifest('dist/commands/machine/status.js', 'dist/commands/setup/prepare.js')), []);
});

test('names commands that point at TypeScript sources, as a NODE_ENV=test manifest does', () => {
  assert.deepEqual(sourcePaths(manifest('dist/commands/a.js', 'src/commands/machine/status.ts')), [['c1', 'src/commands/machine/status.ts']]);
  assert.deepEqual(sourcePaths(manifest('dist/commands/a.ts')), [['c0', 'dist/commands/a.ts']]);
  assert.deepEqual(sourcePaths({commands: {x: {}}}), [['x', '']]);
});

test('the committed manifest points every command at dist', () => {
  const committed = JSON.parse(readFileSync(new URL('../oclif.manifest.json', import.meta.url), 'utf8'));
  assert.ok(Object.keys(committed.commands).length > 0);
  assert.deepEqual(sourcePaths(committed), []);
});

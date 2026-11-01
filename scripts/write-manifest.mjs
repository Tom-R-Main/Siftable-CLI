// Writes oclif.manifest.json from the built CLI. oclif records TypeScript
// source paths (src/commands/*.ts) whenever NODE_ENV is "test" or
// "development", and a manifest like that crashes the installed CLI and the
// images packed from it (U7 rehearsal, round 2). So the manifest is always
// written as production, and every command must point at built JavaScript.
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourcePaths} from './manifest-paths.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const oclif = join(dirname(require.resolve('oclif/package.json')), 'bin/run.js');

const result = spawnSync(process.execPath, [oclif, 'manifest'], {
  cwd: root,
  env: {...process.env, NODE_ENV: 'production'},
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);

const wrong = sourcePaths(JSON.parse(readFileSync(join(root, 'oclif.manifest.json'), 'utf8')));
if (wrong.length) {
  console.error(`oclif.manifest.json names ${wrong.length} command(s) outside dist/*.js, for example ${wrong[0][0]} -> ${wrong[0][1]}`);
  process.exit(1);
}

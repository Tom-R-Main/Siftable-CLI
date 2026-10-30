import {describe, expect, it} from 'vitest';
import {admitDependencies, DependencyRefused, specProblem} from './attemptDependencies.js';

const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const entry = (name: string, extra: object = {}) =>
  ({version: '1.0.0', resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-1.0.0.tgz`, integrity: INTEGRITY, ...extra});

/** An ordinary v3 lockfile: scoped, aliased, dev, optional, peer and bundled entries, and a root with no tarball. */
function lockfile(overrides: Record<string, unknown> = {}, root: object = {}) {
  return JSON.stringify({
    name: 'widgets', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': {name: 'widgets', version: '1.0.0', dependencies: {'left-pad': '^1.3.0', 'lp': 'npm:left-pad@1.3.0'},
        devDependencies: {'@types/node': '~22.17.0', 'vitest': 'latest'}, optionalDependencies: {'fsevents': '2.x'},
        peerDependencies: {'react': '>=18 <20 || 19.0.0-rc.1'}, ...root},
      'node_modules/left-pad': entry('left-pad'),
      'node_modules/lp': entry('left-pad', {name: 'left-pad'}),
      'node_modules/@types/node': entry('@types/node', {dev: true}),
      'node_modules/vitest': entry('vitest', {dev: true}),
      'node_modules/vitest/node_modules/tinyspy': entry('tinyspy', {dev: true}),
      'node_modules/fsevents': entry('fsevents', {optional: true, os: ['darwin']}),
      'node_modules/react': entry('react', {peer: true}),
      'node_modules/vitest/node_modules/bundled-thing': {version: '1.0.0', inBundle: true},
      ...overrides,
    },
  });
}
const PACKAGE = JSON.stringify({name: 'widgets', version: '1.0.0', dependencies: {'left-pad': '^1.3.0', 'lp': 'npm:left-pad@1.3.0'},
  devDependencies: {'@types/node': '~22.17.0', 'vitest': 'latest'}});

const refused = (packageJson: string, lock: string) => {
  try {
    admitDependencies(packageJson, lock);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(DependencyRefused);
    return (error as Error).message;
  }
};

describe('dependency admission', () => {
  it('admits an ordinary registry lockfile, counting what it installs', () => {
    expect(admitDependencies(PACKAGE, lockfile())).toEqual({packages: 7});
    expect(admitDependencies(PACKAGE, lockfile().replace('"lockfileVersion":3', '"lockfileVersion":2'))).toEqual({packages: 7});
  });

  it('accepts registry ranges, dist-tags and npm aliases, and nothing else', () => {
    for (const spec of ['^1.2.3', '~1.2', '1.x', '*', '', 'latest', '>=1.0.0 <2.0.0', '1.0.0 - 2.0.0', '1 || 2', 'npm:@scope/pkg@^1', 'npm:pkg']) {
      expect(specProblem('p', spec), spec).toBeUndefined();
    }
    for (const spec of ['git+https://github.com/a/b.git', 'github:a/b', 'a/b', 'file:../x', 'link:../x', 'https://example.com/x.tgz',
      'workspace:*', 'npm:https://evil/x.tgz', 'npm:../x', 'npm:Bad Name@1', '1.0.0#main', 'C:\\x', 3]) {
      expect(specProblem('p', spec), String(spec)).toBeDefined();
    }
  });

  it('refuses every source but the public registry, and anything without a sha512 integrity', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['git', {'node_modules/x': {version: '1.0.0', resolved: 'git+ssh://git@github.com/a/x.git#abc'}}],
      ['other host', {'node_modules/x': entry('x', {resolved: 'https://registry.evil.example/x/-/x-1.0.0.tgz'})}],
      ['look-alike host', {'node_modules/x': entry('x', {resolved: 'https://registry.npmjs.org.evil.example/x.tgz'})}],
      ['http', {'node_modules/x': entry('x', {resolved: 'http://registry.npmjs.org/x/-/x-1.0.0.tgz'})}],
      ['traversal', {'node_modules/x': entry('x', {resolved: 'https://registry.npmjs.org/x/../../evil.tgz'})}],
      ['query', {'node_modules/x': entry('x', {resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz?redirect=1'})}],
      ['file', {'node_modules/x': {version: '1.0.0', resolved: 'file:../x'}}],
      ['no integrity', {'node_modules/x': entry('x', {integrity: undefined})}],
      ['sha1 only', {'node_modules/x': entry('x', {integrity: 'sha1-abcdef'})}],
      ['link', {'node_modules/x': {resolved: '../x', link: true}}],
      // Refused for being a link alone, even with a registry source and integrity.
      ['link with registry fields', {'node_modules/x': entry('x', {link: true})}],
      ['outside node_modules', {'../escape': entry('x')}],
      ['dot segment', {'node_modules/../x': entry('x')}],
    ];
    for (const [label, overrides] of cases) expect(refused(PACKAGE, lockfile(overrides)), label).toBeDefined();
  });

  it('refuses workspaces and non-registry specs in package.json and in the lockfile root', () => {
    expect(refused(JSON.stringify({name: 'w', workspaces: ['packages/*']}), lockfile())).toMatch(/workspaces/);
    expect(refused(PACKAGE, lockfile({}, {workspaces: ['packages/*']}))).toMatch(/workspaces/);
    expect(refused(JSON.stringify({name: 'w', dependencies: {x: 'github:a/x'}}), lockfile())).toMatch(/package.json/);
    expect(refused(PACKAGE, lockfile({}, {devDependencies: {x: 'file:../x'}}))).toMatch(/root entry/);
  });

  it('refuses lockfiles npm ci cannot install exactly', () => {
    expect(refused(PACKAGE, JSON.stringify({lockfileVersion: 1, dependencies: {}}))).toMatch(/lockfileVersion/);
    expect(refused(PACKAGE, JSON.stringify({lockfileVersion: 3}))).toMatch(/no packages/);
    expect(refused(PACKAGE, 'not json')).toMatch(/not JSON/);
    expect(refused('[]', lockfile())).toMatch(/not a JSON object/);
    expect(refused(PACKAGE, 'x'.repeat(32 * 1024 * 1024 + 1))).toMatch(/larger/);
  });
});

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import test from 'node:test';

import {
  CLI_ROOT,
  FUTURE_RESERVATION,
  LIVE_CONFIGS,
  assertNoForbiddenCodes,
  assertNoInteractiveTuiSource,
  buildReport,
  compareToCeiling,
  deriveOwnership,
  loadCeiling,
  parseCompilerConfig,
  toDiagnosticRecord,
  walkTestRoots,
} from './verify-test-typecheck-boundaries.mjs';

function fixture(run) {
  const root = mkdtempSync(resolve(tmpdir(), 'cli-typecheck-boundary-'));
  try {
    return run(root);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

function file(path, contents = '') {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, contents);
}

function hash(message) {
  return createHash('sha256').update(message.replace(/\s+/gu, ' ').trim()).digest('hex');
}

const SAMPLE_MESSAGE = 'Sample diagnostic message';

function ceilingEntry(overrides = {}) {
  return {
    owners: ['node16'],
    file: 'packages/exf-cli/test/sample.test.ts',
    code: 2322,
    messageHash: hash(SAMPLE_MESSAGE),
    max: 2,
    message: SAMPLE_MESSAGE,
    ...overrides,
  };
}

function record(overrides = {}) {
  return {
    ...ceilingEntry(),
    line: 10,
    column: 5,
    ...overrides,
  };
}

test('live walker discovers exactly the current 103 test roots', () => {
  const roots = walkTestRoots(resolve(CLI_ROOT, 'test'), {root: CLI_ROOT});
  assert.equal(roots.length, 103);
  assert.ok(roots.every((root) => root.endsWith('.test.ts')));
});

test('live configs derive the 44 Node16 and 59 Bundler split', () => {
  const discovered = walkTestRoots(resolve(CLI_ROOT, 'test'), {root: CLI_ROOT});
  const ownership = deriveOwnership({discovered, configs: LIVE_CONFIGS.map(parseCompilerConfig)});
  assert.deepEqual(ownership.counts, {node16: 44, 'tui-bundler': 59});
});

test('walker discovers both test.ts and test.tsx roots', () => fixture((root) => {
  file(resolve(root, 'one.test.ts'));
  file(resolve(root, 'nested/two.test.tsx'));
  assert.deepEqual(walkTestRoots(root), ['nested/two.test.tsx', 'one.test.ts']);
}));

test('walker rejects a symlink file', () => fixture((root) => {
  file(resolve(root, 'target.test.ts'));
  symlinkSync(resolve(root, 'target.test.ts'), resolve(root, 'linked.test.ts'));
  assert.throws(() => walkTestRoots(root), /rejects symlink/u);
}));

test('walker rejects a symlink directory', () => fixture((root) => {
  mkdirSync(resolve(root, 'target'));
  symlinkSync(resolve(root, 'target'), resolve(root, 'linked'));
  assert.throws(() => walkTestRoots(root), /rejects symlink/u);
}));

test('walker rejects test roots hidden by a skipped dist directory', () => fixture((root) => {
  file(resolve(root, 'dist/hidden.test.ts'));
  assert.throws(() => walkTestRoots(root), /skipped directory hides test root/u);
}));

test('walker accepts a skipped node_modules directory without test roots', () => fixture((root) => {
  file(resolve(root, 'visible.test.ts'));
  file(resolve(root, 'node_modules/package/index.ts'));
  assert.deepEqual(walkTestRoots(root), ['visible.test.ts']);
}));

test('ownership rejects a missing root', () => {
  assert.throws(
    () => deriveOwnership({discovered: ['missing.test.ts'], configs: [{name: 'node16', roots: []}]}),
    /exactly one compiler owner/u,
  );
});

test('ownership rejects a duplicate owner', () => {
  assert.throws(
    () => deriveOwnership({
      discovered: ['duplicate.test.ts'],
      configs: [{name: 'node16', roots: ['duplicate.test.ts']}, {name: 'tui-bundler', roots: ['duplicate.test.ts']}],
    }),
    /exactly one compiler owner/u,
  );
});

test('ownership rejects an unexpected compiler root', () => {
  assert.throws(
    () => deriveOwnership({discovered: [], configs: [{name: 'node16', roots: ['unexpected.test.ts']}]}),
    /unexpected test/u,
  );
});

test('committed work contract test is the exact Bundler-only reserved include', () => {
  const configs = LIVE_CONFIGS.map(parseCompilerConfig);
  const node16 = configs.find((config) => config.name === 'node16');
  const bundler = configs.find((config) => config.name === 'tui-bundler');
  assert.deepEqual(node16.reservedIncludes, []);
  assert.deepEqual(bundler.reservedIncludes, [FUTURE_RESERVATION]);
  assert.deepEqual(bundler.absentReservations, []);
  assert.deepEqual(bundler.roots.filter((root) => root === FUTURE_RESERVATION), [FUTURE_RESERVATION]);
});

test('present reserved include remains owned exactly once without fixed totals', () => {
  const discovered = walkTestRoots(resolve(CLI_ROOT, 'test'), {root: CLI_ROOT});
  const configs = LIVE_CONFIGS.map(parseCompilerConfig);
  const ownership = deriveOwnership({discovered, configs});
  assert.equal(ownership.tests, discovered.length);
  assert.deepEqual(ownership.owners.get(FUTURE_RESERVATION), ['tui-bundler']);
});

test('TypeScript include reservation is absent-safe and becomes a parsed root when present', () => fixture((root) => {
  const configPath = resolve(root, 'tsconfig.json');
  file(resolve(root, 'setup.ts'), 'export {};');
  file(configPath, JSON.stringify({
    compilerOptions: {module: 'ESNext', moduleResolution: 'Bundler', noEmit: true},
    files: ['setup.ts'],
    include: [FUTURE_RESERVATION],
  }));
  const descriptor = {name: 'fixture', path: configPath, root, module: 99, moduleResolution: 100};
  const absent = parseCompilerConfig(descriptor);
  assert.deepEqual(absent.roots, []);
  assert.deepEqual(absent.absentReservations, [FUTURE_RESERVATION]);
  file(resolve(root, FUTURE_RESERVATION), 'export {};');
  const present = parseCompilerConfig(descriptor);
  assert.deepEqual(present.roots, [FUTURE_RESERVATION]);
  assert.deepEqual(present.absentReservations, []);
}));

test('Node16-to-TUI guard rejects source and permits declarations', () => {
  assert.throws(
    () => assertNoInteractiveTuiSource('node16', ['/repo/packages/exf-cli/interactive-tui/source.ts']),
    /crossed into non-declaration/u,
  );
  assert.doesNotThrow(
    () => assertNoInteractiveTuiSource('node16', ['/repo/packages/exf-cli/interactive-tui/globals.d.ts']),
  );
});

test('compiler config parser rejects malformed JSON', () => fixture((root) => {
  const configPath = resolve(root, 'tsconfig.json');
  file(configPath, '{');
  assert.throws(
    () => parseCompilerConfig({name: 'bad', path: configPath, root, module: 99, moduleResolution: 100}),
  );
}));

test('compiler config parser rejects wrong module kind and resolution', () => fixture((root) => {
  const configPath = resolve(root, 'tsconfig.json');
  file(resolve(root, 'source.ts'), 'export {};');
  file(configPath, JSON.stringify({
    compilerOptions: {module: 'ESNext', moduleResolution: 'Bundler'},
    files: ['source.ts'],
  }));
  assert.throws(
    () => parseCompilerConfig({name: 'kind', path: configPath, root, module: 100, moduleResolution: 100}),
    /wrong module kind/u,
  );
  assert.throws(
    () => parseCompilerConfig({name: 'resolution', path: configPath, root, module: 99, moduleResolution: 3}),
    /wrong module resolution/u,
  );
}));

test('diagnostic conversion rejects malformed compiler output', () => {
  assert.throws(() => toDiagnosticRecord({code: '2322', messageText: SAMPLE_MESSAGE}), /diagnostic code/u);
  assert.throws(() => toDiagnosticRecord({code: 2322, messageText: SAMPLE_MESSAGE, start: 1}), /without a file/u);
  assert.throws(() => toDiagnosticRecord({code: 2322}), /diagnostic message/u);
});

test('ceiling load rejects categorical TS1479 and TS2835 entries', () => {
  assert.throws(() => loadCeiling([ceilingEntry({code: 1479})]), /categorically forbidden/u);
  assert.throws(() => loadCeiling([ceilingEntry({code: 2835})]), /categorically forbidden/u);
});

test('actual diagnostics reject categorical TS1479 and TS2835', () => {
  assert.throws(() => assertNoForbiddenCodes([record({code: 1479})]), /categorically forbidden/u);
  assert.throws(() => assertNoForbiddenCodes([record({code: 2835})]), /categorically forbidden/u);
});

test('equal, reduced, and disappeared ceiling groups pass', () => {
  const ceiling = loadCeiling([ceilingEntry()]);
  assert.doesNotThrow(() => compareToCeiling([record(), record({line: 11})], ceiling));
  assert.doesNotThrow(() => compareToCeiling([record()], ceiling));
  assert.doesNotThrow(() => compareToCeiling([], ceiling));
});

test('new and increased diagnostic groups fail', () => {
  const ceiling = loadCeiling([ceilingEntry({max: 1})]);
  const driftedMessage = 'Different diagnostic message';
  assert.throws(
    () => compareToCeiling([record({message: driftedMessage, messageHash: hash(driftedMessage)})], ceiling),
    /new diagnostic ceiling group/u,
  );
  assert.throws(
    () => compareToCeiling([record(), record({line: 11})], ceiling),
    /diagnostic ceiling increased/u,
  );
});

test('location movement passes while message identity drift fails', () => {
  const ceiling = loadCeiling([ceilingEntry()]);
  assert.doesNotThrow(() => compareToCeiling([record({line: 900, column: 42})], ceiling));
  const driftedMessage = 'Identity changed';
  assert.throws(
    () => compareToCeiling([record({message: driftedMessage, messageHash: hash(driftedMessage)})], ceiling),
    /new diagnostic ceiling group/u,
  );
});

test('report is always reviewed-baseline and derives live totals', () => {
  const report = buildReport({
    ownership: {tests: 3, counts: {node16: 1, 'tui-bundler': 2}},
    records: [record()],
  });
  assert.deepEqual(report, {
    status: 'pass',
    mode: 'reviewed-baseline',
    tests: 3,
    ownership: {node16: 1, 'tui-bundler': 2},
    diagnostics: 1,
  });
});

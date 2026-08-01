#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(CLI_ROOT, '../..');
const EXPECT_CLEAN = process.argv.includes('--expect-clean');
const CONFIGS = [
  {
    name: 'node16',
    path: resolve(CLI_ROOT, 'tsconfig.test.json'),
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    expectedTests: 27,
  },
  {
    name: 'tui-bundler',
    path: resolve(CLI_ROOT, 'tsconfig.test.tui.json'),
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    expectedTests: 53,
  },
];
const EXPECTED_DIAGNOSTICS = [
  'node16+tui-bundler|packages/exf-cli/test/helpers/mock-api.ts:234:5:TS2322:2257f69b7bd09a527f57dc327af312dc32e588ae56356cc7e75e50deacc2f820',
  'node16|packages/exf-cli/test/commands/ai.model-connection-interactive.test.ts:33:5:TS2322:2257f69b7bd09a527f57dc327af312dc32e588ae56356cc7e75e50deacc2f820',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:110:41:TS2352:44ae68781ca90d644be7aafc749f6cf2a4d8ac168199935113232d0c39630cbd',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:115:29:TS2339:cb78b91d76f1cb716b0c5d2a85a3d7d822521d75ac5156c27af54fde6068d089',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:143:39:TS2339:cb78b91d76f1cb716b0c5d2a85a3d7d822521d75ac5156c27af54fde6068d089',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:168:29:TS2339:cb78b91d76f1cb716b0c5d2a85a3d7d822521d75ac5156c27af54fde6068d089',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:189:41:TS2352:44ae68781ca90d644be7aafc749f6cf2a4d8ac168199935113232d0c39630cbd',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:205:18:TS2339:cb78b91d76f1cb716b0c5d2a85a3d7d822521d75ac5156c27af54fde6068d089',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:206:18:TS2339:cb78b91d76f1cb716b0c5d2a85a3d7d822521d75ac5156c27af54fde6068d089',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:219:33:TS2339:cb78b91d76f1cb716b0c5d2a85a3d7d822521d75ac5156c27af54fde6068d089',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:224:35:TS2339:cb78b91d76f1cb716b0c5d2a85a3d7d822521d75ac5156c27af54fde6068d089',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:236:29:TS2339:cb78b91d76f1cb716b0c5d2a85a3d7d822521d75ac5156c27af54fde6068d089',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:250:29:TS2339:cb78b91d76f1cb716b0c5d2a85a3d7d822521d75ac5156c27af54fde6068d089',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:264:29:TS2339:cb78b91d76f1cb716b0c5d2a85a3d7d822521d75ac5156c27af54fde6068d089',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:290:29:TS2339:cb78b91d76f1cb716b0c5d2a85a3d7d822521d75ac5156c27af54fde6068d089',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:311:29:TS2339:cb78b91d76f1cb716b0c5d2a85a3d7d822521d75ac5156c27af54fde6068d089',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:321:29:TS2339:cb78b91d76f1cb716b0c5d2a85a3d7d822521d75ac5156c27af54fde6068d089',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:342:29:TS2339:cb78b91d76f1cb716b0c5d2a85a3d7d822521d75ac5156c27af54fde6068d089',
  'tui-bundler|packages/exf-cli/test/brain.branch-tools.test.ts:90:31:TS2339:cb78b91d76f1cb716b0c5d2a85a3d7d822521d75ac5156c27af54fde6068d089',
  'tui-bundler|packages/exf-cli/test/branches.recovery.e2e.test.ts:198:18:TS2339:c56365b1b4b0e7d55c557e2f38eea3279cab1f91abb9d88b09933a2dd4981c49',
  'tui-bundler|packages/exf-cli/test/branchesOverlay.spawn.test.ts:81:25:TS2339:329d1d840e15435a609b2f606bcd3cc79cbc9b234893db53bd914c4bf8d9be2d',
  'tui-bundler|packages/exf-cli/test/childSessionController.test.ts:125:18:TS2339:fadf588a8a589bbab7ffe85cec5d33c0eccc07ee9bb25b34c80f21e62a1fa7f0',
  'tui-bundler|packages/exf-cli/test/childSessionController.test.ts:126:18:TS2339:08ce9a687d70b9c1b1fc5062fdff3dc965d0dcd74edd6bb8d55d91d4c70dbd68',
  'tui-bundler|packages/exf-cli/test/childSessionController.test.ts:170:31:TS2339:fadf588a8a589bbab7ffe85cec5d33c0eccc07ee9bb25b34c80f21e62a1fa7f0',
  'tui-bundler|packages/exf-cli/test/commands/interactive.branches.test.ts:39:7:TS2739:070db2f374522e9799bd1a36f67c5fc72c680a44b667f1114b4c7e8cd6ac23aa',
  'tui-bundler|packages/exf-cli/test/commands/interactive.chat-agent.test.ts:32:61:TS2345:ca465e4776d890a0865973d1746f11a78efc9038031bc209c008d34f85806fe2',
  'tui-bundler|packages/exf-cli/test/commands/interactive.ready.test.ts:114:7:TS2739:28661f07bbe415efdb772494297af1337a8310ac5ad27d6a4a47971ab1ccf9e4',
  'tui-bundler|packages/exf-cli/test/commands/interactive.ready.test.ts:123:7:TS2739:0b98756d7241d57cdd00cfa30f3dd987684210fbc310f40c1961b519aa59aa64',
  'tui-bundler|packages/exf-cli/test/commands/interactive.ready.test.ts:48:7:TS2739:28661f07bbe415efdb772494297af1337a8310ac5ad27d6a4a47971ab1ccf9e4',
  'tui-bundler|packages/exf-cli/test/commands/interactive.ready.test.ts:66:7:TS2739:0b98756d7241d57cdd00cfa30f3dd987684210fbc310f40c1961b519aa59aa64',
  'tui-bundler|packages/exf-cli/test/commands/interactive.ready.test.ts:88:7:TS2739:0b98756d7241d57cdd00cfa30f3dd987684210fbc310f40c1961b519aa59aa64',
  'tui-bundler|packages/exf-cli/test/commands/interactive.ready.test.ts:99:7:TS2739:28661f07bbe415efdb772494297af1337a8310ac5ad27d6a4a47971ab1ccf9e4',
  'tui-bundler|packages/exf-cli/test/commands/interactive.spawn.test.ts:103:40:TS2740:1be30d44f4eb6dfef0a5bc662fdc8c1821419dc16d0917028e90ff0a9d5b4556',
  'tui-bundler|packages/exf-cli/test/commands/interactive.spawn.test.ts:114:50:TS2740:1be30d44f4eb6dfef0a5bc662fdc8c1821419dc16d0917028e90ff0a9d5b4556',
  'tui-bundler|packages/exf-cli/test/commands/interactive.spawn.test.ts:131:50:TS2740:1be30d44f4eb6dfef0a5bc662fdc8c1821419dc16d0917028e90ff0a9d5b4556',
  'tui-bundler|packages/exf-cli/test/commands/interactive.spawn.test.ts:140:50:TS2740:1be30d44f4eb6dfef0a5bc662fdc8c1821419dc16d0917028e90ff0a9d5b4556',
  'tui-bundler|packages/exf-cli/test/commands/interactive.spawn.test.ts:151:50:TS2740:1be30d44f4eb6dfef0a5bc662fdc8c1821419dc16d0917028e90ff0a9d5b4556',
  'tui-bundler|packages/exf-cli/test/commands/interactive.spawn.test.ts:159:50:TS2740:1be30d44f4eb6dfef0a5bc662fdc8c1821419dc16d0917028e90ff0a9d5b4556',
  'tui-bundler|packages/exf-cli/test/commands/interactive.spawn.test.ts:167:50:TS2740:1be30d44f4eb6dfef0a5bc662fdc8c1821419dc16d0917028e90ff0a9d5b4556',
  'tui-bundler|packages/exf-cli/test/commands/interactive.spawn.test.ts:174:50:TS2740:1be30d44f4eb6dfef0a5bc662fdc8c1821419dc16d0917028e90ff0a9d5b4556',
  'tui-bundler|packages/exf-cli/test/commands/interactive.spawn.test.ts:40:50:TS2740:1be30d44f4eb6dfef0a5bc662fdc8c1821419dc16d0917028e90ff0a9d5b4556',
  'tui-bundler|packages/exf-cli/test/commands/interactive.spawn.test.ts:49:50:TS2740:1be30d44f4eb6dfef0a5bc662fdc8c1821419dc16d0917028e90ff0a9d5b4556',
  'tui-bundler|packages/exf-cli/test/commands/interactive.spawn.test.ts:76:50:TS2740:1be30d44f4eb6dfef0a5bc662fdc8c1821419dc16d0917028e90ff0a9d5b4556',
  'tui-bundler|packages/exf-cli/test/commands/interactive.spawn.test.ts:89:40:TS2740:1be30d44f4eb6dfef0a5bc662fdc8c1821419dc16d0917028e90ff0a9d5b4556',
  'tui-bundler|packages/exf-cli/test/mergeChild.wiring.test.ts:107:35:TS2339:83b6e94d8958c606d16078aa00e1154e06147602e944ff81b0a65179db11acc4',
  'tui-bundler|packages/exf-cli/test/mergeChild.wiring.test.ts:154:18:TS2339:83b6e94d8958c606d16078aa00e1154e06147602e944ff81b0a65179db11acc4',
];

function fail(message) {
  throw new Error(message);
}

function posix(path) {
  return path.split(sep).join('/');
}

function walk(directory) {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function parseConfig(config) {
  const read = ts.readConfigFile(config.path, ts.sys.readFile);
  if (read.error) fail(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(config.path),
    undefined,
    config.path,
  );
  if (parsed.errors.length) {
    fail(ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => REPO_ROOT,
      getNewLine: () => '\n',
    }));
  }
  if (parsed.options.module !== config.module) {
    fail(`${config.name} has the wrong module kind`);
  }
  if (parsed.options.moduleResolution !== config.moduleResolution) {
    fail(`${config.name} has the wrong module resolution`);
  }
  return parsed;
}

function diagnosticRecord(diagnostic) {
  const file = diagnostic.file ? posix(relative(REPO_ROOT, diagnostic.file.fileName)) : '<global>';
  const position = diagnostic.file && diagnostic.start != null
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    : {line: 0, character: 0};
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    code: diagnostic.code,
    file,
    line: position.line + 1,
    column: position.character + 1,
    message,
    messageHash: createHash('sha256').update(message).digest('hex'),
  };
}

function diagnosticKey(record) {
  return `${record.file}:${record.line}:${record.column}:TS${record.code}:${record.messageHash}`;
}

function diagnosticSignature(record) {
  return `${record.owners.toSorted().join('+')}|${diagnosticKey(record)}`;
}

const parsedConfigs = CONFIGS.map((config) => ({config, parsed: parseConfig(config)}));
const allTests = walk(resolve(CLI_ROOT, 'test'))
  .filter((path) => path.endsWith('.test.ts'))
  .map((path) => posix(relative(CLI_ROOT, path)))
  .sort();
const ownership = new Map();

for (const {config, parsed} of parsedConfigs) {
  const roots = parsed.fileNames
    .filter((path) => path.endsWith('.test.ts'))
    .map((path) => posix(relative(CLI_ROOT, path)))
    .sort();
  if (roots.length !== config.expectedTests) {
    fail(`${config.name} owns ${roots.length} tests; expected ${config.expectedTests}`);
  }
  for (const root of roots) {
    const owners = ownership.get(root) ?? [];
    owners.push(config.name);
    ownership.set(root, owners);
  }
}

for (const test of allTests) {
  const owners = ownership.get(test) ?? [];
  if (owners.length !== 1) fail(`${test} must have exactly one compiler owner; found ${owners.join(', ') || 'none'}`);
}
for (const test of ownership.keys()) {
  if (!allTests.includes(test)) fail(`compiler inventory contains unexpected test ${test}`);
}

const diagnostics = new Map();
for (const {config, parsed} of parsedConfigs) {
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  if (
    config.name === 'node16'
    && program.getSourceFiles().some((source) => (
      !source.isDeclarationFile && posix(source.fileName).includes('/packages/exf-cli/interactive-tui/')
    ))
  ) {
    fail('Node16 test graph crossed into interactive-tui');
  }
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const record = diagnosticRecord(diagnostic);
    const key = diagnosticKey(record);
    const existing = diagnostics.get(key);
    if (existing) {
      if (existing.owners.includes(config.name)) {
        fail(`${config.name} emitted duplicate diagnostic ${key}`);
      }
      existing.owners.push(config.name);
    } else {
      diagnostics.set(key, {...record, owners: [config.name]});
    }
  }
}

const records = [...diagnostics.values()];
if (records.some((record) => record.code === 1479 || record.code === 2835)) {
  fail('module-boundary artifacts TS1479/TS2835 remain');
}

if (EXPECT_CLEAN) {
  if (records.length) {
    fail(`expected clean test typechecks; found ${records.length} diagnostics\n${records.map((item) => (
      `${item.file}:${item.line}:${item.column} TS${item.code}: ${item.message}`
    )).join('\n')}`);
  }
} else {
  const actual = records.map(diagnosticSignature).sort();
  const expected = EXPECTED_DIAGNOSTICS.toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    const missing = expected.filter((signature) => !actualSet.has(signature));
    const unexpected = actual.filter((signature) => !expectedSet.has(signature));
    fail([
      'exact diagnostic inventory mismatch',
      `missing (${missing.length}):\n${missing.join('\n') || '<none>'}`,
      `unexpected (${unexpected.length}):\n${unexpected.join('\n') || '<none>'}`,
    ].join('\n'));
  }
}

console.log(JSON.stringify({
  status: 'pass',
  mode: EXPECT_CLEAN ? 'clean' : 'reviewed-baseline',
  tests: allTests.length,
  ownership: Object.fromEntries(CONFIGS.map((config) => [config.name, config.expectedTests])),
  diagnostics: records.length,
}, null, 2));

#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {readdirSync, realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
export const CLI_ROOT = resolve(SCRIPT_DIR, '..');
export const REPO_ROOT = resolve(CLI_ROOT, '../..');
export const FUTURE_RESERVATION = 'test/workContract.e2e.test.ts';
const TEST_ROOT_PATTERN = /\.test\.tsx?$/u;
const SKIPPED_DIRECTORY_NAMES = new Set(['dist', 'node_modules']);
const FORBIDDEN_DIAGNOSTIC_CODES = new Set([1479, 2835]);

export const LIVE_CONFIGS = Object.freeze([
  Object.freeze({
    name: 'node16',
    path: resolve(CLI_ROOT, 'tsconfig.test.json'),
    root: CLI_ROOT,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
  }),
  Object.freeze({
    name: 'tui-bundler',
    path: resolve(CLI_ROOT, 'tsconfig.test.tui.json'),
    root: CLI_ROOT,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  }),
]);

export const REVIEWED_CEILING = Object.freeze([
  {
    owners: ['node16'],
    file: 'packages/exf-cli/test/commands/ai.model-connection-interactive.test.ts',
    code: 2684,
    messageHash: 'f7228de2bda9b4829da7025ecd0ec8b64cd30668d93412d0a7f366c915966b13',
    max: 1,
    message: "The 'this' context of type 'typeof BaseCommand' is not assignable to method's 'this' of type 'new (argv: string[], config: Config) => BaseCommand'. Cannot assign an abstract constructor type to a non-abstract constructor type.",
  },
  {
    owners: ['node16'],
    file: 'packages/exf-cli/test/dotenvImportCommands.test.ts',
    code: 2684,
    messageHash: '14f9d36ed03a3f291e160e499a664e830aa9aff834a04cf9789f95d5fb363295',
    max: 1,
    message: "The 'this' context of type 'typeof EnvImportApply | typeof EnvImportPlan' is not assignable to method's 'this' of type 'new (argv: string[], config: Config) => EnvImportApply'. Types of construct signatures are incompatible. Type 'new (argv: string[], config: Config) => EnvImportPlan' is not assignable to type 'new (argv: string[], config: Config) => EnvImportApply'. Construct signature return types 'EnvImportPlan' and 'EnvImportApply' are incompatible. The types returned by 'run()' are incompatible between these types. Type 'Promise<DotenvImportPlanArtifact>' is not assignable to type 'Promise<{ planId: string; planDigest: string; importId: string; ownerType: \"workspace\" | \"user\"; ownerId: string; projectId: string | null; createdCount: number; updatedCount: number; keptCount: number; skippedCount: number; entries: { ...; }[]; }>'. Type 'DotenvImportPlanArtifact' is missing the following properties from type '{ planId: string; planDigest: string; importId: string; ownerType: \"workspace\" | \"user\"; ownerId: string; projectId: string | null; createdCount: number; updatedCount: number; keptCount: number; skippedCount: number; entries: { ...; }[]; }': planId, planDigest, importId, ownerType, and 7 more.",
  },
  {
    owners: ['node16'],
    file: 'packages/exf-cli/test/env-commands.test.ts',
    code: 2339,
    messageHash: '78755d36d53ba784f2255dc6872c9091c11665cb70986967108e5af9f3c52e2c',
    max: 2,
    message: "Property 'stderr' does not exist on type '{ stdout: string; error?: Error | undefined; exitCode?: number | undefined; }'.",
  },
  {
    owners: ['node16'],
    file: 'packages/exf-cli/test/env-commands.test.ts',
    code: 2352,
    messageHash: '8ef9cb8c3d857dec15b20daa8a6da5cfabfd60d6d02622e2488c55a8e649e27d',
    max: 1,
    message: "Conversion of type 'undefined' to type 'RequestInit' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.",
  },
  {
    owners: ['node16'],
    file: 'packages/exf-cli/test/env-commands.test.ts',
    code: 2493,
    messageHash: 'b08525fe15cc830ef3ca441cdd488203cba86d4e8b3180c9d39b6eb1a8ba76b6',
    max: 1,
    message: "Tuple type '[]' of length '0' has no element at index '1'.",
  },
  {
    owners: ['node16'],
    file: 'packages/exf-cli/test/env-commands.test.ts',
    code: 2551,
    messageHash: 'ca10d8c35ce241482212ae87a821e771228af95bbc93236758aeae5bb21d3e97',
    max: 2,
    message: "Property 'mtimeNs' does not exist on type 'Stats'. Did you mean 'mtimeMs'?",
  },
  {
    owners: ['node16'],
    file: 'packages/exf-cli/test/environmentCheckoutSafety.test.ts',
    code: 2551,
    messageHash: 'ca10d8c35ce241482212ae87a821e771228af95bbc93236758aeae5bb21d3e97',
    max: 2,
    message: "Property 'mtimeNs' does not exist on type 'Stats'. Did you mean 'mtimeMs'?",
  },
  {
    owners: ['tui-bundler'],
    file: 'packages/exf-cli/interactive-tui/commands.ts',
    code: 2554,
    messageHash: '0d7f88caa9641107a48c1e7e16181950d9d374636b6c4d2f833dab296c63e034',
    max: 1,
    message: 'Expected 2 arguments, but got 1.',
  },
  {
    owners: ['tui-bundler'],
    file: 'packages/exf-cli/interactive-tui/openfunction/framework/adapters/anthropic.ts',
    code: 2322,
    messageHash: '683bf6401a6b976560ba0bdbf2642b65b148ed80b5af959f327e74904458744c',
    max: 1,
    message: "Type '{ type: string; tool_use_id: string; content: string; }' is not assignable to type 'string | ContentBlockParam'. Type '{ type: string; tool_use_id: string; content: string; }' is not assignable to type 'TextBlockParam | ImageBlockParam | DocumentBlockParam | SearchResultBlockParam | ThinkingBlockParam | ... 11 more ... | MidConversationSystemBlockParam'. Type '{ type: string; tool_use_id: string; content: string; }' is not assignable to type 'ToolSearchToolResultBlockParam'. Types of property 'content' are incompatible. Type 'string' is not assignable to type 'ToolSearchToolResultErrorParam | ToolSearchToolSearchResultBlockParam'.",
  },
  {
    owners: ['tui-bundler'],
    file: 'packages/exf-cli/interactive-tui/openfunction/framework/adapters/anthropic.ts',
    code: 2322,
    messageHash: '72d677dcbd10a77c18258473d9529fae7cfcc3851b7c9105a70af02e0c6c0b9f',
    max: 1,
    message: "Type '(ContentBlockParam | { type: string; id: string; name: string; input: Record<string, unknown>; })[]' is not assignable to type 'string | ContentBlockParam[]'. Type '(ContentBlockParam | { type: string; id: string; name: string; input: Record<string, unknown>; })[]' is not assignable to type 'ContentBlockParam[]'. Type 'ContentBlockParam | { type: string; id: string; name: string; input: Record<string, unknown>; }' is not assignable to type 'ContentBlockParam'. Type '{ type: string; id: string; name: string; input: Record<string, unknown>; }' is not assignable to type 'ContentBlockParam'. Type '{ type: string; id: string; name: string; input: Record<string, unknown>; }' is not assignable to type 'TextBlockParam | ImageBlockParam | DocumentBlockParam | SearchResultBlockParam | ThinkingBlockParam | ... 10 more ... | MidConversationSystemBlockParam'. Type '{ type: string; id: string; name: string; input: Record<string, unknown>; }' is not assignable to type 'ToolUseBlockParam'. Types of property 'type' are incompatible. Type 'string' is not assignable to type '\"tool_use\"'.",
  },
  {
    owners: ['tui-bundler'],
    file: 'packages/exf-cli/interactive-tui/openfunction/framework/adapters/anthropic.ts',
    code: 2322,
    messageHash: '816efef8f514fc8dd2df0d2fdafb39d3e2e3223cc61056f2de54db83597765c5',
    max: 1,
    message: "Type '({ type: \"text\"; text: string; source?: undefined; } | { type: \"image\"; source: { type: \"base64\"; media_type: string; data: string; }; text?: undefined; })[]' is not assignable to type 'string | ContentBlockParam[]'. Type '({ type: \"text\"; text: string; source?: undefined; } | { type: \"image\"; source: { type: \"base64\"; media_type: string; data: string; }; text?: undefined; })[]' is not assignable to type 'ContentBlockParam[]'. Type '{ type: \"text\"; text: string; source?: undefined; } | { type: \"image\"; source: { type: \"base64\"; media_type: string; data: string; }; text?: undefined; }' is not assignable to type 'ContentBlockParam'. Type '{ type: \"image\"; source: { type: \"base64\"; media_type: string; data: string; }; text?: undefined; }' is not assignable to type 'ContentBlockParam'. Type '{ type: \"image\"; source: { type: \"base64\"; media_type: string; data: string; }; text?: undefined; }' is not assignable to type 'ImageBlockParam'. Types of property 'source' are incompatible. Type '{ type: \"base64\"; media_type: string; data: string; }' is not assignable to type 'Base64ImageSource | URLImageSource'. Type '{ type: \"base64\"; media_type: string; data: string; }' is not assignable to type 'Base64ImageSource'. Types of property 'media_type' are incompatible. Type 'string' is not assignable to type '\"image/png\" | \"image/jpeg\" | \"image/gif\" | \"image/webp\"'.",
  },
  {
    owners: ['tui-bundler'],
    file: 'packages/exf-cli/interactive-tui/openfunction/framework/adapters/anthropic.ts',
    code: 2322,
    messageHash: 'e4c535d5cb61848379337ec5be1c8804553786ea915306c125a77aeb5e193169',
    max: 1,
    message: "Type '(TextBlockParam | ImageBlockParam | DocumentBlockParam | SearchResultBlockParam | ThinkingBlockParam | ... 10 more ... | { ...; })[]' is not assignable to type 'string | ContentBlockParam[]'. Type '(TextBlockParam | ImageBlockParam | DocumentBlockParam | SearchResultBlockParam | ThinkingBlockParam | ... 10 more ... | { ...; })[]' is not assignable to type 'ContentBlockParam[]'. Type 'TextBlockParam | ImageBlockParam | DocumentBlockParam | SearchResultBlockParam | ThinkingBlockParam | ... 10 more ... | { ...; }' is not assignable to type 'ContentBlockParam'. Type '{ type: string; id: string; name: string; input: {}; }' is not assignable to type 'ContentBlockParam'. Type '{ type: string; id: string; name: string; input: {}; }' is not assignable to type 'TextBlockParam | ImageBlockParam | DocumentBlockParam | SearchResultBlockParam | ThinkingBlockParam | ... 10 more ... | MidConversationSystemBlockParam'. Type '{ type: string; id: string; name: string; input: {}; }' is not assignable to type 'ToolUseBlockParam'. Types of property 'type' are incompatible. Type 'string' is not assignable to type '\"tool_use\"'.",
  },
  {
    owners: ['tui-bundler'],
    file: 'packages/exf-cli/interactive-tui/openfunction/framework/adapters/anthropic.ts',
    code: 2352,
    messageHash: 'b35ea10d77724a58a6d7fd0f561630eaf6bcde43540c437496da05f5034f75ec',
    max: 1,
    message: "Conversion of type 'Record<string, unknown>' to type 'ToolChoice' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first. Type 'Record<string, unknown>' is missing the following properties from type 'ToolChoiceTool': name, type",
  },
  {
    owners: ['tui-bundler'],
    file: 'packages/exf-cli/interactive-tui/openfunction/providers/execufunction/index.ts',
    code: 2322,
    messageHash: '42862ac2d154c3f83f699427129ba426e6193325eab612db3bdc6d7c41d7dc6e',
    max: 1,
    message: 'Type \'"code-memory"\' is not assignable to type \'ContextCapability\'.',
  },
  {
    owners: ['tui-bundler'],
    file: 'packages/exf-cli/interactive-tui/openfunction/providers/execufunction/tools.ts',
    code: 2554,
    messageHash: '0d7f88caa9641107a48c1e7e16181950d9d374636b6c4d2f833dab296c63e034',
    max: 3,
    message: 'Expected 2 arguments, but got 1.',
  },
  {
    owners: ['tui-bundler'],
    file: 'packages/exf-cli/interactive-tui/openfunction/providers/siftable/tools.ts',
    code: 2554,
    messageHash: '0d7f88caa9641107a48c1e7e16181950d9d374636b6c4d2f833dab296c63e034',
    max: 3,
    message: 'Expected 2 arguments, but got 1.',
  },
  {
    owners: ['tui-bundler'],
    file: 'packages/exf-cli/test/brain.branch-tools.test.ts',
    code: 2740,
    messageHash: '75448c7aa7e6f89d42cf53e0fea89f8eee9a9abd0576a339ec7542d24ea625df',
    max: 1,
    message: "Type '{ spawnChild: () => { ok: false; reason: string; }; listChildSessions: () => any[]; getChild: () => any; reviewChild: () => { ok: false; reason: string; }; commitChild: () => { ok: false; reason: string; }; listMergeReadiness: Mock<...>; ... 4 more ...; removeChild: () => { ...; }; }' is missing the following properties from type 'ChildSessionController': resolveLaunch, spawnOrAdoptChild, adoptChild, abandonChild, and 2 more.",
  },
  {
    owners: ['tui-bundler'],
    file: 'packages/exf-cli/test/branches.recovery.e2e.test.ts',
    code: 2345,
    messageHash: '9a392444965fabb24a46e98c330721cf9745f103d965750f7a5a9f77f14ab6c7',
    max: 1,
    message: "Argument of type '{ phase: \"spawned\"; session?: undefined; runId: string; updatedAtMs: number; work: MergeMasterWorkIdentity; launch: ChildSessionLaunchRecord; credentials: { ...; }; } | { ...; } | { ...; } | { ...; }' is not assignable to parameter of type 'ChildSessionRecoveryRecord'. Type '{ phase: \"spawned\"; session?: undefined; runId: string; updatedAtMs: number; work: MergeMasterWorkIdentity; launch: ChildSessionLaunchRecord; credentials: { claimOwner: string; claimToken: string; }; }' is not assignable to type 'ChildSessionRecoveryRecord'. Type '{ phase: \"spawned\"; session?: undefined; runId: string; updatedAtMs: number; work: MergeMasterWorkIdentity; launch: ChildSessionLaunchRecord; credentials: { claimOwner: string; claimToken: string; }; }' is not assignable to type 'ActiveChildSessionRecoveryRecord'. Property 'session' is optional in type '{ phase: \"spawned\"; session?: undefined; runId: string; updatedAtMs: number; work: MergeMasterWorkIdentity; launch: ChildSessionLaunchRecord; credentials: { ...; }; }' but required in type 'ActiveChildSessionRecoveryRecord'.",
  },
  {
    owners: ['tui-bundler'],
    file: 'packages/exf-cli/test/childSessionController.test.ts',
    code: 2339,
    messageHash: 'fadf588a8a589bbab7ffe85cec5d33c0eccc07ee9bb25b34c80f21e62a1fa7f0',
    max: 1,
    message: "Property 'reason' does not exist on type 'SpawnChildResult'. Property 'reason' does not exist on type '{ ok: true; session: ChildSessionRecord; }'.",
  },
  {
    owners: ['tui-bundler'],
    file: 'packages/exf-cli/test/commands/interactive.anthropic-recorded.test.ts',
    code: 2339,
    messageHash: '5711a9ac075d559443faf45e45973a179319155b4a3fc8ebee2f1012868b682b',
    max: 1,
    message: "Property 'message' does not exist on type 'AdapterResponse | (Error & { cause?: Error; })'. Property 'message' does not exist on type 'AdapterResponse'.",
  },
  {
    owners: ['tui-bundler'],
    file: 'packages/exf-cli/test/commands/interactive.anthropic-recorded.test.ts',
    code: 2339,
    messageHash: 'a38135a42a5a1a58131a9c42e2c9ede7897f623c53939a94d2bb995f7bbe5a05',
    max: 1,
    message: "Property 'cause' does not exist on type 'AdapterResponse | (Error & { cause?: Error; })'. Property 'cause' does not exist on type 'AdapterResponse'.",
  },
]);

function fail(message) {
  throw new Error(message);
}

function slash(path) {
  return path.split(sep).join('/');
}

function normalizeMessage(message) {
  return String(message).replace(/\s+/gu, ' ').trim();
}

function messageHash(message) {
  return createHash('sha256').update(normalizeMessage(message)).digest('hex');
}

function testRoot(path) {
  return TEST_ROOT_PATTERN.test(path);
}

function scanSkippedDirectory(directory) {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`test root walk rejects symlink ${path}`);
    if (entry.isDirectory()) scanSkippedDirectory(path);
    else if (testRoot(entry.name)) fail(`skipped directory hides test root ${path}`);
  }
}

export function walkTestRoots(directory, {root = directory} = {}) {
  const roots = [];
  function visit(current) {
    for (const entry of readdirSync(current, {withFileTypes: true})) {
      const path = resolve(current, entry.name);
      if (entry.isSymbolicLink()) fail(`test root walk rejects symlink ${path}`);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) scanSkippedDirectory(path);
        else visit(path);
      } else if (testRoot(entry.name)) {
        roots.push(slash(relative(root, path)));
      }
    }
  }
  visit(directory);
  return roots.sort();
}

function formatConfigErrors(errors) {
  return ts.formatDiagnostics(errors, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => REPO_ROOT,
    getNewLine: () => '\n',
  });
}

function literalTestIncludes(config, root) {
  if (config.include === undefined) return [];
  if (!Array.isArray(config.include) || config.include.some((entry) => typeof entry !== 'string')) {
    fail('compiler config include must be an array of strings');
  }
  return config.include.filter((entry) => {
    if (!testRoot(entry)) return false;
    if (/[*?{}[\]]/u.test(entry)) fail(`test reservation must be literal: ${entry}`);
    return true;
  }).map((entry) => slash(relative(root, resolve(root, entry)))).sort();
}

export function parseCompilerConfig(config) {
  if (!config || typeof config !== 'object' || typeof config.name !== 'string' || typeof config.path !== 'string') {
    fail('malformed compiler configuration descriptor');
  }
  const root = resolve(config.root ?? dirname(config.path));
  const read = ts.readConfigFile(config.path, ts.sys.readFile);
  if (read.error) fail(formatConfigErrors([read.error]));
  if (!read.config || typeof read.config !== 'object') fail(`${config.name} compiler config is malformed`);
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(config.path),
    undefined,
    config.path,
  );
  if (parsed.errors.length) fail(formatConfigErrors(parsed.errors));
  if (parsed.options.module !== config.module) fail(`${config.name} has the wrong module kind`);
  if (parsed.options.moduleResolution !== config.moduleResolution) {
    fail(`${config.name} has the wrong module resolution`);
  }
  const roots = parsed.fileNames.filter(testRoot).map((path) => slash(relative(root, path))).sort();
  const reservedIncludes = literalTestIncludes(read.config, root);
  return {
    name: config.name,
    parsed,
    roots,
    reservedIncludes,
    absentReservations: reservedIncludes.filter((path) => !roots.includes(path)),
  };
}

export function deriveOwnership({discovered, configs}) {
  if (!Array.isArray(discovered) || !Array.isArray(configs)) fail('ownership inputs must be arrays');
  const discoveredSet = new Set(discovered);
  if (discoveredSet.size !== discovered.length) fail('filesystem walk returned duplicate test roots');
  const owners = new Map();
  const counts = {};
  for (const config of configs) {
    if (!config || typeof config.name !== 'string' || !Array.isArray(config.roots)) {
      fail('malformed ownership configuration');
    }
    if (Object.hasOwn(counts, config.name)) fail(`duplicate compiler owner ${config.name}`);
    const configRoots = new Set(config.roots);
    if (configRoots.size !== config.roots.length) fail(`${config.name} lists a test root more than once`);
    counts[config.name] = 0;
    for (const root of configRoots) {
      if (!discoveredSet.has(root)) fail(`compiler inventory contains unexpected test ${root}`);
      const current = owners.get(root) ?? [];
      current.push(config.name);
      owners.set(root, current);
      counts[config.name] += 1;
    }
  }
  for (const root of discovered) {
    const current = owners.get(root) ?? [];
    if (current.length !== 1) {
      fail(`${root} must have exactly one compiler owner; found ${current.join(', ') || 'none'}`);
    }
  }
  return {tests: discovered.length, counts, owners};
}

export function assertNoInteractiveTuiSource(name, sourceFiles) {
  if (!Array.isArray(sourceFiles)) fail(`${name} source file inventory is malformed`);
  const crossing = sourceFiles.find((source) => {
    const fileName = typeof source === 'string' ? source : source?.fileName;
    if (typeof fileName !== 'string') fail(`${name} source file inventory is malformed`);
    const declaration = typeof source === 'string'
      ? /\.d\.[cm]?ts$/u.test(fileName)
      : source.isDeclarationFile === true;
    return !declaration && slash(fileName).includes('/interactive-tui/');
  });
  if (crossing) fail(`${name} test graph crossed into non-declaration interactive-tui source`);
}

export function toDiagnosticRecord(diagnostic, {repoRoot = REPO_ROOT} = {}) {
  if (!diagnostic || !Number.isInteger(diagnostic.code) || diagnostic.code <= 0) {
    fail('malformed compiler diagnostic code');
  }
  if (diagnostic.messageText === undefined || diagnostic.messageText === null) {
    fail('malformed compiler diagnostic message');
  }
  const message = normalizeMessage(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
  if (!message) fail('malformed compiler diagnostic message');
  if (diagnostic.start !== undefined && diagnostic.start !== null && !diagnostic.file) {
    fail('malformed compiler diagnostic has a start position without a file');
  }
  if (diagnostic.file && (typeof diagnostic.file.fileName !== 'string' || !diagnostic.file.fileName)) {
    fail('malformed compiler diagnostic file');
  }
  if (diagnostic.start !== undefined && diagnostic.start !== null
    && (!Number.isInteger(diagnostic.start) || diagnostic.start < 0)) {
    fail('malformed compiler diagnostic start position');
  }
  let line = 1;
  let column = 1;
  if (diagnostic.file && diagnostic.start !== undefined && diagnostic.start !== null) {
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character)) {
      fail('malformed compiler diagnostic location');
    }
    line = position.line + 1;
    column = position.character + 1;
  }
  return {
    code: diagnostic.code,
    file: diagnostic.file ? slash(relative(repoRoot, diagnostic.file.fileName)) : '<global>',
    line,
    column,
    message,
    messageHash: messageHash(message),
  };
}

function validateOwners(owners) {
  if (!Array.isArray(owners) || owners.length === 0 || owners.some((owner) => typeof owner !== 'string' || !owner)) {
    fail('diagnostic owner set is malformed');
  }
  const sorted = [...new Set(owners)].sort();
  if (sorted.length !== owners.length || sorted.some((owner, index) => owner !== owners[index])) {
    fail('diagnostic owner set must be unique and sorted');
  }
  return sorted;
}

function validateRelativeFile(file) {
  if (file === '<global>') return file;
  if (typeof file !== 'string' || !file || isAbsolute(file) || slash(file).split('/').includes('..')) {
    fail('diagnostic file must be repository-relative');
  }
  return slash(file);
}

function groupKey(record) {
  return `${record.owners.join('+')}|${record.file}|TS${record.code}|${record.messageHash}`;
}

export function loadCeiling(entries) {
  if (!Array.isArray(entries)) fail('diagnostic ceiling must be an array');
  const ceiling = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') fail('diagnostic ceiling entry is malformed');
    const owners = validateOwners(entry.owners);
    const file = validateRelativeFile(entry.file);
    if (!Number.isInteger(entry.code) || entry.code <= 0) fail('diagnostic ceiling code is malformed');
    if (FORBIDDEN_DIAGNOSTIC_CODES.has(entry.code)) fail(`TS${entry.code} is categorically forbidden`);
    if (typeof entry.messageHash !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.messageHash)) {
      fail('diagnostic ceiling message hash is malformed');
    }
    if (!Number.isInteger(entry.max) || entry.max <= 0) fail('diagnostic ceiling maximum is malformed');
    if (typeof entry.message !== 'string' || !normalizeMessage(entry.message)) {
      fail('diagnostic ceiling evidence message is malformed');
    }
    if (messageHash(entry.message) !== entry.messageHash) fail('diagnostic ceiling message hash mismatch');
    const normalized = {...entry, owners, file, message: normalizeMessage(entry.message)};
    const key = groupKey(normalized);
    if (ceiling.has(key)) fail(`duplicate diagnostic ceiling group ${key}`);
    ceiling.set(key, normalized);
  }
  return ceiling;
}

export function assertNoForbiddenCodes(records) {
  if (!Array.isArray(records)) fail('compiler diagnostic inventory must be an array');
  const forbidden = records.find((record) => FORBIDDEN_DIAGNOSTIC_CODES.has(record?.code));
  if (forbidden) fail(`TS${forbidden.code} is categorically forbidden`);
}

function validateRecord(record) {
  if (!record || typeof record !== 'object') fail('compiler diagnostic record is malformed');
  const owners = validateOwners(record.owners);
  const file = validateRelativeFile(record.file);
  if (!Number.isInteger(record.code) || record.code <= 0) fail('compiler diagnostic record code is malformed');
  if (typeof record.messageHash !== 'string' || !/^[0-9a-f]{64}$/u.test(record.messageHash)) {
    fail('compiler diagnostic record message hash is malformed');
  }
  if (!Number.isInteger(record.line) || record.line <= 0
    || !Number.isInteger(record.column) || record.column <= 0) {
    fail('compiler diagnostic record location is malformed');
  }
  if (typeof record.message !== 'string' || messageHash(record.message) !== record.messageHash) {
    fail('compiler diagnostic record message is malformed');
  }
  return {...record, owners, file, message: normalizeMessage(record.message)};
}

export function compareToCeiling(records, ceilingInput) {
  assertNoForbiddenCodes(records);
  const ceiling = ceilingInput instanceof Map ? ceilingInput : loadCeiling(ceilingInput);
  const counts = new Map();
  for (const record of records.map(validateRecord)) {
    const key = groupKey(record);
    if (!ceiling.has(key)) fail(`new diagnostic ceiling group ${key}`);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    const maximum = ceiling.get(key).max;
    if (count > maximum) fail(`diagnostic ceiling increased for ${key}: ${count} > ${maximum}`);
  }
  return {groups: counts.size, diagnostics: records.length};
}

export function buildReport({ownership, records}) {
  if (!ownership || !ownership.counts || !Array.isArray(records)) fail('report inputs are malformed');
  return {
    status: 'pass',
    mode: 'reviewed-baseline',
    tests: ownership.tests,
    ownership: {
      node16: ownership.counts.node16 ?? 0,
      'tui-bundler': ownership.counts['tui-bundler'] ?? 0,
    },
    diagnostics: records.length,
  };
}

function collectDiagnosticRecords(programs) {
  const occurrences = new Map();
  for (const {name, program} of programs) {
    for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
      const record = toDiagnosticRecord(diagnostic);
      const occurrenceKey = `${record.file}|TS${record.code}|${record.messageHash}|${record.line}|${record.column}`;
      const existing = occurrences.get(occurrenceKey);
      if (existing) {
        if (existing.owners.includes(name)) fail(`${name} emitted duplicate diagnostic ${occurrenceKey}`);
        existing.owners.push(name);
        existing.owners.sort();
      } else {
        occurrences.set(occurrenceKey, {...record, owners: [name]});
      }
    }
  }
  return [...occurrences.values()];
}

export function runVerification() {
  const parsedConfigs = LIVE_CONFIGS.map(parseCompilerConfig);
  const node16 = parsedConfigs.find((config) => config.name === 'node16');
  const bundler = parsedConfigs.find((config) => config.name === 'tui-bundler');
  if (!node16 || !bundler) fail('required compiler configurations are missing');
  if (node16.reservedIncludes.length !== 0) fail('Node16 config must not reserve future test roots');
  if (JSON.stringify(bundler.reservedIncludes) !== JSON.stringify([FUTURE_RESERVATION])) {
    fail(`Bundler config must reserve only ${FUTURE_RESERVATION}`);
  }
  const discovered = walkTestRoots(resolve(CLI_ROOT, 'test'), {root: CLI_ROOT});
  const ownership = deriveOwnership({discovered, configs: parsedConfigs});
  const programs = parsedConfigs.map((config) => ({
    name: config.name,
    program: ts.createProgram(config.parsed.fileNames, config.parsed.options),
  }));
  const node16Program = programs.find((entry) => entry.name === 'node16');
  assertNoInteractiveTuiSource('node16', node16Program?.program.getSourceFiles() ?? []);
  const records = collectDiagnosticRecords(programs);
  compareToCeiling(records, loadCeiling(REVIEWED_CEILING));
  return buildReport({ownership, records});
}

function isMain() {
  return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(SCRIPT_PATH);
}

if (isMain()) {
  if (process.argv.slice(2).length !== 0) fail('unknown verifier arguments');
  console.log(JSON.stringify(runVerification(), null, 2));
}

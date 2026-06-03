import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  buildExplorerReport,
  chatInputText,
  classifyExplorerPrompt,
  clearRepoExplorerCache,
  compileExplorerQueries,
  formatExplorerReport,
  prepareExplorerInput,
} from '../../interactive-tui/explorer';
import {openfunctionAsk, setBrainModel, type BrainEvent} from '../../interactive-tui/brain';

describe('interactive repo explorer preflight', () => {
  let root: string;

  beforeEach(async () => {
    clearRepoExplorerCache();
    root = await mkdtemp(join(tmpdir(), 'sift-explorer-'));
    await mkdir(join(root, 'src'), {recursive: true});
    await mkdir(join(root, 'native'), {recursive: true});
    await mkdir(join(root, 'test'), {recursive: true});
    await mkdir(join(root, 'node_modules', 'junk'), {recursive: true});
    await mkdir(join(root, 'dist'), {recursive: true});
    await writeFile(join(root, 'package.json'), '{"name":"explorer-fixture"}\n', 'utf8');
    await writeFile(
      join(root, 'src', 'fsEngine.ts'),
      'export function searchLiteral() {\n  return "local search needle";\n}\n',
      'utf8',
    );
    await writeFile(
      join(root, 'src', 'brain.ts'),
      'import { searchLiteral } from "./fsEngine";\nexport function openfunctionAsk() { return `local search ${searchLiteral()}`; }\n',
      'utf8',
    );
    await writeFile(
      join(root, 'native', 'fs_engine.zig'),
      'pub fn sift_fs_search_literal() []const u8 { return "local search native"; }\n',
      'utf8',
    );
    await writeFile(
      join(root, 'test', 'interactive.fs-engine.test.ts'),
      'it("covers local search", () => expect("local search").toContain("search"));\n',
      'utf8',
    );
    await writeFile(
      join(root, 'node_modules', 'junk', 'index.js'),
      'module.exports = "local search vendor noise";\n',
      'utf8',
    );
    await writeFile(
      join(root, 'dist', 'bundle.js'),
      'console.log("local search bundled noise");\n',
      'utf8',
    );
  });

  afterEach(async () => {
    clearRepoExplorerCache();
    await rm(root, {recursive: true, force: true});
  });

  it('skips ordinary non-code prompts', () => {
    expect(classifyExplorerPrompt('what are my tasks today?')).toBe('skipped');
  });

  it('classifies broad codebase investigations', () => {
    expect(classifyExplorerPrompt('look into how searchLiteral is handled in fsEngine.ts')).toBe('broad');
  });

  it('extracts identifier and path-oriented queries', () => {
    const queries = compileExplorerQueries('look into "searchLiteral" in packages/exf-cli/interactive-tui/fsEngine.ts', 5);

    expect(queries).toContain('searchLiteral');
    expect(queries).toContain('packages/exf-cli/interactive-tui/fsEngine.ts');
  });

  it('injects a compact report with likely files and recommended reads', async () => {
    const prepared = await prepareExplorerInput('look into searchLiteral in fsEngine.ts', {root});

    expect(prepared.injected).toBe(true);
    expect(prepared.report.mode).toBe('broad');
    expect(prepared.report.likelyFiles.map((file) => file.path)).toContain('src/fsEngine.ts');
    expect(prepared.report.recommendedReads.some((read) => read.path === 'src/fsEngine.ts')).toBe(true);
    expect(prepared.report.metrics).toMatchObject({
      triggered: true,
      classification: 'broad',
      queriesRun: expect.any(Number),
      capped: expect.any(Boolean),
    });
    expect(prepared.report.metrics.reportChars).toBeGreaterThan(0);
    expect(prepared.input).toEqual(expect.stringContaining('<repo_explorer_report>'));
    expect(prepared.input).toEqual(expect.stringContaining('User request:'));
  });

  it('keeps broad reports ranked around expected files and bounded', async () => {
    const report = await buildExplorerReport(
      'investigate how openfunctionAsk handles searchLiteral in brain.ts and fsEngine.ts',
      {root},
    );
    const topPaths = report.likelyFiles.slice(0, 3).map((file) => file.path);
    const formatted = formatExplorerReport(report);

    expect(topPaths).toEqual(expect.arrayContaining(['src/brain.ts', 'src/fsEngine.ts']));
    expect(report.recommendedReads.map((read) => read.path)).toEqual(
      expect.arrayContaining(['src/brain.ts', 'src/fsEngine.ts']),
    );
    expect(report.likelyFiles.length).toBeLessThanOrEqual(12);
    expect(report.recommendedReads.length).toBeLessThanOrEqual(8);
    expect(formatted.length).toBeLessThan(2500);
  });

  it('reuses and explicitly invalidates the session explorer cache', async () => {
    const first = await buildExplorerReport('scour this repo and explain how local search works', {root});
    const second = await buildExplorerReport('scour this repo and explain how local search works', {root});

    expect(first.metrics.cacheMiss).toBe(true);
    expect(first.metrics.cacheHit).toBe(false);
    expect(second.metrics.cacheHit).toBe(true);
    expect(second.metrics.cacheMiss).toBe(false);
    expect(second.metrics.fileSetId).toBe(first.metrics.fileSetId);

    clearRepoExplorerCache(root);
    const afterClear = await buildExplorerReport('scour this repo and explain how local search works', {root});
    expect(afterClear.metrics.cacheHit).toBe(false);
    expect(afterClear.metrics.cacheMiss).toBe(true);
  });

  it('goldens broad local-search reports without vendor or build noise', async () => {
    const report = await buildExplorerReport('scour this repo and explain how local search works', {root});
    const formatted = formatExplorerReport(report);

    expect(formatted).toContain('<repo_explorer_report>');
    expect(formatted).toContain('</repo_explorer_report>');
    expect(formatted).toContain('src/fsEngine.ts');
    expect(formatted).toContain('native/fs_engine.zig');
    expect(formatted).toContain('src/brain.ts');
    expect(formatted).toContain('test/interactive.fs-engine.test.ts');
    expect(formatted).toContain('primary_candidates:');
    expect(formatted).toContain('supporting_candidates:');
    expect(formatted).toContain('tests:');
    expect(formatted).toContain('native:');
    expect(formatted).toContain('config_docs:');
    expect(formatted).not.toContain('node_modules/junk');
    expect(formatted).not.toContain('dist/bundle');
    expect(formatted.length).toBeLessThan(12000);
    expect(report.candidateGroups.primaryCandidates.map((file) => file.path)).toEqual(
      expect.arrayContaining(['src/fsEngine.ts', 'src/brain.ts']),
    );
    expect(report.candidateGroups.native.map((file) => file.path)).toContain('native/fs_engine.zig');
    expect(report.candidateGroups.tests.map((file) => file.path)).toContain('test/interactive.fs-engine.test.ts');
    expect(report.metrics).toMatchObject({
      triggered: true,
      classification: 'broad',
      queriesRun: report.queriesRun.length,
      filesSearched: report.diagnostics.filesSearched,
      bytesScanned: report.diagnostics.bytesScanned,
      reportChars: formatted.length,
      capped: report.diagnostics.capped,
      capReason: report.diagnostics.capReason,
      cacheMiss: expect.any(Boolean),
      cacheHit: expect.any(Boolean),
    });
    expect(report.metrics.matchesFound).toBeGreaterThan(0);
  });

  it('preserves image parts while prepending the explorer report', async () => {
    const input = [
      {type: 'text' as const, text: 'debug searchLiteral in fsEngine.ts'},
      {type: 'image' as const, mime: 'image/png', dataUrl: 'data:image/png;base64,abc', detail: 'auto' as const},
    ];

    const prepared = await prepareExplorerInput(input, {root});

    expect(Array.isArray(prepared.input)).toBe(true);
    const parts = prepared.input as typeof input;
    expect(parts[0]).toMatchObject({type: 'text'});
    expect(chatInputText(prepared.input)).toContain('<repo_explorer_report>');
    expect(parts.some((part) => part.type === 'image')).toBe(true);
  });

  it('can be disabled explicitly', async () => {
    const prepared = await prepareExplorerInput('look into searchLiteral in fsEngine.ts', {root, enabled: false});

    expect(prepared.injected).toBe(false);
    expect(prepared.report.mode).toBe('skipped');
  });

  it('feeds explorer context into the local brain turn', async () => {
    let capturedInput: unknown;
    (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__ = {
      createChatAgent: async () => ({
        chat: async function* (message: unknown) {
          capturedInput = message;
          yield {type: 'text', text: 'ok'};
          yield {type: 'done', result: {content: 'ok'}};
        },
      }),
      defineTool: (def: unknown) => def,
      ok: (data: unknown, message?: string) => ({success: true, data, message}),
      err: (error: string) => ({success: false, error}),
    };
    const previousCwd = process.env.SIFT_USER_CWD;
    process.env.SIFT_USER_CWD = root;
    setBrainModel({provider: 'openrouter', model: 'test-model'});

    try {
      const events: BrainEvent[] = [];
      const result = await openfunctionAsk('look into searchLiteral in fsEngine.ts', (event) => events.push(event));

      expect(result.text).toBe('ok');
      expect(events.map((event) => event.type)).toContain('tool_call');
      expect(events.some((event) => event.toolCall?.name === 'repo_explorer')).toBe(true);
      expect(String(capturedInput)).toContain('<repo_explorer_report>');
      expect(String(capturedInput)).toContain('src/fsEngine.ts');
    } finally {
      if (previousCwd === undefined) delete process.env.SIFT_USER_CWD;
      else process.env.SIFT_USER_CWD = previousCwd;
      delete (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__;
    }
  });

  it('prints the raw report when explorer debug is enabled', async () => {
    let capturedInput: unknown;
    const previousCwd = process.env.SIFT_USER_CWD;
    const previousDebug = process.env.SIFT_EXPLORER_DEBUG;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__ = {
      createChatAgent: async () => ({
        chat: async function* (message: unknown) {
          capturedInput = message;
          yield {type: 'text', text: 'ok'};
          yield {type: 'done', result: {content: 'ok'}};
        },
      }),
      defineTool: (def: unknown) => def,
      ok: (data: unknown, message?: string) => ({success: true, data, message}),
      err: (error: string) => ({success: false, error}),
    };
    process.env.SIFT_USER_CWD = root;
    process.env.SIFT_EXPLORER_DEBUG = '1';
    setBrainModel({provider: 'openrouter', model: 'test-model'});

    try {
      await openfunctionAsk('scour this repo and explain how local search works', () => undefined);

      expect(String(capturedInput)).toContain('<repo_explorer_report>');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('<repo_explorer_report>'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Metrics:'));
    } finally {
      if (previousCwd === undefined) delete process.env.SIFT_USER_CWD;
      else process.env.SIFT_USER_CWD = previousCwd;
      if (previousDebug === undefined) delete process.env.SIFT_EXPLORER_DEBUG;
      else process.env.SIFT_EXPLORER_DEBUG = previousDebug;
      delete (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__;
      errorSpy.mockRestore();
    }
  });

  it('tracks whether the main model uses suggested files after the report', async () => {
    let capturedInput: unknown;
    const previousCwd = process.env.SIFT_USER_CWD;
    const previousDebug = process.env.SIFT_EXPLORER_DEBUG;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__ = {
      createChatAgent: async () => ({
        chat: async function* (message: unknown) {
          capturedInput = message;
          if (String(message).includes('src/fsEngine.ts')) {
            yield {type: 'tool_call', toolCall: {name: 'read_file', args: {path: 'src/fsEngine.ts'}}};
            yield {type: 'tool_result', toolResult: {name: 'read_file', success: true}};
          }
          yield {type: 'text', text: 'ok'};
          yield {type: 'done', result: {content: 'ok'}};
        },
      }),
      defineTool: (def: unknown) => def,
      ok: (data: unknown, message?: string) => ({success: true, data, message}),
      err: (error: string) => ({success: false, error}),
    };
    process.env.SIFT_USER_CWD = root;
    process.env.SIFT_EXPLORER_DEBUG = '1';
    setBrainModel({provider: 'openrouter', model: 'test-model'});

    try {
      const events: BrainEvent[] = [];
      await openfunctionAsk('scour this repo and explain how local search works', (event) => events.push(event));

      expect(String(capturedInput)).toContain('<repo_explorer_report>');
      expect(events.some((event) => event.toolCall?.name === 'read_file')).toBe(true);
      const summary = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('repo_explorer_effectiveness:'));
      expect(summary).toContain('usedSuggestedFiles=src/fsEngine.ts');
      expect(summary).toContain('postExplorerReadCalls=1');
      expect(summary).toContain('launchedRedundantBroadSearch=false');
    } finally {
      if (previousCwd === undefined) delete process.env.SIFT_USER_CWD;
      else process.env.SIFT_USER_CWD = previousCwd;
      if (previousDebug === undefined) delete process.env.SIFT_EXPLORER_DEBUG;
      else process.env.SIFT_EXPLORER_DEBUG = previousDebug;
      delete (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__;
      errorSpy.mockRestore();
    }
  });

  it('does not emit an effectiveness record when explorer is skipped or disabled', async () => {
    const previousCwd = process.env.SIFT_USER_CWD;
    const previousDebug = process.env.SIFT_EXPLORER_DEBUG;
    const previousExplorer = process.env.SIFT_EXPLORER;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__ = {
      createChatAgent: async () => ({
        chat: async function* () {
          yield {type: 'tool_call', toolCall: {name: 'read_file', args: {path: 'src/fsEngine.ts'}}};
          yield {type: 'done', result: {content: 'ok'}};
        },
      }),
      defineTool: (def: unknown) => def,
      ok: (data: unknown, message?: string) => ({success: true, data, message}),
      err: (error: string) => ({success: false, error}),
    };
    process.env.SIFT_USER_CWD = root;
    process.env.SIFT_EXPLORER_DEBUG = '1';
    setBrainModel({provider: 'openrouter', model: 'test-model'});

    try {
      await openfunctionAsk('explain why Napoleon lost in Russia', () => undefined);
      process.env.SIFT_EXPLORER = 'off';
      await openfunctionAsk('scour this repo and explain how local search works', () => undefined);

      expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('repo_explorer_effectiveness:'))).toBe(false);
    } finally {
      if (previousCwd === undefined) delete process.env.SIFT_USER_CWD;
      else process.env.SIFT_USER_CWD = previousCwd;
      if (previousDebug === undefined) delete process.env.SIFT_EXPLORER_DEBUG;
      else process.env.SIFT_EXPLORER_DEBUG = previousDebug;
      if (previousExplorer === undefined) delete process.env.SIFT_EXPLORER;
      else process.env.SIFT_EXPLORER = previousExplorer;
      delete (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__;
      errorSpy.mockRestore();
    }
  });
});

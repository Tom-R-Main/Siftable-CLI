import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  buildExplorerReport,
  chatInputText,
  classifyExplorerPrompt,
  compileExplorerQueries,
  formatExplorerReport,
  prepareExplorerInput,
} from '../../interactive-tui/explorer';
import {openfunctionAsk, setBrainModel, type BrainEvent} from '../../interactive-tui/brain';

describe('interactive repo explorer preflight', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sift-explorer-'));
    await mkdir(join(root, 'src'), {recursive: true});
    await writeFile(join(root, 'package.json'), '{"name":"explorer-fixture"}\n', 'utf8');
    await writeFile(
      join(root, 'src', 'fsEngine.ts'),
      'export function searchLiteral() {\n  return "needle";\n}\n',
      'utf8',
    );
    await writeFile(
      join(root, 'src', 'brain.ts'),
      'import { searchLiteral } from "./fsEngine";\nexport function openfunctionAsk() { return searchLiteral(); }\n',
      'utf8',
    );
  });

  afterEach(async () => {
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
});

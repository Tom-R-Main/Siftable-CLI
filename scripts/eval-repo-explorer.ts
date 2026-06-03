#!/usr/bin/env tsx
import { performance } from 'node:perf_hooks';
import { openfunctionAsk, setBrainModel, type BrainEvent } from '../interactive-tui/brain';

type EvalMode = 'off' | 'deterministic' | 'scout';

interface EvalRun {
  prompt: string;
  mode: EvalMode;
  elapsedMs: number;
  explorerElapsedMs: number;
  scoutElapsedMs: number;
  reportChars: number;
  postExplorerToolCalls: number;
  postExplorerSearchCalls: number;
  postExplorerReadCalls: number;
  usedSuggestedFiles: string[];
  usedScoutSuggestedFiles: string[];
  launchedRedundantBroadSearch: boolean;
  scoutSuggestedFiles: string[];
  scoutFailed: boolean;
  scoutFailureReason?: string;
  finalAnswerQualityNotes: string;
  error?: string;
}

const PROMPTS = [
  'scour this repo and explain how local search works',
  'find where repo_explorer is injected into the model turn',
  'why might the search tool skip files unexpectedly?',
  'map the path from a TUI prompt to OpenFunction/Codex',
  'find the tests that prove explorer behavior',
  'where should we add parallel scout fan-out?',
  'explain the native/TS fallback boundary for file search',
  'what code handles tool events in the TUI?',
];

const args = new Set(process.argv.slice(2));
const jsonOnly = args.has('--json');
const useRealAgent = args.has('--real-agent');
const prompts = args.has('--quick') ? PROMPTS.slice(0, 2) : PROMPTS;

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (!useRealAgent) installFakeOpenFunction();

  const root = process.env.SIFT_USER_CWD || process.cwd();
  const results: EvalRun[] = [];
  for (const prompt of prompts) {
    for (const mode of ['off', 'deterministic', 'scout'] as EvalMode[]) {
      results.push(await runPrompt(prompt, mode, root));
    }
  }

  if (jsonOnly) {
    process.stdout.write(`${JSON.stringify({ root, fakeAgent: !useRealAgent, results }, null, 2)}\n`);
  } else {
    printMarkdown(root, !useRealAgent, results);
  }
}

async function runPrompt(prompt: string, mode: EvalMode, cwd: string): Promise<EvalRun> {
  const previousExplorer = process.env.SIFT_EXPLORER;
  const previousScout = process.env.SIFT_EXPLORER_SCOUT;
  const previousDebug = process.env.SIFT_EXPLORER_DEBUG;
  const previousCwd = process.env.SIFT_USER_CWD;
  const previousConsoleError = console.error;
  const debugLines: string[] = [];
  const events: BrainEvent[] = [];
  const startedAt = performance.now();
  process.env.SIFT_USER_CWD = cwd;
  process.env.SIFT_EXPLORER_DEBUG = '1';
  if (mode === 'off') {
    process.env.SIFT_EXPLORER = 'off';
    delete process.env.SIFT_EXPLORER_SCOUT;
  } else {
    process.env.SIFT_EXPLORER = 'on';
    process.env.SIFT_EXPLORER_SCOUT = mode === 'scout' ? '1' : '0';
  }
  console.error = (...parts: unknown[]) => {
    debugLines.push(parts.map(String).join(' '));
  };
  setBrainModel({ provider: process.env.EXECUTERM_MODEL_PROVIDER || 'openrouter', model: process.env.EXECUTERM_MODEL || 'repo-explorer-eval' });

  try {
    const result = await openfunctionAsk(prompt, (event) => events.push(event));
    const elapsedMs = Math.round(performance.now() - startedAt);
    const effectiveness = parseEffectiveness(debugLines.find((line) => line.includes('repo_explorer_effectiveness:')) || '');
    const reportText = debugLines.find((line) => line.includes('<repo_explorer_report>')) || '';
    return {
      prompt,
      mode,
      elapsedMs,
      explorerElapsedMs: Number(metricFromReport(reportText, 'elapsedMs') || 0),
      scoutElapsedMs: Number(effectiveness.scoutElapsedMs || 0),
      reportChars: Number(effectiveness.reportChars || metricFromReport(reportText, 'reportChars') || 0),
      postExplorerToolCalls: Number(effectiveness.postExplorerToolCalls || events.filter((event) => event.type === 'tool_call').length),
      postExplorerSearchCalls: Number(effectiveness.postExplorerSearchCalls || events.filter((event) => isSearchTool(event.toolCall?.name)).length),
      postExplorerReadCalls: Number(effectiveness.postExplorerReadCalls || events.filter((event) => isReadTool(event.toolCall?.name)).length),
      usedSuggestedFiles: splitList(effectiveness.usedSuggestedFiles),
      usedScoutSuggestedFiles: splitList(effectiveness.usedScoutSuggestedFiles),
      launchedRedundantBroadSearch: effectiveness.launchedRedundantBroadSearch === 'true',
      scoutSuggestedFiles: splitList(effectiveness.scoutSuggestedFiles),
      scoutFailed: effectiveness.scoutFailed === 'true',
      ...(effectiveness.scoutFailureReason ? { scoutFailureReason: effectiveness.scoutFailureReason } : {}),
      finalAnswerQualityNotes: '',
      ...(result.error ? { error: result.error } : {}),
    };
  } finally {
    console.error = previousConsoleError;
    restoreEnv('SIFT_EXPLORER', previousExplorer);
    restoreEnv('SIFT_EXPLORER_SCOUT', previousScout);
    restoreEnv('SIFT_EXPLORER_DEBUG', previousDebug);
    restoreEnv('SIFT_USER_CWD', previousCwd);
  }
}

function installFakeOpenFunction(): void {
  (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__ = {
    createChatAgent: async (config: Record<string, unknown>) => ({
      chat: async function* (message: unknown) {
        const text = String(message);
        if (config.name === 'siftable-repo-explorer-scout') {
          yield {
            type: 'text',
            text: JSON.stringify(fakeScoutReport(text)),
          };
          yield { type: 'done', result: { content: '' } };
          return;
        }
        const path = firstSuggestedPath(text);
        if (text.includes('<repo_explorer_report>') && path) {
          yield { type: 'tool_call', toolCall: { name: 'read_file', args: { path } } };
          yield { type: 'tool_result', toolResult: { name: 'read_file', success: true } };
        } else {
          yield { type: 'tool_call', toolCall: { name: 'search_local_files', args: { query: 'repo_explorer' } } };
          yield { type: 'tool_result', toolResult: { name: 'search_local_files', success: true } };
          yield { type: 'tool_call', toolCall: { name: 'read_file', args: { path: 'packages/exf-cli/interactive-tui/explorer.ts' } } };
          yield { type: 'tool_result', toolResult: { name: 'read_file', success: true } };
        }
        yield { type: 'text', text: 'ok' };
        yield { type: 'done', result: { content: 'ok' } };
      },
    }),
    defineTool: (def: unknown) => def,
    ok: (data: unknown, message?: string) => ({ success: true, data, message }),
    err: (error: string) => ({ success: false, error }),
  };
}

function fakeScoutReport(input: string) {
  const lower = input.toLowerCase();
  const path =
    lower.includes('test') ? 'test/commands/interactive.explorer.test.ts' :
    lower.includes('tool event') ? 'interactive-tui/toolView.ts' :
    lower.includes('codex') ? 'interactive-tui/codexEngine.ts' :
    lower.includes('native') ? 'interactive-tui/native/fs_engine.zig' :
    lower.includes('repo_explorer') ? 'interactive-tui/brain.ts' :
    'interactive-tui/fsEngine.ts';
  return {
    confidence: 0.74,
    missingLikelyFiles: [{ path, reason: 'fake scout candidate for headless eval' }],
    recommendedReads: [{ path, startLine: 1, endLine: 80, reason: 'headless eval read target' }],
    warnings: ['fake-agent eval; run with --real-agent for live quality notes'],
  };
}

function firstSuggestedPath(text: string): string | null {
  const scout = text.match(/model_scout:[\s\S]*?recommended_reads:\n- ([^:\n]+)(?::\d+-\d+)?:/);
  if (scout?.[1]) return scout[1].trim();
  const deterministic = text.match(/Recommended reads:\n- ([^:\n]+)(?::\d+-\d+)?:/);
  return deterministic?.[1]?.trim() || null;
}

function parseEffectiveness(line: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const part of line.split(/\s+/)) {
    const index = part.indexOf('=');
    if (index > 0) output[part.slice(0, index)] = part.slice(index + 1);
  }
  return output;
}

function metricFromReport(text: string, key: string): string {
  return text.match(new RegExp(`${key}=([^;\\s]+)`))?.[1] || '';
}

function splitList(value: string | undefined): string[] {
  if (!value || value === 'none') return [];
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return [];
  return value.split(',').filter(Boolean);
}

function isSearchTool(name: string | undefined): boolean {
  return ['search_local_files', 'code_search', 'find_local_files', 'inspect_local_workspace', 'list_dir'].includes(String(name || ''));
}

function isReadTool(name: string | undefined): boolean {
  return ['read_file', 'batch_read_files'].includes(String(name || ''));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function printMarkdown(root: string, fakeAgent: boolean, runs: EvalRun[]): void {
  console.log(`# Repo Explorer Eval\n`);
  console.log(`root: \`${root}\``);
  console.log(`agent: \`${fakeAgent ? 'fake' : 'real'}\`\n`);
  console.log('| mode | runs | avg elapsed | avg report chars | avg tools | avg searches | avg reads | scout used | redundant broad | scout failed |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const mode of ['off', 'deterministic', 'scout'] as EvalMode[]) {
    const slice = runs.filter((run) => run.mode === mode);
    console.log([
      `| ${mode}`,
      slice.length,
      avg(slice, 'elapsedMs'),
      avg(slice, 'reportChars'),
      avg(slice, 'postExplorerToolCalls'),
      avg(slice, 'postExplorerSearchCalls'),
      avg(slice, 'postExplorerReadCalls'),
      slice.filter((run) => run.usedScoutSuggestedFiles.length > 0).length,
      slice.filter((run) => run.launchedRedundantBroadSearch).length,
      slice.filter((run) => run.scoutFailed).length,
      '|',
    ].join(' | '));
  }
  console.log('\n## Runs\n');
  for (const run of runs) {
    console.log(`- ${run.mode} | ${run.prompt} | elapsed=${run.elapsedMs}ms reportChars=${run.reportChars} tools=${run.postExplorerToolCalls} searches=${run.postExplorerSearchCalls} reads=${run.postExplorerReadCalls} scoutUsed=${run.usedScoutSuggestedFiles.join(',') || 'none'} redundantBroad=${run.launchedRedundantBroadSearch} scoutFailed=${run.scoutFailed}${run.error ? ` error=${run.error}` : ''}`);
  }
}

function avg(runs: EvalRun[], key: keyof EvalRun): number {
  if (!runs.length) return 0;
  const total = runs.reduce((sum, run) => sum + (typeof run[key] === 'number' ? run[key] as number : 0), 0);
  return Math.round(total / runs.length);
}

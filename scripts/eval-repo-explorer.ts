#!/usr/bin/env tsx
import { performance } from 'node:perf_hooks';
import { openfunctionAsk, setBrainModel, type BrainEvent } from '../interactive-tui/brain';
import {
  EXPLORER_EVAL_PROMPTS,
  candidateFilesFromContext,
  fixtureForPrompt,
  metricFromArtifact,
  scoreCandidateFiles,
  summarizeEvalGate,
  type EvalMode,
} from './repo-explorer-eval-core';

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
  fanoutElapsedMs: number;
  fanoutBranchCount: number;
  fanoutFailedBranches: number;
  fanoutAssignedRoles: string[];
  fanoutSuggestedFiles: string[];
  usedFanoutSuggestedFiles: string[];
  fanoutBranchUtility: string[];
  topCandidateFiles: string[];
  filePrecision: number;
  fileRecall: number;
  forbiddenTopFileHit: boolean;
  injectedContextBytes: number;
  finalAnswerQualityNotes: string;
  error?: string;
}

const args = new Set(process.argv.slice(2));
const jsonOnly = args.has('--json');
const useRealAgent = args.has('--real-agent');
const assertGate = args.has('--assert');
const prompts = args.has('--quick') ? EXPLORER_EVAL_PROMPTS.slice(0, 2) : EXPLORER_EVAL_PROMPTS;

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (!useRealAgent) installFakeOpenFunction();

  const root = process.env.SIFT_USER_CWD || process.cwd();
  const results: EvalRun[] = [];
  for (const prompt of prompts) {
    for (const mode of ['off', 'deterministic', 'fast-context', 'scout', 'fanout'] as EvalMode[]) {
      results.push(await runPrompt(prompt, mode, root));
    }
  }
  const gate = summarizeEvalGate(results);

  if (jsonOnly) {
    process.stdout.write(`${JSON.stringify({ root, fakeAgent: !useRealAgent, gate, results }, null, 2)}\n`);
  } else {
    printMarkdown(root, !useRealAgent, results, gate);
  }
  if (assertGate && !gate.passed) {
    console.error(`Repo Explorer eval gate failed: ${gate.errors.join('; ')}`);
    process.exitCode = 1;
  }
}

async function runPrompt(prompt: string, mode: EvalMode, cwd: string): Promise<EvalRun> {
  const previousExplorer = process.env.SIFT_EXPLORER;
  const previousScout = process.env.SIFT_EXPLORER_SCOUT;
  const previousFanout = process.env.SIFT_EXPLORER_FANOUT;
  const previousDebug = process.env.SIFT_EXPLORER_DEBUG;
  const previousThoroughness = process.env.SIFT_EXPLORER_THOROUGHNESS;
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
    delete process.env.SIFT_EXPLORER_FANOUT;
  } else if (mode === 'deterministic') {
    process.env.SIFT_EXPLORER = 'deterministic';
    process.env.SIFT_EXPLORER_SCOUT = '0';
    process.env.SIFT_EXPLORER_FANOUT = '0';
  } else {
    process.env.SIFT_EXPLORER = 'fast-context';
    process.env.SIFT_EXPLORER_SCOUT = mode === 'scout' ? '1' : '0';
    process.env.SIFT_EXPLORER_FANOUT = mode === 'fanout' ? '1' : '0';
    process.env.SIFT_EXPLORER_THOROUGHNESS = 'medium';
  }
  console.error = (...parts: unknown[]) => {
    debugLines.push(parts.map(String).join(' '));
  };
  setBrainModel({ provider: process.env.EXECUTERM_MODEL_PROVIDER || 'openrouter', model: process.env.EXECUTERM_MODEL || 'repo-explorer-eval' });

  try {
    const result = await openfunctionAsk(prompt, (event) => events.push(event));
    const elapsedMs = Math.round(performance.now() - startedAt);
    const effectiveness = parseEffectiveness(debugLines.find((line) => line.includes('repo_explorer_effectiveness:')) || '');
    const reportText = debugLines.find((line) => line.includes('<repo_explorer_artifact>') || line.includes('<repo_explorer_report>')) || '';
    const topCandidateFiles = candidateFilesFromContext(reportText).slice(0, 10);
    const score = scoreCandidateFiles(topCandidateFiles, fixtureForPrompt(prompt));
    const injectedContextBytes = Number(metricFromArtifact(reportText, 'injectedContextBytes') || metricFromReport(reportText, 'reportChars') || reportText.length || 0);
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
      fanoutElapsedMs: Number(effectiveness.fanoutElapsedMs || 0),
      fanoutBranchCount: Number(effectiveness.fanoutBranchCount || 0),
      fanoutFailedBranches: Number(effectiveness.fanoutFailedBranches || 0),
      fanoutAssignedRoles: splitList(effectiveness.fanoutAssignedRoles),
      fanoutSuggestedFiles: splitList(effectiveness.fanoutSuggestedFiles),
      usedFanoutSuggestedFiles: splitList(effectiveness.usedFanoutSuggestedFiles),
      fanoutBranchUtility: splitSemicolonList(effectiveness.fanoutBranchUtility),
      topCandidateFiles,
      filePrecision: score.precision,
      fileRecall: score.recall,
      forbiddenTopFileHit: score.forbiddenTopFileHit,
      injectedContextBytes,
      finalAnswerQualityNotes: '',
      ...(result.error ? { error: result.error } : {}),
    };
  } finally {
    console.error = previousConsoleError;
    restoreEnv('SIFT_EXPLORER', previousExplorer);
    restoreEnv('SIFT_EXPLORER_SCOUT', previousScout);
    restoreEnv('SIFT_EXPLORER_FANOUT', previousFanout);
    restoreEnv('SIFT_EXPLORER_DEBUG', previousDebug);
    restoreEnv('SIFT_EXPLORER_THOROUGHNESS', previousThoroughness);
    restoreEnv('SIFT_USER_CWD', previousCwd);
  }
}

function installFakeOpenFunction(): void {
  (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__ = {
    createChatAgent: async (config: Record<string, unknown>) => ({
      chat: async function* (message: unknown) {
        const text = String(message);
        const agentName = String(config.name || '');
        if (agentName === 'siftable-repo-explorer-scout' || agentName.startsWith('siftable-repo-explorer-fanout-')) {
          yield {
            type: 'text',
            text: JSON.stringify(fakeScoutReport(text, agentName)),
          };
          yield { type: 'done', result: { content: '' } };
          return;
        }
        const path = firstSuggestedPath(text);
        if ((text.includes('<repo_explorer_report>') || text.includes('<repo_explorer_artifact>')) && path) {
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

function fakeScoutReport(input: string, agentName = '') {
  const lower = input.toLowerCase();
  const path =
    agentName.includes('tests') || lower.includes('test') ? 'test/commands/interactive.explorer.test.ts' :
    lower.includes('tool event') ? 'interactive-tui/toolView.ts' :
    agentName.includes('routing_config') || lower.includes('codex') ? 'interactive-tui/codexEngine.ts' :
    agentName.includes('native_boundary') || lower.includes('native') ? 'interactive-tui/native/fs_engine.zig' :
    agentName.includes('source_runtime') || agentName.includes('direct_source') || lower.includes('repo_explorer') ? 'interactive-tui/brain.ts' :
    'interactive-tui/fsEngine.ts';
  return {
    confidence: 0.74,
    missingLikelyFiles: [{ path, reason: 'fake scout candidate for headless eval' }],
    recommendedReads: [{ path, startLine: 1, endLine: 80, reason: 'headless eval read target' }],
    warnings: ['fake-agent eval; run with --real-agent for live quality notes'],
  };
}

function firstSuggestedPath(text: string): string | null {
  const artifact = firstArtifactPath(text);
  if (artifact) return artifact;
  const fanout = text.match(/parallel_scouts:[\s\S]*?merged_recommendations:\n- ([^:\n]+)(?::\d+-\d+)?:/);
  if (fanout?.[1]) return fanout[1].trim();
  const scout = text.match(/model_scout:[\s\S]*?recommended_reads:\n- ([^:\n]+)(?::\d+-\d+)?:/);
  if (scout?.[1]) return scout[1].trim();
  const deterministic = text.match(/Recommended reads:\n- ([^:\n]+)(?::\d+-\d+)?:/);
  return deterministic?.[1]?.trim() || null;
}

function firstArtifactPath(text: string): string | null {
  const json = text.match(/<repo_explorer_artifact>\s*([\s\S]*?)\s*<\/repo_explorer_artifact>/)?.[1];
  if (!json) return null;
  try {
    const artifact = JSON.parse(json) as { files?: Array<{ path?: unknown }> };
    const path = artifact.files?.find((file) => typeof file.path === 'string')?.path;
    return typeof path === 'string' ? path : null;
  } catch {
    return null;
  }
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

function splitSemicolonList(value: string | undefined): string[] {
  if (!value || value === 'none') return [];
  return value.split(';').filter(Boolean);
}

function isSearchTool(name: string | undefined): boolean {
  return ['search_local_files', 'grep_local_files', 'glob_local_files', 'code_search', 'find_local_files', 'inspect_local_workspace', 'list_dir'].includes(String(name || ''));
}

function isReadTool(name: string | undefined): boolean {
  return ['read_file', 'batch_read_files'].includes(String(name || ''));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function printMarkdown(root: string, fakeAgent: boolean, runs: EvalRun[], gate: ReturnType<typeof summarizeEvalGate>): void {
  console.log(`# Repo Explorer Eval\n`);
  console.log(`root: \`${root}\``);
  console.log(`agent: \`${fakeAgent ? 'fake' : 'real'}\`\n`);
  console.log(`gate: \`${gate.passed ? 'pass' : 'fail'}\` fastContext=${gate.fastContextScore} deterministic=${gate.deterministicScore} forbidden=${gate.forbiddenTopFileHits} contextCapViolations=${gate.contextCapViolations}\n`);
  console.log('| mode | runs | avg elapsed | avg context bytes | avg precision | avg recall | forbidden top | avg tools | avg searches | avg reads | scout/fanout used | redundant broad | scout failed |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const mode of ['off', 'deterministic', 'fast-context', 'scout', 'fanout'] as EvalMode[]) {
    const slice = runs.filter((run) => run.mode === mode);
    console.log([
      `| ${mode}`,
      slice.length,
      avg(slice, 'elapsedMs'),
      avg(slice, 'injectedContextBytes'),
      avgFloat(slice, 'filePrecision'),
      avgFloat(slice, 'fileRecall'),
      slice.filter((run) => run.forbiddenTopFileHit).length,
      avg(slice, 'postExplorerToolCalls'),
      avg(slice, 'postExplorerSearchCalls'),
      avg(slice, 'postExplorerReadCalls'),
      slice.filter((run) => run.usedScoutSuggestedFiles.length > 0 || run.usedFanoutSuggestedFiles.length > 0).length,
      slice.filter((run) => run.launchedRedundantBroadSearch).length,
      slice.filter((run) => run.scoutFailed).length,
      '|',
    ].join(' | '));
  }
  console.log('\n## Runs\n');
  for (const run of runs) {
    console.log(`- ${run.mode} | ${run.prompt} | elapsed=${run.elapsedMs}ms contextBytes=${run.injectedContextBytes} precision=${run.filePrecision} recall=${run.fileRecall} forbiddenTop=${run.forbiddenTopFileHit} top=${run.topCandidateFiles.slice(0, 4).join(',') || 'none'} tools=${run.postExplorerToolCalls} searches=${run.postExplorerSearchCalls} reads=${run.postExplorerReadCalls} scoutUsed=${run.usedScoutSuggestedFiles.join(',') || 'none'} fanoutRoles=${run.fanoutAssignedRoles.join(',') || 'none'} fanoutUsed=${run.usedFanoutSuggestedFiles.join(',') || 'none'} fanoutUtility=${run.fanoutBranchUtility.join(';') || 'none'} redundantBroad=${run.launchedRedundantBroadSearch} scoutFailed=${run.scoutFailed} fanoutFailedBranches=${run.fanoutFailedBranches}${run.error ? ` error=${run.error}` : ''}`);
  }
}

function avg(runs: EvalRun[], key: keyof EvalRun): number {
  if (!runs.length) return 0;
  const total = runs.reduce((sum, run) => sum + (typeof run[key] === 'number' ? run[key] as number : 0), 0);
  return Math.round(total / runs.length);
}

function avgFloat(runs: EvalRun[], key: keyof EvalRun): number {
  if (!runs.length) return 0;
  const total = runs.reduce((sum, run) => sum + (typeof run[key] === 'number' ? run[key] as number : 0), 0);
  return Math.round((total / runs.length) * 1000) / 1000;
}

export type EvalMode = 'off' | 'deterministic' | 'fast-context' | 'scout' | 'fanout';

export interface ExplorerEvalFixture {
  prompt: string;
  expectedFiles: string[];
  forbiddenTopFiles?: string[];
}

export interface CandidateFileScore {
  precision: number;
  recall: number;
  forbiddenTopFileHit: boolean;
}

export interface EvalScoreInput {
  prompt: string;
  mode: EvalMode;
  filePrecision: number;
  fileRecall: number;
  forbiddenTopFileHit: boolean;
  injectedContextBytes: number;
}

export interface EvalGateSummary {
  deterministicScore: number;
  fastContextScore: number;
  forbiddenTopFileHits: number;
  contextCapViolations: number;
  passed: boolean;
  errors: string[];
}

export const EXPLORER_EVAL_PROMPTS = [
  'how does our cli work?',
  'why does Explorer show duplicate blocks?',
  'where is command routing?',
  'where is repo_explorer injected?',
  'what owns native file search?',
  'scour this repo and explain how local search works',
  'find where repo_explorer is injected into the model turn',
  'why might the search tool skip files unexpectedly?',
  'map the path from a TUI prompt to OpenFunction/Codex',
  'find the tests that prove explorer behavior',
  'where should we add parallel scout fan-out?',
  'explain the native/TS fallback boundary for file search',
  'what code handles tool events in the TUI?',
] as const;

export const EXPLORER_EVAL_FIXTURES: ExplorerEvalFixture[] = [
  {
    prompt: 'how does our cli work?',
    expectedFiles: ['packages/exf-cli/package.json', 'packages/exf-cli/src', 'packages/exf-cli/interactive-tui'],
    forbiddenTopFiles: ['apps/best-edit'],
  },
  {
    prompt: 'why does Explorer show duplicate blocks?',
    expectedFiles: [
      'packages/exf-cli/interactive-tui/brain.ts',
      'packages/exf-cli/interactive-tui/toolView.ts',
      'packages/exf-cli/test/commands/interactive.explorer.test.ts',
    ],
  },
  {
    prompt: 'where is command routing?',
    expectedFiles: ['packages/exf-cli/interactive-tui/commands.ts', 'packages/exf-cli/src/commands'],
    forbiddenTopFiles: ['apps/best-edit'],
  },
  {
    prompt: 'where is repo_explorer injected?',
    expectedFiles: ['packages/exf-cli/interactive-tui/brain.ts', 'packages/exf-cli/interactive-tui/explorer.ts'],
  },
  {
    prompt: 'what owns native file search?',
    expectedFiles: ['packages/exf-cli/interactive-tui/fsEngine.ts', 'packages/exf-cli/interactive-tui/native/fs_engine.zig'],
  },
];

export function fixtureForPrompt(prompt: string): ExplorerEvalFixture | undefined {
  return EXPLORER_EVAL_FIXTURES.find((fixture) => fixture.prompt === prompt);
}

export function candidateFilesFromContext(text: string): string[] {
  const json = text.match(/<repo_explorer_artifact>\s*([\s\S]*?)\s*<\/repo_explorer_artifact>/)?.[1];
  if (json) {
    try {
      const artifact = JSON.parse(json) as { files?: Array<{ path?: unknown }> };
      return [...new Set((artifact.files ?? []).map((file) => String(file.path || '')).filter(Boolean))];
    } catch {
      return [];
    }
  }
  const files: string[] = [];
  for (const match of text.matchAll(/^- ([^:\n]+)(?::\d+-\d+)?:/gm)) {
    files.push(match[1].trim());
  }
  return [...new Set(files)];
}

export function metricFromArtifact(text: string, key: string): string {
  const json = text.match(/<repo_explorer_artifact>\s*([\s\S]*?)\s*<\/repo_explorer_artifact>/)?.[1];
  if (!json) return '';
  try {
    const artifact = JSON.parse(json) as { stats?: Record<string, unknown> };
    const value = artifact.stats?.[key];
    return typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  } catch {
    return '';
  }
}

export function scoreCandidateFiles(files: string[], fixture: ExplorerEvalFixture | undefined): CandidateFileScore {
  if (!fixture) return { precision: 0, recall: 0, forbiddenTopFileHit: false };
  const top = files.slice(0, 8);
  const hits = top.filter((file) => fixture.expectedFiles.some((expected) => fileMatchesExpected(file, expected)));
  const expectedHits = fixture.expectedFiles.filter((expected) => top.some((file) => fileMatchesExpected(file, expected)));
  return {
    precision: top.length ? round3(hits.length / top.length) : 0,
    recall: fixture.expectedFiles.length ? round3(expectedHits.length / fixture.expectedFiles.length) : 0,
    forbiddenTopFileHit: top.some((file) => (fixture.forbiddenTopFiles ?? []).some((forbidden) => file.includes(forbidden))),
  };
}

export function precisionWeightedScore(input: { filePrecision: number; fileRecall: number }): number {
  return round3(input.filePrecision * 0.7 + input.fileRecall * 0.3);
}

export function summarizeEvalGate(runs: EvalScoreInput[], options: { contextCapBytes?: number } = {}): EvalGateSummary {
  const contextCapBytes = options.contextCapBytes ?? 8_000;
  const fixturePrompts = new Set(EXPLORER_EVAL_FIXTURES.map((fixture) => fixture.prompt));
  const deterministic = runs.filter((run) => run.mode === 'deterministic' && fixturePrompts.has(run.prompt));
  const fastContext = runs.filter((run) => run.mode === 'fast-context' && fixturePrompts.has(run.prompt));
  const avgScore = (slice: EvalScoreInput[]) => slice.length
    ? round3(slice.reduce((sum, run) => sum + precisionWeightedScore(run), 0) / slice.length)
    : 0;
  const forbiddenTopFileHits = runs.filter((run) => run.forbiddenTopFileHit).length;
  const contextCapViolations = runs.filter((run) => run.injectedContextBytes > contextCapBytes).length;
  const deterministicScore = avgScore(deterministic);
  const fastContextScore = avgScore(fastContext);
  const errors: string[] = [];
  if (fastContext.length === 0) errors.push('missing fast-context fixture runs');
  if (deterministic.length === 0) errors.push('missing deterministic fixture runs');
  if (fastContextScore <= deterministicScore) {
    errors.push(`fast-context score ${fastContextScore} did not beat deterministic score ${deterministicScore}`);
  }
  if (forbiddenTopFileHits > 0) errors.push(`${forbiddenTopFileHits} forbidden top file hit(s)`);
  if (contextCapViolations > 0) errors.push(`${contextCapViolations} context cap violation(s)`);
  return {
    deterministicScore,
    fastContextScore,
    forbiddenTopFileHits,
    contextCapViolations,
    passed: errors.length === 0,
    errors,
  };
}

function fileMatchesExpected(file: string, expected: string): boolean {
  return file === expected || file.startsWith(expected) || file.includes(expected);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

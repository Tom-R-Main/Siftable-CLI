import {
  findLocalFiles,
  inspectLocalWorkspace,
  searchLiteral,
  type SearchSkippedByReason,
} from './fsEngine';

export type ExplorerMode = 'skipped' | 'targeted' | 'broad';
export type ExplorerConfidence = 'low' | 'medium' | 'high';

export type ExplorerChatInputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; dataUrl: string; detail?: 'auto' | 'low' | 'high' };
export type ExplorerChatInput = string | ExplorerChatInputPart[];

export interface ExplorerFileFinding {
  path: string;
  reason: string;
  score: number;
  locations?: Array<{ line: number; column?: number; query: string }>;
}

export interface ExplorerReport {
  mode: ExplorerMode;
  confidence: ExplorerConfidence;
  root: string;
  queriesRun: string[];
  likelyFiles: ExplorerFileFinding[];
  recommendedReads: Array<{ path: string; startLine?: number; endLine?: number; reason: string }>;
  diagnostics: {
    filesSearched: number;
    bytesScanned: number;
    capped: boolean;
    capReason: string | null;
    skippedByReason: Partial<SearchSkippedByReason>;
    errors: string[];
  };
  metrics: RepoExplorerMetrics;
  workspace?: {
    languages: Array<{ language: string; files: number; bytes: number }>;
    keyFiles: Array<{ path: string; reason: string }>;
  };
}

export interface RepoExplorerMetrics {
  triggered: boolean;
  classification: 'none' | 'targeted' | 'broad';
  elapsedMs: number;
  queriesRun: number;
  filesSearched: number;
  bytesScanned: number;
  matchesFound: number;
  reportChars: number;
  capped: boolean;
  capReason: string | null;
}

export interface ExplorerPrepareResult {
  input: ExplorerChatInput;
  report: ExplorerReport;
  injected: boolean;
  reportText?: string;
}

export interface ExplorerOptions {
  root?: string;
  enabled?: boolean;
  maxQueries?: number;
  maxMatchesPerQuery?: number;
}

const CODE_HINT_RE =
  /\b(codebase|repo|repository|file|files|function|class|symbol|implementation|implemented|handled|debug|bug|stack|trace|typescript|react|component|hook|route|controller|service|test|spec|zig|native|cli|tui|fsengine|codexengine|brain\.ts)\b/i;
const PATH_HINT_RE = /(?:^|\s)(?:\.?\.?\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|zig|rs|go|py|json|md)\b/;
const BROAD_RE = /\b(scour|audit|map|trace|find|where|why|how|look into|figure out|investigate|review)\b/i;
const IDENT_RE = /\b[A-Za-z_$][A-Za-z0-9_$:-]{2,}\b/g;
const QUOTED_RE = /["'`]([^"'`\n]{3,100})["'`]/g;
const PATH_RE = /\b(?:\.?\.?\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|zig|rs|go|py|json|md)\b/g;
const WORD_RE = /\b[A-Za-z][A-Za-z0-9_-]{2,}\b/g;
const QUERY_PHRASE_TERMS = new Set([
  'brain',
  'code',
  'engine',
  'file',
  'files',
  'local',
  'native',
  'repo',
  'search',
  'test',
  'tests',
  'tool',
  'tools',
]);
const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'agent',
  'because',
  'before',
  'being',
  'could',
  'doing',
  'files',
  'from',
  'have',
  'into',
  'look',
  'need',
  'next',
  'please',
  'repo',
  'search',
  'should',
  'that',
  'their',
  'there',
  'this',
  'want',
  'what',
  'when',
  'where',
  'which',
  'with',
  'would',
]);

export function classifyExplorerPrompt(text: string): ExplorerMode {
  const trimmed = text.trim();
  if (!trimmed || process.env.SIFT_EXPLORER === 'off' || process.env.SIFT_EXPLORER === '0') return 'skipped';
  const hasCodeHint = CODE_HINT_RE.test(trimmed) || PATH_HINT_RE.test(trimmed);
  if (!hasCodeHint) return 'skipped';
  return BROAD_RE.test(trimmed) || trimmed.length > 180 ? 'broad' : 'targeted';
}

export function chatInputText(input: ExplorerChatInput): string {
  if (typeof input === 'string') return input;
  return input.map((part) => part.type === 'text' ? part.text : '').filter(Boolean).join('\n');
}

export function compileExplorerQueries(text: string, maxQueries = 5): string[] {
  const queries = new Map<string, number>();
  const add = (raw: string, weight: number) => {
    const q = raw.trim().replace(/[.,;:!?)]$/, '');
    if (q.length < 3 || q.length > 100) return;
    const lower = q.toLowerCase();
    if (STOP_WORDS.has(lower)) return;
    queries.set(q, Math.max(queries.get(q) ?? 0, weight));
  };

  for (const match of text.matchAll(QUOTED_RE)) add(match[1], 1000);
  for (const match of text.matchAll(PATH_RE)) {
    add(match[0], 900);
    const basename = match[0].split(/[\\/]/).pop();
    if (basename) add(basename.replace(/\.(ts|tsx|js|jsx|zig|rs|go|py|json|md)$/i, ''), 800);
  }
  if (/\blocal\s+search\b/i.test(text)) add('local search', 850);
  const words = [...text.matchAll(WORD_RE)].map((match) => match[0]);
  for (let i = 0; i < words.length; i += 1) {
    for (const size of [3, 2]) {
      const phraseWords = words.slice(i, i + size);
      if (phraseWords.length !== size) continue;
      const lowerWords = phraseWords.map((word) => word.toLowerCase());
      if (lowerWords.every((word) => STOP_WORDS.has(word))) continue;
      if (!lowerWords.some((word) => QUERY_PHRASE_TERMS.has(word))) continue;
      add(phraseWords.join(' '), size === 3 ? 675 : 650);
    }
  }
  for (const match of text.matchAll(IDENT_RE)) {
    const token = match[0];
    const isIdentifierLike = /[A-Z_$:-]/.test(token.slice(1)) || token.length >= 6;
    if (isIdentifierLike) add(token, 500);
  }

  return [...queries.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([query]) => query)
    .slice(0, maxQueries);
}

export async function buildExplorerReport(
  input: ExplorerChatInput,
  options: ExplorerOptions = {},
): Promise<ExplorerReport> {
  const startedAt = Date.now();
  const text = chatInputText(input);
  const mode = options.enabled === false ? 'skipped' : classifyExplorerPrompt(text);
  const root = options.root || process.env.SIFT_USER_CWD || process.cwd();
  const diagnostics: ExplorerReport['diagnostics'] = {
    filesSearched: 0,
    bytesScanned: 0,
    capped: false,
    capReason: null,
    skippedByReason: {},
    errors: [],
  };
  const metrics: RepoExplorerMetrics = {
    triggered: mode !== 'skipped',
    classification: mode === 'skipped' ? 'none' : mode,
    elapsedMs: 0,
    queriesRun: 0,
    filesSearched: 0,
    bytesScanned: 0,
    matchesFound: 0,
    reportChars: 0,
    capped: false,
    capReason: null,
  };

  if (mode === 'skipped') {
    metrics.elapsedMs = Date.now() - startedAt;
    return { mode, confidence: 'low', root, queriesRun: [], likelyFiles: [], recommendedReads: [], diagnostics, metrics };
  }

  const maxQueries = options.maxQueries ?? (mode === 'broad' ? 5 : 3);
  const queries = compileExplorerQueries(text, maxQueries);
  metrics.queriesRun = queries.length;
  const fileScores = new Map<string, ExplorerFileFinding>();
  const workspace = await inspectLocalWorkspace(root).catch((err) => {
    diagnostics.errors.push(`inspect_local_workspace: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });

  if (workspace) {
    for (const file of workspace.keyFiles.slice(0, 8)) {
      addFinding(fileScores, file.path, `workspace ${file.reason}`, 150);
    }
  }

  const pathQueries = queries.slice(0, Math.min(3, queries.length));
  const pathResults = await Promise.all(
    pathQueries.map((query) =>
      findLocalFiles({ root, query, limit: 8, maxFiles: mode === 'broad' ? 4000 : 2000 })
        .then((result) => ({ query, result }))
        .catch((err) => {
          diagnostics.errors.push(`find_local_files(${query}): ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }),
    ),
  );
  for (const item of pathResults) {
    if (!item) continue;
    for (const match of item.result.matches.slice(0, 5)) {
      addFinding(fileScores, match.path, `path match for "${item.query}"`, 300 + match.score / 10);
    }
  }

  const searchResults = await Promise.all(
    queries.map((query) =>
      searchLiteral(root, query, {
        detail: 'locations',
        maxMatches: options.maxMatchesPerQuery ?? (mode === 'broad' ? 40 : 24),
        maxFiles: mode === 'broad' ? 4000 : 2000,
      })
        .then((result) => ({ query, result }))
        .catch((err) => {
          diagnostics.errors.push(`search_local_files(${query}): ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }),
    ),
  );

  for (const item of searchResults) {
    if (!item) continue;
    diagnostics.filesSearched = Math.max(diagnostics.filesSearched, item.result.stats.searchedFiles);
    diagnostics.bytesScanned += item.result.stats.bytesScanned;
    diagnostics.capped ||= item.result.stats.capped;
    diagnostics.capReason ??= item.result.stats.capReason;
    mergeSkipped(diagnostics.skippedByReason, item.result.stats.skippedByReason);
    metrics.matchesFound += item.result.matches.length;
    for (const match of item.result.matches) {
      const finding = addFinding(fileScores, match.path, `literal match for "${item.query}"`, 700);
      const locations = finding.locations ?? [];
      if (match.line > 0 && locations.length < 6) {
        locations.push({ line: match.line, column: match.column || undefined, query: item.query });
        finding.locations = locations;
      }
    }
  }

  const likelyFiles = [...fileScores.values()]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 12);
  const recommendedReads = likelyFiles.slice(0, 8).map((file) => {
    const first = file.locations?.[0];
    return {
      path: file.path,
      ...(first ? { startLine: Math.max(1, first.line - 20), endLine: first.line + 40 } : {}),
      reason: file.reason,
    };
  });
  const confidence: ExplorerConfidence =
    likelyFiles.some((file) => file.locations?.length) ? 'high' :
    likelyFiles.length >= 3 ? 'medium' :
    'low';
  metrics.elapsedMs = Date.now() - startedAt;
  metrics.filesSearched = diagnostics.filesSearched;
  metrics.bytesScanned = diagnostics.bytesScanned;
  metrics.capped = diagnostics.capped;
  metrics.capReason = diagnostics.capReason;

  return {
    mode,
    confidence,
    root,
    queriesRun: queries,
    likelyFiles,
    recommendedReads,
    diagnostics,
    metrics,
    ...(workspace ? {
      workspace: {
        languages: workspace.languages.slice(0, 8),
        keyFiles: workspace.keyFiles.slice(0, 12).map((file) => ({ path: file.path, reason: file.reason })),
      },
    } : {}),
  };
}

export async function prepareExplorerInput(
  input: ExplorerChatInput,
  options: ExplorerOptions = {},
): Promise<ExplorerPrepareResult> {
  const report = await buildExplorerReport(input, options);
  if (report.mode === 'skipped') return { input, report, injected: false };
  const reportText = formatExplorerReport(report);
  return { input: injectExplorerContext(input, reportText), report, injected: true, reportText };
}

export function injectExplorerContext(input: ExplorerChatInput, context: string): ExplorerChatInput {
  const prefix = `${context}\n\nUser request:\n`;
  if (typeof input === 'string') return `${prefix}${input}`;
  return [{ type: 'text', text: prefix }, ...input];
}

export function formatExplorerReport(report: ExplorerReport): string {
  const likely = report.likelyFiles.length
    ? report.likelyFiles.slice(0, 10).map((file) => {
        const locs = file.locations?.length
          ? ` (${file.locations.slice(0, 3).map((loc) => `L${loc.line}:${loc.column ?? 1} ${loc.query}`).join(', ')})`
          : '';
        return `- ${file.path}: ${file.reason}${locs}`;
      }).join('\n')
    : '- none found';
  const reads = report.recommendedReads.length
    ? report.recommendedReads.map((read) => {
        const range = read.startLine && read.endLine ? `:${read.startLine}-${read.endLine}` : '';
        return `- ${read.path}${range}: ${read.reason}`;
      }).join('\n')
    : '- none';
  const languages = report.workspace?.languages.length
    ? report.workspace.languages.map((lang) => `${lang.language} ${lang.files}`).join(', ')
    : 'unknown';
  const skipped = Object.entries(report.diagnostics.skippedByReason)
    .filter(([, count]) => Number(count) > 0)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ') || 'none';
  const errors = report.diagnostics.errors.length
    ? `\nErrors: ${report.diagnostics.errors.slice(0, 3).join(' | ')}`
    : '';
  const render = (reportChars: number) => [
    '<repo_explorer_report>',
    `Mode: ${report.mode}; confidence: ${report.confidence}; root: ${report.root}`,
    `Queries: ${report.queriesRun.join(', ') || 'none'}`,
    `Metrics: triggered=${report.metrics.triggered}; classification=${report.metrics.classification}; elapsedMs=${report.metrics.elapsedMs}; queriesRun=${report.metrics.queriesRun}; filesSearched=${report.metrics.filesSearched}; bytesScanned=${report.metrics.bytesScanned}; matchesFound=${report.metrics.matchesFound}; reportChars=${reportChars}; capped=${report.metrics.capped}; capReason=${report.metrics.capReason ?? 'none'}`,
    `Workspace languages: ${languages}`,
    'Likely files:',
    likely,
    'Recommended reads:',
    reads,
    `Diagnostics: filesSearched=${report.diagnostics.filesSearched}; bytesScanned=${report.diagnostics.bytesScanned}; capped=${report.diagnostics.capped}; capReason=${report.diagnostics.capReason ?? 'none'}; skipped=${skipped}${errors}`,
    'Instruction: Treat this as search triage only. Verify important claims with targeted reads before final conclusions.',
    '</repo_explorer_report>',
  ].join('\n');

  let text = render(report.metrics.reportChars);
  for (let i = 0; i < 3; i += 1) {
    if (text.length === report.metrics.reportChars) break;
    report.metrics.reportChars = text.length;
    text = render(report.metrics.reportChars);
  }
  return text;
}

function addFinding(
  files: Map<string, ExplorerFileFinding>,
  path: string,
  reason: string,
  score: number,
): ExplorerFileFinding {
  const existing = files.get(path);
  if (existing) {
    existing.score += score;
    if (!existing.reason.includes(reason)) existing.reason = `${existing.reason}; ${reason}`;
    return existing;
  }
  const next = { path, reason, score };
  files.set(path, next);
  return next;
}

function mergeSkipped(target: Partial<SearchSkippedByReason>, source: SearchSkippedByReason): void {
  for (const [reason, count] of Object.entries(source) as Array<[keyof SearchSkippedByReason, number]>) {
    target[reason] = (target[reason] ?? 0) + count;
  }
}

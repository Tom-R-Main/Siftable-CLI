import {
  clearWorkspaceFileCache,
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
  candidateGroups: ExplorerCandidateGroups;
  modelScout?: RepoExplorerScoutReport;
  scout?: RepoExplorerScoutState;
  workspace?: {
    languages: Array<{ language: string; files: number; bytes: number }>;
    keyFiles: Array<{ path: string; reason: string }>;
  };
}

export interface ExplorerCandidateGroups {
  primaryCandidates: ExplorerFileFinding[];
  supportingCandidates: ExplorerFileFinding[];
  tests: ExplorerFileFinding[];
  native: ExplorerFileFinding[];
  configDocs: ExplorerFileFinding[];
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
  cacheHit: boolean;
  cacheMiss: boolean;
  fileSetId?: string;
}

export interface RepoExplorerEffectiveness {
  triggered: boolean;
  reportChars: number;
  cacheHit: boolean;
  suggestedFiles: string[];
  scoutEnabled: boolean;
  scoutRan: boolean;
  scoutElapsedMs: number;
  scoutSuggestedFiles: string[];
  usedScoutSuggestedFiles: string[];
  scoutFailed: boolean;
  scoutFailureReason?: string;
  postExplorerToolCalls: number;
  postExplorerSearchCalls: number;
  postExplorerReadCalls: number;
  usedSuggestedFiles: string[];
  ignoredSuggestedFiles: string[];
  launchedRedundantBroadSearch: boolean;
  elapsedAfterExplorerMs: number;
}

export interface ExplorerPrepareResult {
  input: ExplorerChatInput;
  report: ExplorerReport;
  injected: boolean;
  reportText?: string;
}

export interface ExplorerObservedToolCall {
  name?: string;
  args?: Record<string, unknown>;
  detail?: string;
}

export interface RepoExplorerScoutReport {
  confidence: number;
  missingLikelyFiles: Array<{ path: string; reason: string }>;
  recommendedReads: Array<{ path: string; startLine?: number; endLine?: number; reason: string }>;
  warnings: string[];
}

export interface RepoExplorerScoutState {
  enabled: boolean;
  ran: boolean;
  elapsedMs: number;
  failed: boolean;
  failureReason?: string;
}

export interface ExplorerOptions {
  root?: string;
  enabled?: boolean;
  maxQueries?: number;
  maxMatchesPerQuery?: number;
  forceRefresh?: boolean;
  maxCacheAgeMs?: number;
  modelScout?: RepoExplorerScoutReport;
  scout?: RepoExplorerScoutState;
}

interface RepoExplorerCacheEntry {
  root: string;
  createdAtMs: number;
  fileSetId?: string;
  lastMetrics?: RepoExplorerMetrics;
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
const explorerCache = new Map<string, RepoExplorerCacheEntry>();
const DEFAULT_EXPLORER_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

export function clearRepoExplorerCache(root?: string): void {
  if (root) {
    explorerCache.delete(root);
    clearWorkspaceFileCache(root);
    return;
  }
  explorerCache.clear();
  clearWorkspaceFileCache();
}

export function suggestedFilesForExplorerReport(report: ExplorerReport): string[] {
  const files = [
    ...report.recommendedReads.map((read) => read.path),
    ...report.likelyFiles.map((file) => file.path),
    ...(report.modelScout?.recommendedReads.map((read) => read.path) ?? []),
    ...(report.modelScout?.missingLikelyFiles.map((file) => file.path) ?? []),
  ];
  return [...new Set(files)].slice(0, 12);
}

export function scoutSuggestedFilesForExplorerReport(report: ExplorerReport): string[] {
  const files = [
    ...(report.modelScout?.recommendedReads.map((read) => read.path) ?? []),
    ...(report.modelScout?.missingLikelyFiles.map((file) => file.path) ?? []),
  ];
  return [...new Set(files)].slice(0, 12);
}

export function createRepoExplorerEffectiveness(report: ExplorerReport): RepoExplorerEffectiveness {
  const suggestedFiles = suggestedFilesForExplorerReport(report);
  const scoutSuggestedFiles = scoutSuggestedFilesForExplorerReport(report);
  return {
    triggered: report.mode !== 'skipped',
    reportChars: report.metrics.reportChars,
    cacheHit: report.metrics.cacheHit,
    suggestedFiles,
    scoutEnabled: report.scout?.enabled ?? false,
    scoutRan: report.scout?.ran ?? false,
    scoutElapsedMs: report.scout?.elapsedMs ?? 0,
    scoutSuggestedFiles,
    usedScoutSuggestedFiles: [],
    scoutFailed: report.scout?.failed ?? false,
    ...(report.scout?.failureReason ? { scoutFailureReason: report.scout.failureReason } : {}),
    postExplorerToolCalls: 0,
    postExplorerSearchCalls: 0,
    postExplorerReadCalls: 0,
    usedSuggestedFiles: [],
    ignoredSuggestedFiles: suggestedFiles,
    launchedRedundantBroadSearch: false,
    elapsedAfterExplorerMs: 0,
  };
}

export function observeRepoExplorerToolCall(
  effectiveness: RepoExplorerEffectiveness,
  toolCall: ExplorerObservedToolCall,
): void {
  const name = String(toolCall.name || '').toLowerCase();
  effectiveness.postExplorerToolCalls += 1;
  if (isExplorerSearchTool(name)) {
    effectiveness.postExplorerSearchCalls += 1;
    if (effectiveness.usedSuggestedFiles.length === 0 && effectiveness.suggestedFiles.length > 0) {
      effectiveness.launchedRedundantBroadSearch = true;
    }
  }
  if (isExplorerReadTool(name)) effectiveness.postExplorerReadCalls += 1;

  const argText = explorerToolCallText(toolCall).toLowerCase();
  for (const file of effectiveness.suggestedFiles) {
    if (argText.includes(file.toLowerCase()) && !effectiveness.usedSuggestedFiles.includes(file)) {
      effectiveness.usedSuggestedFiles.push(file);
      if (
        effectiveness.scoutSuggestedFiles.includes(file) &&
        !effectiveness.usedScoutSuggestedFiles.includes(file)
      ) {
        effectiveness.usedScoutSuggestedFiles.push(file);
      }
    }
  }
  effectiveness.ignoredSuggestedFiles = effectiveness.suggestedFiles
    .filter((file) => !effectiveness.usedSuggestedFiles.includes(file));
}

export function formatRepoExplorerEffectiveness(effectiveness: RepoExplorerEffectiveness): string {
  return [
    'repo_explorer_effectiveness:',
    `triggered=${effectiveness.triggered}`,
    `reportChars=${effectiveness.reportChars}`,
    `cacheHit=${effectiveness.cacheHit}`,
    `suggestedFiles=${effectiveness.suggestedFiles.length}`,
    `scoutEnabled=${effectiveness.scoutEnabled}`,
    `scoutRan=${effectiveness.scoutRan}`,
    `scoutElapsedMs=${effectiveness.scoutElapsedMs}`,
    `scoutSuggestedFiles=${effectiveness.scoutSuggestedFiles.length ? effectiveness.scoutSuggestedFiles.join(',') : 'none'}`,
    `usedScoutSuggestedFiles=${effectiveness.usedScoutSuggestedFiles.length ? effectiveness.usedScoutSuggestedFiles.join(',') : 'none'}`,
    `scoutFailed=${effectiveness.scoutFailed}`,
    ...(effectiveness.scoutFailureReason ? [`scoutFailureReason=${effectiveness.scoutFailureReason}`] : []),
    `usedSuggestedFiles=${effectiveness.usedSuggestedFiles.length ? effectiveness.usedSuggestedFiles.join(',') : 'none'}`,
    `ignoredSuggestedFiles=${effectiveness.ignoredSuggestedFiles.length ? effectiveness.ignoredSuggestedFiles.join(',') : 'none'}`,
    `postExplorerToolCalls=${effectiveness.postExplorerToolCalls}`,
    `postExplorerSearchCalls=${effectiveness.postExplorerSearchCalls}`,
    `postExplorerReadCalls=${effectiveness.postExplorerReadCalls}`,
    `launchedRedundantBroadSearch=${effectiveness.launchedRedundantBroadSearch}`,
    `elapsedAfterExplorerMs=${effectiveness.elapsedAfterExplorerMs}`,
  ].join(' ');
}

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
  const cacheMaxAgeMs = Math.max(0, options.maxCacheAgeMs ?? DEFAULT_EXPLORER_CACHE_MAX_AGE_MS);
  const cached = !options.forceRefresh ? explorerCache.get(root) : undefined;
  const cachedUsable = Boolean(cached && Date.now() - cached.createdAtMs <= cacheMaxAgeMs);
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
    cacheHit: false,
    cacheMiss: false,
  };

  if (mode === 'skipped') {
    metrics.elapsedMs = Date.now() - startedAt;
    return {
      mode,
      confidence: 'low',
      root,
      queriesRun: [],
      likelyFiles: [],
      recommendedReads: [],
      diagnostics,
      metrics,
      candidateGroups: emptyCandidateGroups(),
    };
  }

  const maxQueries = options.maxQueries ?? (mode === 'broad' ? 5 : 3);
  const queries = compileExplorerQueries(text, maxQueries);
  metrics.queriesRun = queries.length;
  const fileScores = new Map<string, ExplorerFileFinding>();
  if (options.forceRefresh) clearRepoExplorerCache(root);
  const workspace = await inspectLocalWorkspace(root).catch((err) => {
    diagnostics.errors.push(`inspect_local_workspace: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  const fileSetId = workspace?.stats.fileSetId;
  metrics.fileSetId = fileSetId;
  metrics.cacheHit = Boolean(cachedUsable && fileSetId && cached?.fileSetId === fileSetId && workspace?.stats.cacheHit);
  metrics.cacheMiss = !metrics.cacheHit;

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
  const candidateGroups = groupCandidateFiles(likelyFiles);
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
  const entry: RepoExplorerCacheEntry = {
    root,
    createdAtMs: Date.now(),
    fileSetId,
    lastMetrics: { ...metrics },
  };
  explorerCache.set(root, entry);

  return {
    mode,
    confidence,
    root,
    queriesRun: queries,
    likelyFiles,
    recommendedReads,
    diagnostics,
    metrics,
    candidateGroups,
    ...(options.modelScout ? { modelScout: sanitizeRepoExplorerScoutReport(options.modelScout) } : {}),
    ...(options.scout ? { scout: options.scout } : {}),
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

export function attachRepoExplorerScout(
  report: ExplorerReport,
  scout: RepoExplorerScoutReport,
  state: RepoExplorerScoutState,
): ExplorerReport {
  report.modelScout = sanitizeRepoExplorerScoutReport(scout);
  report.scout = state;
  return report;
}

export function markRepoExplorerScoutState(
  report: ExplorerReport,
  state: RepoExplorerScoutState,
): ExplorerReport {
  report.scout = state;
  return report;
}

export function parseRepoExplorerScoutReport(text: string): RepoExplorerScoutReport {
  const trimmed = text.trim();
  const jsonText = extractJsonObject(trimmed);
  if (!jsonText) throw new Error('scout returned no JSON object');
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`scout returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return sanitizeRepoExplorerScoutReport(parsed);
}

export function injectExplorerContext(input: ExplorerChatInput, context: string): ExplorerChatInput {
  const prefix = `${context}\n\nUser request:\n`;
  if (typeof input === 'string') return `${prefix}${input}`;
  return [{ type: 'text', text: prefix }, ...input];
}

export function formatExplorerReport(report: ExplorerReport): string {
  const renderGroup = (files: ExplorerFileFinding[]) => files.length
    ? files.map(formatFindingLine).join('\n')
    : '- none';
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
  const scout = formatModelScoutSection(report.modelScout);
  const render = (reportChars: number) => [
    '<repo_explorer_report>',
    `Mode: ${report.mode}; confidence: ${report.confidence}; root: ${report.root}`,
    `Queries: ${report.queriesRun.join(', ') || 'none'}`,
    `Metrics: triggered=${report.metrics.triggered}; classification=${report.metrics.classification}; elapsedMs=${report.metrics.elapsedMs}; queriesRun=${report.metrics.queriesRun}; filesSearched=${report.metrics.filesSearched}; bytesScanned=${report.metrics.bytesScanned}; matchesFound=${report.metrics.matchesFound}; reportChars=${reportChars}; capped=${report.metrics.capped}; capReason=${report.metrics.capReason ?? 'none'}; cacheHit=${report.metrics.cacheHit}; cacheMiss=${report.metrics.cacheMiss}; fileSetId=${report.metrics.fileSetId ?? 'none'}`,
    `Workspace languages: ${languages}`,
    'primary_candidates:',
    renderGroup(report.candidateGroups.primaryCandidates),
    'supporting_candidates:',
    renderGroup(report.candidateGroups.supportingCandidates),
    'tests:',
    renderGroup(report.candidateGroups.tests),
    'native:',
    renderGroup(report.candidateGroups.native),
    'config_docs:',
    renderGroup(report.candidateGroups.configDocs),
    'Recommended reads:',
    reads,
    scout,
    `Diagnostics: filesSearched=${report.diagnostics.filesSearched}; bytesScanned=${report.diagnostics.bytesScanned}; capped=${report.diagnostics.capped}; capReason=${report.diagnostics.capReason ?? 'none'}; skipped=${skipped}${errors}`,
    'Instruction: This report is a preflight map, not exhaustive evidence. Prefer these candidate files first before launching broad additional searches, and verify important claims with targeted reads before final conclusions. The model_scout section is advisory; prefer deterministic candidates when scout confidence is low or scout warnings mention caps/uncertainty.',
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

function formatFindingLine(file: ExplorerFileFinding): string {
  const locs = file.locations?.length
    ? ` (${file.locations.slice(0, 3).map((loc) => `L${loc.line}:${loc.column ?? 1} ${loc.query}`).join(', ')})`
    : '';
  return `- ${file.path}: ${file.reason}${locs}`;
}

function formatModelScoutSection(scout: RepoExplorerScoutReport | undefined): string {
  if (!scout) return 'model_scout: none';
  const missing = scout.missingLikelyFiles.length
    ? scout.missingLikelyFiles.slice(0, 6).map((file) => `- ${file.path}: ${file.reason}`).join('\n')
    : '- none';
  const reads = scout.recommendedReads.length
    ? scout.recommendedReads.slice(0, 6).map((read) => {
        const range = read.startLine && read.endLine ? `:${read.startLine}-${read.endLine}` : '';
        return `- ${read.path}${range}: ${read.reason}`;
      }).join('\n')
    : '- none';
  const warnings = scout.warnings.length
    ? scout.warnings.slice(0, 4).map((warning) => `- ${warning}`).join('\n')
    : '- none';
  return [
    'model_scout:',
    `confidence=${scout.confidence}`,
    'missing_likely_files:',
    missing,
    'recommended_reads:',
    reads,
    'warnings:',
    warnings,
  ].join('\n');
}

function extractJsonObject(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fence?.[1]?.trim() || text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

function sanitizeRepoExplorerScoutReport(input: unknown): RepoExplorerScoutReport {
  if (!input || typeof input !== 'object') throw new Error('scout report must be an object');
  const record = input as Record<string, unknown>;
  const confidenceRaw = typeof record.confidence === 'number' ? record.confidence : Number(record.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;
  return {
    confidence,
    missingLikelyFiles: sanitizeScoutFiles(record.missingLikelyFiles).slice(0, 8),
    recommendedReads: sanitizeScoutReads(record.recommendedReads).slice(0, 8),
    warnings: Array.isArray(record.warnings)
      ? record.warnings.map((warning) => cleanScoutText(String(warning), 180)).filter(Boolean).slice(0, 6)
      : [],
  };
}

function sanitizeScoutFiles(input: unknown): Array<{ path: string; reason: string }> {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const path = cleanScoutPath(record.path);
      if (!path) return null;
      return { path, reason: cleanScoutText(String(record.reason || 'scout suggested file'), 180) };
    })
    .filter((item): item is { path: string; reason: string } => Boolean(item));
}

function sanitizeScoutReads(input: unknown): Array<{ path: string; startLine?: number; endLine?: number; reason: string }> {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const path = cleanScoutPath(record.path);
      if (!path) return null;
      const startLine = positiveLine(record.startLine);
      const endLine = positiveLine(record.endLine);
      return {
        path,
        ...(startLine ? { startLine } : {}),
        ...(endLine ? { endLine: Math.max(startLine ?? 1, endLine) } : {}),
        reason: cleanScoutText(String(record.reason || 'scout recommended read'), 180),
      };
    })
    .filter((item): item is { path: string; startLine?: number; endLine?: number; reason: string } => Boolean(item));
}

function cleanScoutPath(input: unknown): string {
  const path = cleanScoutText(String(input || ''), 220);
  if (!path || path.includes('\0') || path.startsWith('/')) return '';
  if (path.includes('..')) return '';
  return path;
}

function cleanScoutText(input: string, maxLength: number): string {
  return input.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function positiveLine(input: unknown): number | undefined {
  const value = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}

function emptyCandidateGroups(): ExplorerCandidateGroups {
  return {
    primaryCandidates: [],
    supportingCandidates: [],
    tests: [],
    native: [],
    configDocs: [],
  };
}

function groupCandidateFiles(files: ExplorerFileFinding[]): ExplorerCandidateGroups {
  const groups = emptyCandidateGroups();
  const seen = new Set<string>();
  const add = (bucket: ExplorerFileFinding[], file: ExplorerFileFinding) => {
    if (seen.has(file.path)) return;
    seen.add(file.path);
    bucket.push(file);
  };

  for (const file of files) {
    if (isTestPath(file.path)) add(groups.tests, file);
    else if (isNativePath(file.path)) add(groups.native, file);
    else if (isConfigDocPath(file.path)) add(groups.configDocs, file);
    else if (groups.primaryCandidates.length < 4) add(groups.primaryCandidates, file);
    else add(groups.supportingCandidates, file);
  }

  for (const group of [
    groups.primaryCandidates,
    groups.supportingCandidates,
    groups.tests,
    groups.native,
    groups.configDocs,
  ]) {
    group.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  }
  return groups;
}

function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function isNativePath(path: string): boolean {
  return /(^|\/)native\//.test(path) || /\.(zig|rs|go|c|cc|cpp|h|hpp)$/.test(path);
}

function isConfigDocPath(path: string): boolean {
  return /(^|\/)(package\.json|tsconfig\.json|README\.md|readme\.md|AGENTS\.md|CLAUDE\.md)$/.test(path) ||
    /\.(md|json|ya?ml|toml)$/.test(path);
}

function isExplorerSearchTool(name: string): boolean {
  return ['search_local_files', 'code_search', 'find_local_files', 'inspect_local_workspace', 'list_dir'].includes(name);
}

function isExplorerReadTool(name: string): boolean {
  return ['read_file', 'batch_read_files'].includes(name);
}

function explorerToolCallText(toolCall: ExplorerObservedToolCall): string {
  const parts = [toolCall.name || '', toolCall.detail || ''];
  if (toolCall.args) {
    try {
      parts.push(JSON.stringify(toolCall.args));
    } catch {
      parts.push(String(toolCall.args));
    }
  }
  return parts.join(' ');
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

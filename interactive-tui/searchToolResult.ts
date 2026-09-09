import type {ToolResult} from './agent-harness/framework/types';

type SearchKind = 'matches' | 'files' | 'spans';
type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ObjectValue : undefined;
}

const reasonLabels: Record<string, string> = {
  maxFiles: 'file limit', maxMatches: 'match limit', maxBytes: 'byte limit',
  maxDepth: 'depth limit', ioError: 'read errors', invalidUtf8: 'unreadable text',
  tooLarge: 'oversized files', cancelled: 'cancelled', previewReadError: 'preview read errors',
  maxQueries: 'query limit', scanCap: 'scan limit', depth: 'depth limit',
};

/** Summaries state the evidence boundary before any potentially large result body. */
export function summarizeSearchResult(data: unknown, kind: SearchKind = 'matches'): string {
  const value = object(data);
  const stats = object(value?.stats);
  const scan = object(stats?.scan);
  const presentation = object(stats?.presentation);
  const status = scan?.status;
  const count = Array.isArray(value?.matches) ? value.matches.length
    : Array.isArray(value?.spans) ? value.spans.length : undefined;
  const noun = kind === 'files' ? 'matching files' : kind === 'spans' ? 'code spans' : 'matches';
  const searched = stats?.searchedFiles ?? stats?.scannedFiles;
  const scope = typeof searched === 'number' && Number.isSafeInteger(searched) && searched >= 0
    ? ` in ${searched} files searched` : ' in the searched portion';
  const found = count === undefined ? 'Results available' : count === 0 ? `no ${noun}` : `${count} ${noun}`;
  if (status === 'cancelled') return `Search cancelled: ${found}${scope}. Search incomplete.`;
  if (status === 'failed') return `Search failed: ${found}${scope}. Results do not establish absence.`;
  if (status !== 'complete') {
    const reasons = Array.isArray(scan?.reasons) ? [...new Set(scan.reasons.map(reason =>
      typeof reason === 'string' ? reasonLabels[reason] ?? 'other coverage limits' : 'other coverage limits'))] : [];
    const why = reasons.length ? reasons.join(', ') : 'coverage not established';
    return `Search incomplete: ${found}${scope}; ${why}. Narrow the root or adjust search limits.`.slice(0, 320);
  }
  if (presentation?.clipped === true) {
    return `Search complete within eligible files: showing ${count ?? 'selected'} ${noun}; presentation clipped. Narrow the query for omitted results.`;
  }
  return `Search complete within eligible files: ${found}${scope}.`;
}

export function searchToolResult<T>(data: T, kind: SearchKind = 'matches'): ToolResult<T> {
  const status = object(object(object(data)?.stats)?.scan)?.status;
  const success = status !== 'failed' && status !== 'cancelled';
  const message = summarizeSearchResult(data, kind);
  return {success, message, ...(success ? {} : {error: message, executionOutcome: 'failed' as const}), data};
}

export function searchToolFailure(error: unknown): ToolResult {
  const detail = error instanceof Error ? error.message : String(error);
  return {success: false, error: detail, executionOutcome: 'failed',
    message: `Search failed: ${detail}`.slice(0, 320),
    data: {stats: {scan: {status: 'failed', reasons: ['searchFailed']}, presentation: {clipped: false, reasons: []}}}};
}

/** Keep outcome and the canonical summary ahead of bulk data during output bounding. */
export function projectSearchResult(result: ToolResult): ToolResult {
  return {success: result.success,
    ...(result.executionOutcome === undefined ? {} : {executionOutcome: result.executionOutcome}),
    ...(result.message === undefined ? {} : {message: result.message}),
    ...(result.error === undefined ? {} : {error: result.error}),
    ...(result.data === undefined ? {} : {data: result.data})};
}

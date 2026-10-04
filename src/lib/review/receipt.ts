// The receipt `sift review` prints (docs/architecture/taster-review.md section
// 9): the verdict bound to the reviewed revision, the trusted policy revision
// and the completion state, plus a digest of its own canonical JSON so a copy
// attached as Sift verification evidence can be checked for edits. The digest
// is an integrity check, not a signature: a local review runs on the user's
// own machine and proves only what that machine reports.

import {createHash} from 'node:crypto';
import type {Finding, ReviewResult, Verdict} from '@siftable/taster';
import {sanitizeTerminalLine, sanitizeTerminalText} from '../output.js';

export const RECEIPT_FORMAT = 'taster.local-receipt/v1';

export type ReviewStatus = 'clean' | 'findings' | 'incomplete' | 'skipped' | 'failed';

export interface ReceiptFinding {
  id: string;
  priority: Finding['priority'];
  title: string;
  path: string;
  start: number;
  end: number;
  confidence: number;
}

export interface ReceiptBody {
  format: typeof RECEIPT_FORMAT;
  mode: 'local';
  /** clean only for a complete verdict with no findings at all; never for incomplete, skipped or failed. */
  status: ReviewStatus;
  completion: Verdict['kind'];
  revision: {
    head: string;
    base: string;
    mergeBase: string;
    baseRef: string;
    /** Uncommitted changes are not reviewed; the receipt covers `head` only. */
    worktreeDirty: boolean;
  };
  policy: {name: string; revision: string};
  model: {name: string; provider: 'codex-native'; finderPasses: 2 | 3};
  verdict: {
    kind: Verdict['kind'];
    reason: string | null;
    blocking: number;
    advisory: number;
    filesInScope: number | null;
    filesReviewed: number | null;
    filesSkipped: number | null;
    stages: Record<string, string> | null;
  };
  findings: ReceiptFinding[];
  /** Pre-pass and runtime problems that explain an incomplete or failed verdict. */
  problems: string[];
  startedAt: string;
  finishedAt: string;
}

export interface Receipt extends ReceiptBody {
  /** sha256 over the canonical JSON of every other field. */
  digest: string;
}

/** Order-independent JSON. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function receiptDigest(body: ReceiptBody): string {
  return `sha256:${createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex')}`;
}

/** Verifies that a receipt's digest matches its content. */
export function verifyReceipt(receipt: Receipt): boolean {
  const {digest, ...body} = receipt;
  return digest === receiptDigest(body as ReceiptBody);
}

/**
 * Status from the verdict alone. Only a complete verdict can be clean, and only
 * when it confirmed no finding; an incomplete review stays incomplete even with
 * zero findings (section 5.2).
 */
export function reviewStatus(verdict: Verdict, findings: number): ReviewStatus {
  switch (verdict.kind) {
    case 'complete':
      return findings === 0 && verdict.blocking === 0 && verdict.advisory === 0 ? 'clean' : 'findings';
    case 'incomplete':
      return 'incomplete';
    case 'skipped':
      return 'skipped';
    default:
      return 'failed';
  }
}

export interface ReceiptContext {
  head: string;
  base: string;
  mergeBase: string;
  baseRef: string;
  worktreeDirty: boolean;
  policy: {name: string; revision: string};
  model: string;
  finderPasses: 2 | 3;
  problems: string[];
  startedAt: Date;
  finishedAt: Date;
}

export function buildReceipt(context: ReceiptContext, verdict: Verdict, findings: readonly Finding[]): Receipt {
  const coverage = 'coverage' in verdict ? verdict.coverage : null;
  const body: ReceiptBody = {
    format: RECEIPT_FORMAT,
    mode: 'local',
    status: reviewStatus(verdict, findings.length),
    completion: verdict.kind,
    revision: {
      head: context.head,
      base: context.base,
      mergeBase: context.mergeBase,
      baseRef: context.baseRef,
      worktreeDirty: context.worktreeDirty,
    },
    policy: context.policy,
    model: {name: context.model, provider: 'codex-native', finderPasses: context.finderPasses},
    verdict: {
      kind: verdict.kind,
      reason: 'reason' in verdict ? String(verdict.reason) : null,
      blocking: verdict.kind === 'complete' ? verdict.blocking : 0,
      advisory: verdict.kind === 'complete' ? verdict.advisory : 0,
      filesInScope: coverage ? coverage.filesInScope : null,
      filesReviewed: coverage ? coverage.filesReviewed : null,
      filesSkipped: coverage ? coverage.filesSkipped.length : null,
      stages: coverage ? {...coverage.stages} : null,
    },
    findings: [...findings]
      .sort((a, b) => a.priority - b.priority || a.location.path.localeCompare(b.location.path) || a.location.start - b.location.start)
      .map(finding => ({
        id: finding.id,
        priority: finding.priority,
        title: finding.title,
        path: finding.location.path,
        start: finding.location.start,
        end: finding.location.end,
        confidence: finding.confidence,
      })),
    problems: context.problems.slice(0, 50),
    startedAt: context.startedAt.toISOString(),
    finishedAt: context.finishedAt.toISOString(),
  };
  return {...body, digest: receiptDigest(body)};
}

/** A failed receipt for a run that could not produce an engine verdict. */
export function failedVerdict(head: string, reason: string): Verdict {
  return {kind: 'failed', reviewedSha: head, reason};
}

const STATUS_LINE: Record<ReviewStatus, string> = {
  clean: 'COMPLETE: no findings',
  findings: 'COMPLETE: findings reported',
  incomplete: 'INCOMPLETE: this is not a clean review',
  skipped: 'SKIPPED: nothing was reviewed',
  failed: 'FAILED: the review did not run to a verdict',
};

const short = (sha: string) => sha.slice(0, 12);

/** Human-readable report: findings first, then the receipt summary. */
export function renderReport(receipt: Receipt, result: Pick<ReviewResult, 'findings'> | null): string {
  const lines: string[] = [];
  const findings = result ? [...result.findings].sort((a, b) => a.priority - b.priority) : [];
  if (findings.length > 0) {
    lines.push(`Findings (${findings.length}):`, '');
    for (const finding of findings) {
      // Finding text, paths and the validator name come from the model or the
      // reviewed checkout: strip terminal control sequences before printing.
      const where = `${sanitizeTerminalLine(finding.location.path)}:${finding.location.start}${finding.location.end !== finding.location.start ? `-${finding.location.end}` : ''}`;
      // Model titles often carry their own priority tag; show one, the validated priority.
      const title = sanitizeTerminalLine(finding.title).replace(/^\s*\[P[0-3]\]\s*/u, '');
      lines.push(`[P${finding.priority}] ${title}`, `  ${where}  (confidence ${finding.confidence.toFixed(2)}, ${sanitizeTerminalLine(finding.validation.validator)})`);
      for (const bodyLine of sanitizeTerminalText(finding.body.trim()).split('\n').slice(0, 20)) lines.push(`  ${bodyLine}`);
      if (finding.suggestion) lines.push(`  Suggestion: ${sanitizeTerminalLine(finding.suggestion.trim().split('\n')[0])}`);
      lines.push('');
    }
  }
  const v = receipt.verdict;
  lines.push(STATUS_LINE[receipt.status]);
  if (v.reason) lines.push(`Reason: ${sanitizeTerminalLine(v.reason)}`);
  if (receipt.status === 'findings') lines.push(`Blocking (P0-P1): ${v.blocking}  Advisory: ${v.advisory}`);
  if (v.filesInScope !== null) lines.push(`Coverage: ${v.filesReviewed}/${v.filesInScope} files reviewed, ${v.filesSkipped} skipped`);
  if (v.stages) {
    const unfinished = Object.entries(v.stages).filter(([, status]) => status !== 'complete');
    if (unfinished.length > 0) lines.push(`Stages not complete: ${unfinished.map(([name, status]) => `${name}=${status}`).join(', ')}`);
  }
  for (const problem of receipt.problems.slice(0, 10)) lines.push(`Problem: ${sanitizeTerminalLine(problem)}`);
  lines.push(
    '',
    'Receipt',
    `  head ${short(receipt.revision.head)}  base ${receipt.revision.baseRef} (${short(receipt.revision.base)})  merge base ${short(receipt.revision.mergeBase)}`,
    `  policy ${receipt.policy.name} ${receipt.policy.revision}`,
    `  model ${receipt.model.name} via codex with your own login, ${receipt.model.finderPasses} finder passes`,
    `  completion ${receipt.completion}  status ${receipt.status}`,
    `  digest ${receipt.digest}`,
  );
  if (receipt.revision.worktreeDirty) lines.push('  note: the working tree has uncommitted changes; only the committed head was reviewed');
  return lines.join('\n');
}

/** Sift verification outcome for the receipt: only a clean, complete review passes. */
export function evidenceOutcome(receipt: Receipt): 'passed' | 'failed' | 'error' {
  if (receipt.status === 'clean') return 'passed';
  if (receipt.status === 'findings') return receipt.verdict.blocking > 0 ? 'failed' : 'passed';
  return 'error';
}

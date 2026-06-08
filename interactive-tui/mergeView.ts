/**
 * mergeView — lane E: the parent's-eye aggregate over its children's
 * mergeability. Pure projection only (no git, no kernel): the controller gathers
 * one {@link MergeReadinessRow} per child by running the read-only lane-D gate,
 * and this module folds those rows into the dashboard the `/merge` command
 * renders — ready children first, then the counts and totals the parent needs to
 * decide what to land.
 *
 * Keeping the fold pure (separate from the git-gathering in the controller) makes
 * the ordering and the ready/blocked accounting snapshot-testable without a repo,
 * exactly as {@link assembleMergePacket} is split from {@link evaluateMerge}.
 */
import type {MergeMasterStatus} from "./mergeMaster";
import type {MergeVerdict} from "./mergeGate";

/** One child's mergeability, as the parent dashboard sees it. */
export interface MergeReadinessRow {
  sessionId: number;
  branch: string;
  baseBranch: string;
  /** Live registry status (or "unknown" if the registry has no record). */
  status: MergeMasterStatus | "unknown";
  /**
   * The gate verdict, or null when the child is not evaluable — terminal
   * (merged/rejected/abandoned) or read-only (nothing to merge). Null rows do
   * not count toward ready/blocked.
   */
  verdict: MergeVerdict | null;
  files: number;
  additions: number;
  deletions: number;
  /** Commits the base advanced since the child forked. */
  behindBy: number;
  /** Human-readable blockers (present iff verdict is merge_blocked). */
  blockers: string[];
}

/** The aggregate the parent merge dashboard renders. */
export interface ParentMergeView {
  /** Rows sorted ready-first, then blocked, then non-evaluable; ties by id. */
  rows: MergeReadinessRow[];
  readyCount: number;
  blockedCount: number;
  /** Totals across the *ready* rows only — what would land if all ready merged. */
  totalAdditions: number;
  totalDeletions: number;
}

/** Sort key: ready (0) before blocked (1) before non-evaluable (2). */
function rank(row: MergeReadinessRow): number {
  if (row.verdict === "ready_to_merge") return 0;
  if (row.verdict === "merge_blocked") return 1;
  return 2;
}

/**
 * Fold per-child readiness rows into the parent dashboard. Pure: deterministic
 * ordering (ready-first, then by ascending session id) and counts/totals derived
 * only from the rows. Totals sum the ready rows — the net size of a full landing.
 */
export function assembleParentMergeView(rows: MergeReadinessRow[]): ParentMergeView {
  const sorted = [...rows].sort((a, b) => rank(a) - rank(b) || a.sessionId - b.sessionId);
  let readyCount = 0;
  let blockedCount = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const row of sorted) {
    if (row.verdict === "ready_to_merge") {
      readyCount++;
      totalAdditions += row.additions;
      totalDeletions += row.deletions;
    } else if (row.verdict === "merge_blocked") {
      blockedCount++;
    }
  }
  return {rows: sorted, readyCount, blockedCount, totalAdditions, totalDeletions};
}

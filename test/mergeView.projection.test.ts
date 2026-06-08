/**
 * Lane E E2 — the pure parent merge-view fold. No git, no kernel: given per-child
 * readiness rows, assembleParentMergeView orders them (ready → blocked →
 * non-evaluable, ties by id), counts ready/blocked, and totals the *ready* rows.
 */
import {assembleParentMergeView, type MergeReadinessRow} from "../interactive-tui/mergeView";

function row(over: Partial<MergeReadinessRow> = {}): MergeReadinessRow {
  return {
    sessionId: 1,
    branch: "sift/x",
    baseBranch: "main",
    status: "running",
    verdict: "ready_to_merge",
    files: 1,
    additions: 3,
    deletions: 1,
    behindBy: 0,
    blockers: [],
    ...over,
  };
}

describe("assembleParentMergeView", () => {
  it("is empty for no rows", () => {
    expect(assembleParentMergeView([])).toEqual({
      rows: [],
      readyCount: 0,
      blockedCount: 0,
      totalAdditions: 0,
      totalDeletions: 0,
    });
  });

  it("orders ready first, then blocked, then non-evaluable, ties by id", () => {
    const out = assembleParentMergeView([
      row({sessionId: 5, verdict: null, status: "merged"}),
      row({sessionId: 3, verdict: "merge_blocked", status: "merge_blocked"}),
      row({sessionId: 4, verdict: "ready_to_merge"}),
      row({sessionId: 2, verdict: "ready_to_merge"}),
      row({sessionId: 1, verdict: "merge_blocked"}),
    ]);
    expect(out.rows.map((r) => r.sessionId)).toEqual([2, 4, 1, 3, 5]);
  });

  it("counts ready/blocked and totals only the ready rows", () => {
    const out = assembleParentMergeView([
      row({sessionId: 1, verdict: "ready_to_merge", additions: 10, deletions: 2}),
      row({sessionId: 2, verdict: "ready_to_merge", additions: 5, deletions: 1}),
      row({sessionId: 3, verdict: "merge_blocked", additions: 99, deletions: 99}),
      row({sessionId: 4, verdict: null, additions: 99, deletions: 99}),
    ]);
    expect(out.readyCount).toBe(2);
    expect(out.blockedCount).toBe(1);
    expect(out.totalAdditions).toBe(15);
    expect(out.totalDeletions).toBe(3);
  });

  it("does not mutate the input array", () => {
    const input = [row({sessionId: 2}), row({sessionId: 1})];
    const snapshot = input.map((r) => r.sessionId);
    assembleParentMergeView(input);
    expect(input.map((r) => r.sessionId)).toEqual(snapshot);
  });
});

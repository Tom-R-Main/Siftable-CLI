/**
 * Track B B2 — the /branches overlay reducer, action keys. `r`/`m` fire directly
 * on the selected row; `a` arms a two-step confirm and only `y` abandons (esc/n/
 * anything else cancels WITHOUT closing the overlay). All no-op on an empty field.
 */
import {reduceBranchesKey, type BranchesState} from "../interactive-tui/branchesOverlay";
import type {MergeReadinessRow} from "../interactive-tui/mergeView";

function row(sessionId: number): MergeReadinessRow {
  return {
    sessionId,
    branch: `sift/feat-${sessionId}`,
    baseBranch: "main",
    status: "running",
    verdict: "ready_to_merge",
    files: 1,
    additions: 1,
    deletions: 0,
    behindBy: 0,
    blockers: [],
  };
}

const rows = [row(2), row(3), row(4)];
const list = (rowIdx: number, confirmAbandon = false): BranchesState => ({stage: "list", rowIdx, confirmAbandon});

describe("branchesOverlay reducer — action keys", () => {
  it("r runs the ready-gate on the selected row", () => {
    expect(reduceBranchesKey(list(1), {name: "r", sequence: "r"}, rows)).toEqual({kind: "ready", sessionId: 3});
  });

  it("m merges the selected row directly (no confirm)", () => {
    expect(reduceBranchesKey(list(2), {name: "m", sequence: "m"}, rows)).toEqual({kind: "merge", sessionId: 4});
  });

  it("a arms the abandon confirm rather than abandoning immediately", () => {
    expect(reduceBranchesKey(list(0), {name: "a", sequence: "a"}, rows)).toEqual({
      kind: "none",
      state: list(0, true),
    });
  });

  it("y confirms the armed abandon for the selected row", () => {
    expect(reduceBranchesKey(list(1, true), {name: "y", sequence: "y"}, rows)).toEqual({kind: "abandon", sessionId: 3});
  });

  it("n cancels the armed abandon without closing", () => {
    expect(reduceBranchesKey(list(1, true), {name: "n", sequence: "n"}, rows)).toEqual({
      kind: "none",
      state: list(1, false),
    });
  });

  it("esc cancels the armed abandon (does NOT close the overlay)", () => {
    expect(reduceBranchesKey(list(1, true), {name: "escape"}, rows)).toEqual({
      kind: "none",
      state: list(1, false),
    });
  });

  it("any other key while armed cancels the confirm", () => {
    expect(reduceBranchesKey(list(0, true), {name: "up"}, rows)).toEqual({kind: "none", state: list(0, false)});
  });

  it("ctrl/meta chords are not treated as action chars", () => {
    expect(reduceBranchesKey(list(0), {name: "m", sequence: "m", ctrl: true}, rows)).toEqual({
      kind: "none",
      state: list(0),
    });
  });

  it("action keys no-op on an empty field", () => {
    for (const ch of ["r", "m", "a"]) {
      expect(reduceBranchesKey(list(0), {name: ch, sequence: ch}, [])).toEqual({kind: "none", state: list(0)});
    }
  });

  it("y with no rows cancels the armed confirm instead of abandoning", () => {
    expect(reduceBranchesKey(list(0, true), {name: "y", sequence: "y"}, [])).toEqual({
      kind: "none",
      state: list(0, false),
    });
  });
});

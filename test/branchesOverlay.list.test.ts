/**
 * Track B B1 — the /branches overlay reducer, list stage. Pure (state, key, rows)
 * → action, so every transition is asserted without the TUI renderer (the same
 * way mergeView's projection is tested without git). Covers navigation clamping,
 * enter→{enter,sessionId}, enter-on-empty→{none}, and esc→{close}.
 */
import {reduceBranchesKey, initialBranchesState, type BranchesState} from "../interactive-tui/branchesOverlay";
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
const list = (rowIdx: number): BranchesState => ({stage: "list", rowIdx, confirmAbandon: false});

describe("branchesOverlay reducer — list stage", () => {
  it("starts at the first row", () => {
    expect(initialBranchesState()).toEqual({stage: "list", rowIdx: 0, confirmAbandon: false});
  });

  it("down moves the cursor and clamps at the last row", () => {
    const a = reduceBranchesKey(list(0), {name: "down"}, rows);
    expect(a).toEqual({kind: "none", state: list(1)});
    const last = reduceBranchesKey(list(2), {name: "down"}, rows);
    expect(last).toEqual({kind: "none", state: list(2)}); // clamped, no wrap
  });

  it("up moves the cursor and clamps at the first row", () => {
    expect(reduceBranchesKey(list(2), {name: "up"}, rows)).toEqual({kind: "none", state: list(1)});
    expect(reduceBranchesKey(list(0), {name: "up"}, rows)).toEqual({kind: "none", state: list(0)});
  });

  it("navigation clamps to 0 when there are no rows", () => {
    expect(reduceBranchesKey(list(0), {name: "down"}, [])).toEqual({kind: "none", state: list(0)});
  });

  it("enter selects the row under the cursor", () => {
    expect(reduceBranchesKey(list(1), {name: "return"}, rows)).toEqual({kind: "enter", sessionId: 3});
    expect(reduceBranchesKey(list(0), {sequence: "\r"}, rows)).toEqual({kind: "enter", sessionId: 2});
  });

  it("enter on an empty field is a no-op (cannot enter nothing)", () => {
    expect(reduceBranchesKey(list(0), {name: "enter"}, [])).toEqual({kind: "none", state: list(0)});
  });

  it("escape closes the overlay", () => {
    expect(reduceBranchesKey(list(1), {name: "escape"}, rows)).toEqual({kind: "close"});
  });

  it("an unhandled key leaves the state unchanged", () => {
    expect(reduceBranchesKey(list(1), {name: "z", sequence: "z"}, rows)).toEqual({kind: "none", state: list(1)});
  });

  it("returns the SAME state object on no-op keys so the overlay skips re-render", () => {
    const top = list(0);
    const upAtTop = reduceBranchesKey(top, {name: "up"}, rows);
    expect(upAtTop.kind).toBe("none");
    if (upAtTop.kind === "none") expect(upAtTop.state).toBe(top); // referential, not just equal

    const last = list(rows.length - 1);
    const downAtBottom = reduceBranchesKey(last, {name: "down"}, rows);
    if (downAtBottom.kind === "none") expect(downAtBottom.state).toBe(last);

    const unhandled = reduceBranchesKey(top, {name: "z", sequence: "z"}, rows);
    if (unhandled.kind === "none") expect(unhandled.state).toBe(top);

    // A real move still produces a fresh object.
    const moved = reduceBranchesKey(top, {name: "down"}, rows);
    if (moved.kind === "none") expect(moved.state).not.toBe(top);
  });
});

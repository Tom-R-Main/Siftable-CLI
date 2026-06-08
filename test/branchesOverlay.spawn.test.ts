/**
 * Track B B3 — the /branches overlay reducer, spawn sub-form. `s` opens the form;
 * ↑/↓ move fields, ←/→ cycle the mode, printable/backspace edit title/scope,
 * Enter advances then submits, Esc returns to the list. draftToSpawnInput maps a
 * finished draft to a spawnChild input and enforces the scoped-writer rule.
 */
import {
  reduceBranchesKey,
  initialBranchesState,
  emptySpawnDraft,
  draftToSpawnInput,
  type BranchesState,
  type SpawnDraft,
} from "../interactive-tui/branchesOverlay";
import type {MergeReadinessRow} from "../interactive-tui/mergeView";

const noRows: MergeReadinessRow[] = [];
const list = (rowIdx: number): BranchesState => ({stage: "list", rowIdx, confirmAbandon: false});
const form = (draft: Partial<SpawnDraft> = {}): BranchesState => ({stage: "spawnForm", draft: {...emptySpawnDraft(), ...draft}});

describe("branchesOverlay reducer — spawn sub-form", () => {
  it("s opens the spawn form at the title field", () => {
    expect(reduceBranchesKey(list(0), {name: "s", sequence: "s"}, noRows)).toEqual({
      kind: "none",
      state: form(),
    });
  });

  it("esc returns to the list (does not close)", () => {
    expect(reduceBranchesKey(form({fieldIdx: 1}), {name: "escape"}, noRows)).toEqual({
      kind: "none",
      state: initialBranchesState(),
    });
  });

  it("↑/↓ move between fields and clamp", () => {
    expect(reduceBranchesKey(form({fieldIdx: 0}), {name: "down"}, noRows)).toEqual({kind: "none", state: form({fieldIdx: 1})});
    expect(reduceBranchesKey(form({fieldIdx: 3}), {name: "down"}, noRows)).toEqual({kind: "none", state: form({fieldIdx: 3})});
    expect(reduceBranchesKey(form({fieldIdx: 0}), {name: "up"}, noRows)).toEqual({kind: "none", state: form({fieldIdx: 0})});
  });

  it("←/→ cycle the mode only on the mode field", () => {
    expect(reduceBranchesKey(form({fieldIdx: 2, mode: "rw"}), {name: "right"}, noRows)).toEqual({kind: "none", state: form({fieldIdx: 2, mode: "ro"})});
    expect(reduceBranchesKey(form({fieldIdx: 2, mode: "ro"}), {name: "right"}, noRows)).toEqual({kind: "none", state: form({fieldIdx: 2, mode: "rw-any"})});
    expect(reduceBranchesKey(form({fieldIdx: 2, mode: "rw-any"}), {name: "right"}, noRows)).toEqual({kind: "none", state: form({fieldIdx: 2, mode: "rw"})});
    expect(reduceBranchesKey(form({fieldIdx: 2, mode: "rw"}), {name: "left"}, noRows)).toEqual({kind: "none", state: form({fieldIdx: 2, mode: "rw-any"})});
    // left/right on a text field does nothing
    expect(reduceBranchesKey(form({fieldIdx: 0}), {name: "right"}, noRows)).toEqual({kind: "none", state: form({fieldIdx: 0})});
  });

  it("types into the focused text field and backspaces", () => {
    expect(reduceBranchesKey(form({fieldIdx: 0, title: "ab"}), {sequence: "c"}, noRows)).toEqual({kind: "none", state: form({fieldIdx: 0, title: "abc"})});
    expect(reduceBranchesKey(form({fieldIdx: 0, title: "abc"}), {name: "backspace"}, noRows)).toEqual({kind: "none", state: form({fieldIdx: 0, title: "ab"})});
    expect(reduceBranchesKey(form({fieldIdx: 1, scope: "src/"}), {sequence: "a"}, noRows)).toEqual({kind: "none", state: form({fieldIdx: 1, scope: "src/a"})});
    // typing on the mode/submit fields is ignored
    expect(reduceBranchesKey(form({fieldIdx: 2}), {sequence: "x"}, noRows)).toEqual({kind: "none", state: form({fieldIdx: 2})});
  });

  it("Enter advances through fields, then submits on the last", () => {
    expect(reduceBranchesKey(form({fieldIdx: 0}), {name: "return"}, noRows)).toEqual({kind: "none", state: form({fieldIdx: 1})});
    const draft = {...emptySpawnDraft(), fieldIdx: 3, title: "feat", scope: "a.ts"};
    expect(reduceBranchesKey({stage: "spawnForm", draft}, {name: "return"}, noRows)).toEqual({kind: "spawn", draft});
  });
});

describe("draftToSpawnInput", () => {
  it("requires a title", () => {
    expect(draftToSpawnInput({...emptySpawnDraft(), title: "  "})).toEqual({ok: false, error: "a title is required"});
  });

  it("maps a scoped writer, splitting globs on whitespace/commas", () => {
    expect(draftToSpawnInput({...emptySpawnDraft(), title: "feat", mode: "rw", scope: "src/a.ts, src/b.ts  test/c.ts"})).toEqual({
      ok: true,
      input: {title: "feat", accessMode: "read_write", writeScope: ["src/a.ts", "src/b.ts", "test/c.ts"]},
    });
  });

  it("rejects a scoped writer with no globs", () => {
    const r = draftToSpawnInput({...emptySpawnDraft(), title: "feat", mode: "rw", scope: "   "});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/needs at least one path glob/);
  });

  it("maps ro (no scope) and rw-any (unscoped writer)", () => {
    expect(draftToSpawnInput({...emptySpawnDraft(), title: "probe", mode: "ro", scope: "ignored"})).toEqual({
      ok: true,
      input: {title: "probe", accessMode: "read_only"},
    });
    expect(draftToSpawnInput({...emptySpawnDraft(), title: "wild", mode: "rw-any"})).toEqual({
      ok: true,
      input: {title: "wild", accessMode: "read_write"},
    });
  });
});

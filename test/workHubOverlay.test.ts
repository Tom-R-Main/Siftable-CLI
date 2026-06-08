/**
 * The /work hub overlay reducer. Pure (state, key, items) → action, so every
 * transition is asserted without the TUI renderer — the same discipline as
 * branchesOverlay.*.test.ts. Covers board navigation/clamping, the inline detail
 * toggle, the modal-safe report verbs (close-then-run), evidence, and the
 * handoff sub-form (field nav, text edit, submit, validation).
 */
import {
  reduceWorkKey,
  initialWorkState,
  emptyHandoffDraft,
  draftToHandoffInput,
  HANDOFF_FIELD_COUNT,
  type WorkState,
  type WorkBoardItem,
} from "../interactive-tui/workHubOverlay";

function item(id: string): WorkBoardItem {
  return {
    id,
    title: `work ${id}`,
    status: "queued",
    agent: "codex",
    owner: null,
    prompt: `do ${id}`,
    writeScope: ["src/**"],
    verification: ["npm test"],
    acceptance: ["it works"],
    blockers: [],
  };
}

const items = [item("a1"), item("b2"), item("c3")];
const board = (rowIdx: number, detailOpen = false): WorkState => ({stage: "board", rowIdx, detailOpen});

describe("workHubOverlay reducer — board stage", () => {
  it("starts on the first row with detail closed", () => {
    expect(initialWorkState()).toEqual({stage: "board", rowIdx: 0, detailOpen: false});
  });

  it("down moves the cursor and clamps at the last row", () => {
    expect(reduceWorkKey(board(0), {name: "down"}, items)).toEqual({kind: "none", state: board(1)});
    expect(reduceWorkKey(board(2), {name: "down"}, items)).toEqual({kind: "none", state: board(2)});
  });

  it("up moves the cursor and clamps at the first row", () => {
    expect(reduceWorkKey(board(2), {name: "up"}, items)).toEqual({kind: "none", state: board(1)});
    expect(reduceWorkKey(board(0), {name: "up"}, items)).toEqual({kind: "none", state: board(0)});
  });

  it("navigation clamps to 0 when there are no rows", () => {
    expect(reduceWorkKey(board(0), {name: "down"}, [])).toEqual({kind: "none", state: board(0)});
  });

  it("enter toggles the inline detail panel for the selected row", () => {
    expect(reduceWorkKey(board(1), {name: "return"}, items)).toEqual({kind: "none", state: board(1, true)});
    expect(reduceWorkKey(board(1, true), {sequence: "\r"}, items)).toEqual({kind: "none", state: board(1)});
  });

  it("enter on an empty board is a no-op (nothing to detail)", () => {
    expect(reduceWorkKey(board(0), {name: "return"}, [])).toEqual({kind: "none", state: board(0)});
  });

  it("moving the cursor collapses an open detail panel (it described the old row)", () => {
    expect(reduceWorkKey(board(0, true), {name: "down"}, items)).toEqual({kind: "none", state: board(1, false)});
  });

  it("escape closes the detail panel first, then the overlay", () => {
    expect(reduceWorkKey(board(1, true), {name: "escape"}, items)).toEqual({kind: "none", state: board(1, false)});
    expect(reduceWorkKey(board(1), {name: "escape"}, items)).toEqual({kind: "close"});
  });

  it("the report verbs close-then-run their command (never write behind the modal)", () => {
    expect(reduceWorkKey(board(0), {name: "p"}, items)).toEqual({kind: "run", command: "/plan work"});
    expect(reduceWorkKey(board(0), {name: "f"}, items)).toEqual({kind: "run", command: "/focus"});
    expect(reduceWorkKey(board(0), {name: "r"}, items)).toEqual({kind: "run", command: "/recap"});
    expect(reduceWorkKey(board(0), {name: "s"}, items)).toEqual({kind: "run", command: "/ship"});
  });

  it("v requests evidence for the selected row", () => {
    expect(reduceWorkKey(board(2), {name: "v"}, items)).toEqual({kind: "evidence", rowIdx: 2});
  });

  it("v on an empty board is a no-op (no item to prove)", () => {
    expect(reduceWorkKey(board(0), {name: "v"}, [])).toEqual({kind: "none", state: board(0)});
  });

  it("h opens the handoff sub-form with an empty draft", () => {
    expect(reduceWorkKey(board(0), {name: "h"}, items)).toEqual({
      kind: "none",
      state: {stage: "handoffForm", draft: emptyHandoffDraft()},
    });
  });

  it("an unhandled key leaves the state unchanged (same reference)", () => {
    const top = board(0);
    const res = reduceWorkKey(top, {name: "z", sequence: "z"}, items);
    expect(res).toEqual({kind: "none", state: top});
    if (res.kind === "none") expect(res.state).toBe(top);
  });

  it("returns the SAME state object on no-op nav so the overlay skips re-render", () => {
    const top = board(0);
    const upAtTop = reduceWorkKey(top, {name: "up"}, items);
    if (upAtTop.kind === "none") expect(upAtTop.state).toBe(top);
    const last = board(items.length - 1);
    const downAtBottom = reduceWorkKey(last, {name: "down"}, items);
    if (downAtBottom.kind === "none") expect(downAtBottom.state).toBe(last);
    const moved = reduceWorkKey(top, {name: "down"}, items);
    if (moved.kind === "none") expect(moved.state).not.toBe(top);
  });
});

describe("workHubOverlay reducer — handoff form", () => {
  const form = (draft = emptyHandoffDraft()): WorkState => ({stage: "handoffForm", draft});

  it("escape returns to the board (not close)", () => {
    expect(reduceWorkKey(form(), {name: "escape"}, items)).toEqual({kind: "none", state: initialWorkState()});
  });

  it("up/down move between fields and clamp", () => {
    expect(reduceWorkKey(form(), {name: "up"}, items)).toEqual({kind: "none", state: form()}); // clamped at 0
    const down = reduceWorkKey(form(), {name: "down"}, items);
    expect(down).toEqual({kind: "none", state: form({...emptyHandoffDraft(), fieldIdx: 1})});
    const atLast = form({...emptyHandoffDraft(), fieldIdx: HANDOFF_FIELD_COUNT - 1});
    expect(reduceWorkKey(atLast, {name: "down"}, items)).toEqual({kind: "none", state: atLast});
  });

  it("typing edits the focused field; backspace deletes", () => {
    const afterTitle = reduceWorkKey(form(), {sequence: "x"}, items);
    expect(afterTitle).toEqual({kind: "none", state: form({...emptyHandoffDraft(), title: "x"})});
    const onFiles = form({...emptyHandoffDraft(), fieldIdx: 2, files: "src/a.ts"});
    const afterBackspace = reduceWorkKey(onFiles, {name: "backspace"}, items);
    expect(afterBackspace).toEqual({kind: "none", state: form({...emptyHandoffDraft(), fieldIdx: 2, files: "src/a.t"})});
  });

  it("enter advances through fields, then submits at the last field", () => {
    const onAcceptance = form({...emptyHandoffDraft(), title: "T", fieldIdx: 3});
    const advanced = reduceWorkKey(onAcceptance, {name: "return"}, items);
    expect(advanced).toEqual({kind: "none", state: form({...emptyHandoffDraft(), title: "T", fieldIdx: 4})});
    const submit = reduceWorkKey(form({...emptyHandoffDraft(), title: "T", fieldIdx: 4}), {name: "return"}, items);
    expect(submit).toEqual({kind: "handoff", draft: {...emptyHandoffDraft(), title: "T", fieldIdx: 4}});
  });
});

describe("draftToHandoffInput", () => {
  it("rejects an empty title", () => {
    expect(draftToHandoffInput(emptyHandoffDraft())).toEqual({ok: false, error: "a title is required"});
  });

  it("defaults the agent to codex and splits files/acceptance", () => {
    const res = draftToHandoffInput({
      title: "  Fix paste  ",
      agent: "",
      files: "src/a.ts, src/b.ts  src/c.ts",
      acceptance: "compiles; tests pass ; ",
      fieldIdx: 4,
    });
    expect(res).toEqual({
      ok: true,
      input: {
        title: "Fix paste",
        agent: "codex",
        files: ["src/a.ts", "src/b.ts", "src/c.ts"],
        acceptance: ["compiles", "tests pass"],
      },
    });
  });

  it("keeps an explicit agent and tolerates empty file/acceptance fields", () => {
    expect(draftToHandoffInput({title: "T", agent: "claude", files: "", acceptance: "", fieldIdx: 4})).toEqual({
      ok: true,
      input: {title: "T", agent: "claude", files: [], acceptance: []},
    });
  });
});

/**
 * branchesOverlay — the pure state machine behind the `/branches` hub overlay.
 *
 * The Solid component in index.tsx can't be unit-tested without a renderer, so
 * the keyboard logic lives here as a pure reducer: (state, key, rows) → action.
 * index.tsx owns only the signal, the dispatch of returned actions to the live
 * childController, and the render — the "pure fold + thin shell" split used by
 * mergeView.ts (pure projection) vs. the controller (git side effects).
 *
 * Stages: "list" (browse children: navigate / enter / ready / merge / abandon)
 * and "spawnForm" (title / scope / mode → spawn a new child).
 */
import type {MergeReadinessRow} from "./mergeView";

/** List stage: browsing children. `confirmAbandon` arms the destructive `a` key. */
export interface BranchesListState {
  stage: "list";
  rowIdx: number;
  confirmAbandon: boolean;
}

/** rw = scoped writer (Gate-A), ro = read-only, rw-any = unscoped writer. */
export type SpawnMode = "rw" | "ro" | "rw-any";

export interface SpawnDraft {
  title: string;
  /** Raw text; split into globs on submit. */
  scope: string;
  mode: SpawnMode;
  /** 0 title · 1 scope · 2 mode · 3 submit. */
  fieldIdx: number;
}

export interface BranchesSpawnState {
  stage: "spawnForm";
  draft: SpawnDraft;
}

export type BranchesState = BranchesListState | BranchesSpawnState;

/** Spawn input shape handed to childController.spawnChild (subset). */
export interface SpawnInput {
  title: string;
  accessMode: "read_only" | "read_write";
  writeScope?: string[];
}

/**
 * The result of a keypress: either pure navigation (`none`, with the next state)
 * or a side-effecting action for index.tsx to dispatch to the controller.
 */
export type BranchesAction =
  | {kind: "none"; state: BranchesState}
  | {kind: "close"}
  | {kind: "enter"; sessionId: number}
  | {kind: "ready"; sessionId: number}
  | {kind: "merge"; sessionId: number}
  | {kind: "abandon"; sessionId: number}
  | {kind: "spawn"; draft: SpawnDraft};

/** Structural subset of the TUI KeyEvent — keeps this module renderer-free. */
export interface BranchesKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}

export const SPAWN_FIELD_COUNT = 4; // title, scope, mode, submit
export const SPAWN_MODES: SpawnMode[] = ["rw", "ro", "rw-any"];

export function initialBranchesState(): BranchesState {
  return {stage: "list", rowIdx: 0, confirmAbandon: false};
}

export function emptySpawnDraft(): SpawnDraft {
  return {title: "", scope: "", mode: "rw", fieldIdx: 0};
}

function isEnter(key: BranchesKey): boolean {
  return key.name === "return" || key.name === "enter" || key.sequence === "\r" || key.sequence === "\n";
}

/** The lowercased single character a key produced, or null for chords/named keys. */
function charKey(key: BranchesKey): string | null {
  if (key.ctrl || key.meta) return null;
  if (key.name && key.name.length === 1) return key.name.toLowerCase();
  if (key.sequence && key.sequence.length === 1 && key.sequence >= " ") return key.sequence.toLowerCase();
  return null;
}

/** Apply one text-edit key to a field, or null when the key isn't a text edit. */
function editText(current: string, key: BranchesKey): string | null {
  if (key.name === "backspace" || key.sequence === "\x7f") return current.slice(0, -1);
  const s = key.sequence;
  if (!s || s.length !== 1 || s < " " || key.ctrl || key.meta) return null;
  return current + s;
}

function clampRow(idx: number, len: number): number {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(len - 1, idx));
}

/**
 * Map a finished draft to the spawnChild input, validating the scope rule that
 * `parseSpawnArgs` enforces: a scoped writer needs ≥1 glob. Pure + testable.
 */
export function draftToSpawnInput(draft: SpawnDraft): {ok: true; input: SpawnInput} | {ok: false; error: string} {
  const title = draft.title.trim();
  if (!title) return {ok: false, error: "a title is required"};
  if (draft.mode === "ro") return {ok: true, input: {title, accessMode: "read_only"}};
  if (draft.mode === "rw-any") return {ok: true, input: {title, accessMode: "read_write"}};
  const globs = draft.scope.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (globs.length === 0) {
    return {ok: false, error: "a scoped writer needs at least one path glob (or pick ro / rw-any)"};
  }
  return {ok: true, input: {title, accessMode: "read_write", writeScope: globs}};
}

function reduceList(state: BranchesListState, key: BranchesKey, rows: MergeReadinessRow[]): BranchesAction {
  const row = rows[state.rowIdx];

  // Armed abandon confirm: the next key IS the answer. `y` abandons the selected
  // row; anything else (incl. esc, n) cancels — esc here means "cancel the
  // confirm", not "close the overlay".
  if (state.confirmAbandon) {
    if (charKey(key) === "y" && row) return {kind: "abandon", sessionId: row.sessionId};
    return {kind: "none", state: {...state, confirmAbandon: false}};
  }

  if (key.name === "escape") return {kind: "close"};
  if (key.name === "up" || key.name === "down") {
    const rowIdx = clampRow(state.rowIdx + (key.name === "up" ? -1 : 1), rows.length);
    // Same reference when already at the edge → the dispatcher skips the
    // re-render (see index.tsx: only set on referential change).
    return rowIdx === state.rowIdx ? {kind: "none", state} : {kind: "none", state: {...state, rowIdx}};
  }
  if (isEnter(key)) return row ? {kind: "enter", sessionId: row.sessionId} : {kind: "none", state};

  // Action keys. `a` arms a two-step confirm (abandon is destructive); `r`/`m`
  // fire directly — an explicit keypress in the dashboard is the authority. `s`
  // opens the spawn sub-form.
  switch (charKey(key)) {
    case "r":
      return row ? {kind: "ready", sessionId: row.sessionId} : {kind: "none", state};
    case "m":
      return row ? {kind: "merge", sessionId: row.sessionId} : {kind: "none", state};
    case "a":
      return row ? {kind: "none", state: {...state, confirmAbandon: true}} : {kind: "none", state};
    case "s":
      return {kind: "none", state: {stage: "spawnForm", draft: emptySpawnDraft()}};
    default:
      return {kind: "none", state};
  }
}

function reduceSpawnForm(state: BranchesSpawnState, key: BranchesKey): BranchesAction {
  const draft = state.draft;
  if (key.name === "escape") return {kind: "none", state: initialBranchesState()}; // back to list

  if (key.name === "up") {
    return {kind: "none", state: {stage: "spawnForm", draft: {...draft, fieldIdx: Math.max(0, draft.fieldIdx - 1)}}};
  }
  if (key.name === "down") {
    return {
      kind: "none",
      state: {stage: "spawnForm", draft: {...draft, fieldIdx: Math.min(SPAWN_FIELD_COUNT - 1, draft.fieldIdx + 1)}},
    };
  }
  // Mode field: ←/→ cycles rw → ro → rw-any.
  if (draft.fieldIdx === 2 && (key.name === "left" || key.name === "right")) {
    const i = SPAWN_MODES.indexOf(draft.mode);
    const next = key.name === "right" ? (i + 1) % SPAWN_MODES.length : (i + SPAWN_MODES.length - 1) % SPAWN_MODES.length;
    return {kind: "none", state: {stage: "spawnForm", draft: {...draft, mode: SPAWN_MODES[next]}}};
  }
  if (isEnter(key)) {
    if (draft.fieldIdx < SPAWN_FIELD_COUNT - 1) {
      return {kind: "none", state: {stage: "spawnForm", draft: {...draft, fieldIdx: draft.fieldIdx + 1}}};
    }
    return {kind: "spawn", draft};
  }
  // Text editing on the title / scope fields.
  if (draft.fieldIdx === 0) {
    const t = editText(draft.title, key);
    if (t !== null) return {kind: "none", state: {stage: "spawnForm", draft: {...draft, title: t}}};
  } else if (draft.fieldIdx === 1) {
    const sc = editText(draft.scope, key);
    if (sc !== null) return {kind: "none", state: {stage: "spawnForm", draft: {...draft, scope: sc}}};
  }
  return {kind: "none", state};
}

/**
 * Reduce one keypress against the overlay state. Pure: no I/O, no controller.
 * `rows` is the current readiness snapshot — used to map the cursor to a session
 * id and to bound navigation (unused in the spawnForm stage).
 */
export function reduceBranchesKey(
  state: BranchesState,
  key: BranchesKey,
  rows: MergeReadinessRow[],
): BranchesAction {
  return state.stage === "spawnForm" ? reduceSpawnForm(state, key) : reduceList(state, key, rows);
}

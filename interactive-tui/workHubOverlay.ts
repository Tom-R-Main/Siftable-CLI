/**
 * workHubOverlay — the pure state machine behind the `/work` hub overlay.
 *
 * Same split as branchesOverlay.ts: the Solid component in index.tsx can't be
 * unit-tested without a renderer, so the keyboard logic lives here as a pure
 * reducer (state, key, rows) → action. index.tsx owns the signal, the async
 * dispatch (data fetches, close-then-run), and the render.
 *
 * Modal contract (the lesson from /branches): the board reads its rows directly
 * and renders them in-overlay; it NEVER shells out to a transcript-writing
 * command while open. The report verbs (`p`/`f`/`r`/`s`) emit a `run` action
 * that index.tsx dispatches by CLOSING the overlay first, then running the
 * command — so their output never lands behind the modal. The one inline
 * action is `v` (evidence), which is the reason the hub is worth a modal.
 *
 * Stages: "board" (browse work items: nav / open detail / evidence / report
 * verbs / handoff) and "handoffForm" (title / agent / files / acceptance →
 * create a work item).
 */

/** A work item normalized for the board — populated by loadWorkBoard in commands.ts. */
export interface WorkBoardItem {
  id: string;
  title: string;
  status: string;
  /** assigned agent alias, or "-" when unassigned. */
  agent: string;
  /** claim owner, when the item is claimed. */
  owner: string | null;
  prompt: string | null;
  writeScope: string[];
  verification: string[];
  acceptance: string[];
  blockers: string[];
}

/** Header agents fold (small, rarely the focus) + the rows the board navigates. */
export interface WorkBoardData {
  agents: {alias: string; status: string}[];
  items: WorkBoardItem[];
}

/** Board stage: browsing work items. `detailOpen` expands the selected row inline. */
export interface WorkBoardState {
  stage: "board";
  rowIdx: number;
  detailOpen: boolean;
}

export interface HandoffDraft {
  title: string;
  /** Agent alias to assign; defaults to "codex". */
  agent: string;
  /** Raw comma/space text; split into a file list on submit. */
  files: string;
  /** Raw `;`-separated text; split into acceptance criteria on submit. */
  acceptance: string;
  /** 0 title · 1 agent · 2 files · 3 acceptance · 4 submit. */
  fieldIdx: number;
}

export interface WorkHandoffState {
  stage: "handoffForm";
  draft: HandoffDraft;
}

export type WorkState = WorkBoardState | WorkHandoffState;

/** Validated handoff input handed to createWorkItem (subset; ctx fills the rest). */
export interface HandoffInput {
  title: string;
  agent: string;
  files: string[];
  acceptance: string[];
}

/**
 * The result of a keypress: pure navigation (`none`, with the next state) or a
 * side-effecting action for index.tsx to dispatch. `run` is the close-then-run
 * escape hatch for the report verbs; `evidence` and `handoff` are the two
 * inline/mutating actions.
 */
export type WorkAction =
  | {kind: "none"; state: WorkState}
  | {kind: "close"}
  | {kind: "evidence"; rowIdx: number}
  | {kind: "run"; command: string}
  | {kind: "handoff"; draft: HandoffDraft};

/** Structural subset of the TUI KeyEvent — keeps this module renderer-free. */
export interface WorkKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}

export const HANDOFF_FIELD_COUNT = 5; // title, agent, files, acceptance, submit

/** Report verbs that close the overlay, then run their command (no behind-modal writes). */
const RUN_KEYS: Record<string, string> = {
  p: "/plan work",
  f: "/focus",
  r: "/recap",
  s: "/ship",
};

export function initialWorkState(): WorkState {
  return {stage: "board", rowIdx: 0, detailOpen: false};
}

export function emptyHandoffDraft(): HandoffDraft {
  return {title: "", agent: "codex", files: "", acceptance: "", fieldIdx: 0};
}

function isEnter(key: WorkKey): boolean {
  return key.name === "return" || key.name === "enter" || key.sequence === "\r" || key.sequence === "\n";
}

/** The lowercased single character a key produced, or null for chords/named keys. */
function charKey(key: WorkKey): string | null {
  if (key.ctrl || key.meta) return null;
  if (key.name && key.name.length === 1) return key.name.toLowerCase();
  if (key.sequence && key.sequence.length === 1 && key.sequence >= " ") return key.sequence.toLowerCase();
  return null;
}

/** Apply one text-edit key to a field, or null when the key isn't a text edit. */
function editText(current: string, key: WorkKey): string | null {
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
 * Map a finished handoff draft to createWorkItem input. The only hard rule is a
 * non-empty title (mirrors the /handoff command). Pure + testable.
 */
export function draftToHandoffInput(draft: HandoffDraft): {ok: true; input: HandoffInput} | {ok: false; error: string} {
  const title = draft.title.trim();
  if (!title) return {ok: false, error: "a title is required"};
  const agent = draft.agent.trim() || "codex";
  const files = draft.files.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const acceptance = draft.acceptance.split(";").map((s) => s.trim()).filter(Boolean);
  return {ok: true, input: {title, agent, files, acceptance}};
}

function reduceBoard(state: WorkBoardState, key: WorkKey, items: WorkBoardItem[]): WorkAction {
  // Esc closes the detail panel first if it's open, else the overlay.
  if (key.name === "escape") {
    return state.detailOpen ? {kind: "none", state: {...state, detailOpen: false}} : {kind: "close"};
  }
  if (key.name === "up" || key.name === "down") {
    const rowIdx = clampRow(state.rowIdx + (key.name === "up" ? -1 : 1), items.length);
    // Same reference at the edge → the dispatcher skips the re-render. Moving the
    // cursor also collapses any open detail panel (it described the old row).
    return rowIdx === state.rowIdx
      ? {kind: "none", state}
      : {kind: "none", state: {...state, rowIdx, detailOpen: false}};
  }
  // Enter toggles the inline detail panel for the selected row (no transcript write).
  if (isEnter(key)) {
    return items.length ? {kind: "none", state: {...state, detailOpen: !state.detailOpen}} : {kind: "none", state};
  }

  const ch = charKey(key);
  if (ch && RUN_KEYS[ch]) return {kind: "run", command: RUN_KEYS[ch]}; // close-then-run
  switch (ch) {
    case "v":
      return items.length ? {kind: "evidence", rowIdx: state.rowIdx} : {kind: "none", state};
    case "h":
      return {kind: "none", state: {stage: "handoffForm", draft: emptyHandoffDraft()} as WorkState};
    default:
      return {kind: "none", state};
  }
}

function reduceHandoffForm(state: WorkHandoffState, key: WorkKey): WorkAction {
  const draft = state.draft;
  if (key.name === "escape") return {kind: "none", state: initialWorkState()}; // back to board

  if (key.name === "up") {
    return {kind: "none", state: {stage: "handoffForm", draft: {...draft, fieldIdx: Math.max(0, draft.fieldIdx - 1)}}};
  }
  if (key.name === "down") {
    return {
      kind: "none",
      state: {stage: "handoffForm", draft: {...draft, fieldIdx: Math.min(HANDOFF_FIELD_COUNT - 1, draft.fieldIdx + 1)}},
    };
  }
  if (isEnter(key)) {
    if (draft.fieldIdx < HANDOFF_FIELD_COUNT - 1) {
      return {kind: "none", state: {stage: "handoffForm", draft: {...draft, fieldIdx: draft.fieldIdx + 1}}};
    }
    return {kind: "handoff", draft};
  }
  // Text editing on the four input fields (0 title · 1 agent · 2 files · 3 acceptance).
  const fields = ["title", "agent", "files", "acceptance"] as const;
  const fieldName = fields[draft.fieldIdx];
  if (fieldName) {
    const next = editText(draft[fieldName], key);
    if (next !== null) return {kind: "none", state: {stage: "handoffForm", draft: {...draft, [fieldName]: next}}};
  }
  return {kind: "none", state};
}

/**
 * Reduce one keypress against the overlay state. Pure: no I/O, no controller,
 * no command dispatch. `items` is the current board snapshot — used to map the
 * cursor to a row and to bound navigation (unused in the handoffForm stage).
 */
export function reduceWorkKey(state: WorkState, key: WorkKey, items: WorkBoardItem[]): WorkAction {
  return state.stage === "handoffForm" ? reduceHandoffForm(state, key) : reduceBoard(state, key, items);
}

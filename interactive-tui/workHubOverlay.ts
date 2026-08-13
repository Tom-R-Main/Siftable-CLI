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
 * verbs / handoff), "handoffForm" (guided Work Contract V1 authoring), and
 * "handoffPreview" (review the normalized contract before confirming).
 */

import type {WorkContractV1} from "@siftable/mcp-server/dist/exfClient.js";
import {buildWorkContract} from "../src/lib/work-contract.js";

export type WorkContractClassification = "bounded" | "legacy" | "invalid";

export interface WorkContractDisplay {
  classification: WorkContractClassification;
  profile: string | null;
  enabledActions: string[];
  acceptanceCriteriaCount: number;
  verificationCommandCount: number;
  verifiedCommandCount: number;
  verificationState: string;
  explanation: string | null;
}

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
  excludedScope?: string[];
  verification: string[];
  acceptance: string[];
  blockers: string[];
  claimability?: string;
  contract?: WorkContractDisplay;
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
  /** Contract profile; authority defaults are derived from this choice. */
  profile?: "coding" | "read_only";
  /** Agent alias to assign; defaults to "codex". */
  agent: string;
  /** Raw comma/space text; split into a file list on submit. */
  files: string;
  /** Raw comma/space text for excluded scope. */
  excludeFiles?: string;
  /** Raw `;`-separated text; split into acceptance criteria on submit. */
  acceptance: string;
  /** Raw `;`-separated verification commands. */
  verify?: string;
  /** 0 title · 1 agent/profile · 2 files · 3 acceptance · 4 proof/preview. */
  fieldIdx: number;
}

export interface WorkHandoffState {
  stage: "handoffForm";
  draft: HandoffDraft;
}

export interface WorkHandoffPreviewState {
  stage: "handoffPreview";
  draft: HandoffDraft;
}

export type WorkState = WorkBoardState | WorkHandoffState | WorkHandoffPreviewState;

/** Validated handoff input handed to createWorkItem (subset; ctx fills the rest). */
export interface HandoffInput {
  title: string;
  profile: "coding" | "read_only";
  agent: string;
  files: string[];
  excludeFiles: string[];
  acceptance: string[];
  verify: string[];
  contract: WorkContractV1;
}

export interface LegacyHandoffInput {
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
  | {kind: "runWork"; rowIdx: number}
  | {kind: "handoff"; draft: HandoffDraft};

/** Structural subset of the TUI KeyEvent — keeps this module renderer-free. */
export interface WorkKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}

export const HANDOFF_FIELD_COUNT = 5;

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
  return {
    title: "",
    profile: "coding",
    agent: "codex",
    files: "",
    excludeFiles: "",
    acceptance: "",
    verify: "",
    fieldIdx: 0,
  };
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
export function draftToHandoffInput(draft: HandoffDraft): {ok: true; input: HandoffInput | LegacyHandoffInput} | {ok: false; error: string} {
  const title = draft.title.trim();
  if (!title) return {ok: false, error: "a title is required"};
  const agent = draft.agent.trim() || "codex";
  const files = draft.files.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const legacyDraft = draft.profile === undefined && draft.excludeFiles === undefined && draft.verify === undefined;
  const acceptance = draft.acceptance.split(";").map((s) => s.trim()).filter(Boolean);
  if (legacyDraft) return {ok: true, input: {title, agent, files, acceptance}};
  const profile = draft.profile ?? "coding";
  const excludeFiles = (draft.excludeFiles ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const verify = (draft.verify ?? "").split(";").map((s) => s.trim()).filter(Boolean);
  const parsed = buildWorkContract({
    profile,
    acceptanceCriteria: acceptance.map((text) => ({text, met: false})),
    writeScope: {include: files, exclude: excludeFiles},
    verificationCommands: verify,
  });
  if (parsed.classification !== "bounded" || !parsed.contract) {
    const detail = parsed.violations[0];
    return {
      ok: false,
      error: detail
        ? `${detail.path || "contract"}: ${detail.message}`
        : "the work contract is incomplete",
    };
  }
  return {
    ok: true,
    input: {title, profile, agent, files, excludeFiles, acceptance, verify, contract: parsed.contract},
  };
}

export function contractBadge(contract: WorkContractDisplay): string {
  if (contract.classification === "bounded") return `bounded:${contract.profile ?? "unknown"}`;
  return contract.classification;
}

export function proofCoverage(contract: WorkContractDisplay): string {
  if (contract.classification === "legacy") return "proof missing";
  if (contract.classification === "invalid") return "proof invalid";
  return `${contract.verifiedCommandCount}/${contract.verificationCommandCount} proof · ${contract.verificationState}`;
}

/** Compact row content shared by the renderer and reducer tests. */
export function formatWorkRow(item: WorkBoardItem): string {
  const contract = item.contract ?? {
    classification: "legacy" as const,
    profile: null,
    enabledActions: [],
    acceptanceCriteriaCount: 0,
    verificationCommandCount: 0,
    verifiedCommandCount: 0,
    verificationState: "unverified",
    explanation: "Legacy item: re-author a bounded replacement before running it.",
  };
  const owner = item.owner ? ` · ${item.owner}` : "";
  const blocked = item.blockers.length ? ` · ${item.blockers.length} blocker(s)` : "";
  return `${item.title} · ${contractBadge(contract)} · ${proofCoverage(contract)} · ${item.status} [${item.agent}]${owner}${blocked}`;
}

/** Group the selected item by the five Work Contract control-plane concepts. */
export function workDetailLines(item: WorkBoardItem): string[] {
  const scope = item.writeScope.length ? item.writeScope.join(", ") : "none";
  const excluded = item.excludedScope?.length ? item.excludedScope.join(", ") : "none";
  const contract = item.contract ?? {
    classification: "legacy" as const,
    profile: null,
    enabledActions: [],
    acceptanceCriteriaCount: 0,
    verificationCommandCount: 0,
    verifiedCommandCount: 0,
    verificationState: "unverified",
    explanation: "Legacy item: re-author a bounded replacement before running it.",
  };
  const actions = contract.enabledActions.length ? contract.enabledActions.join(", ") : "none";
  const owner = item.owner ?? "unclaimed";
  return [
    `Outcome    ${item.prompt?.replace(/\s+/g, " ").slice(0, 160) || item.title}`,
    `           ${item.acceptance.length ? item.acceptance.join("; ") : "no acceptance criteria declared"}`,
    `Authority  ${contract.profile ?? "unknown"} · ${actions}`,
    `Boundary   include ${scope} · exclude ${excluded}`,
    `Proof      ${proofCoverage(contract)} · ${item.acceptance.length} acceptance ${item.acceptance.length === 1 ? "criterion" : "criteria"}`,
    `Execution  ${item.status} · ${item.agent} · ${owner} · claim ${item.claimability ?? "unknown"}`,
    ...(contract.explanation ? [`Contract   ${contract.explanation}`] : []),
    ...item.blockers.map((blocker) => `Blocked    ${blocker}`),
  ];
}

export function handoffPreviewLines(draft: HandoffDraft): string[] {
  const mapped = draftToHandoffInput(draft);
  if (mapped.ok === false) return [`Contract invalid: ${mapped.error}`];
  const input = mapped.input;
  if (!("contract" in input)) return ["Legacy draft: return to editing and complete the contract."];
  const actions = Object.entries(input.contract.authority.allowedActions)
    .filter(([, enabled]) => enabled)
    .map(([action]) => action)
    .join(", ");
  return [
    `Outcome    ${input.title}`,
    `           ${input.acceptance.length ? input.acceptance.join("; ") : "no acceptance criteria"}`,
    `Authority  ${input.profile} · ${actions || "none"}`,
    `Boundary   include ${input.files.join(", ") || "none"} · exclude ${input.excludeFiles.join(", ") || "none"}`,
    `Proof      ${input.verify.join(" · ") || "no commands"}`,
    `Execution  assign ${input.agent} · queued`,
  ];
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
    case "x":
      return items.length ? {kind: "runWork", rowIdx: state.rowIdx} : {kind: "none", state};
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
  if ((key.name === "left" || key.name === "right" || key.sequence === " ") && draft.fieldIdx === 1) {
    const profile = (draft.profile ?? "coding") === "coding" ? "read_only" : "coding";
    return {
      kind: "none",
      state: {stage: "handoffForm", draft: {...draft, profile, files: profile === "read_only" ? "" : draft.files, excludeFiles: profile === "read_only" ? "" : draft.excludeFiles}},
    };
  }
  if (isEnter(key)) {
    if (draft.fieldIdx < HANDOFF_FIELD_COUNT - 1) {
      return {kind: "none", state: {stage: "handoffForm", draft: {...draft, fieldIdx: draft.fieldIdx + 1}}};
    }
    const mapped = draftToHandoffInput(draft);
    // Keep the historical reducer action for an incomplete draft; index.tsx
    // validates it and renders the actionable error. A valid contract advances
    // to preview and requires a second Enter to create.
    return mapped.ok === false
      ? {kind: "handoff", draft}
      : {kind: "none", state: {stage: "handoffPreview", draft}};
  }
  const fields = ["title", "agent", "files", "acceptance", "verify"] as const;
  const fieldName = fields[draft.fieldIdx];
  if (fieldName) {
    const next = editText(draft[fieldName], key);
    if (next !== null) return {kind: "none", state: {stage: "handoffForm", draft: {...draft, [fieldName]: next}}};
  }
  return {kind: "none", state};
}

function reduceHandoffPreview(state: WorkHandoffPreviewState, key: WorkKey): WorkAction {
  if (key.name === "escape") return {kind: "none", state: {stage: "handoffForm", draft: state.draft}};
  if (isEnter(key)) return {kind: "handoff", draft: state.draft};
  return {kind: "none", state};
}

/**
 * Reduce one keypress against the overlay state. Pure: no I/O, no controller,
 * no command dispatch. `items` is the current board snapshot — used to map the
 * cursor to a row and to bound navigation (unused in the handoffForm stage).
 */
export function reduceWorkKey(state: WorkState, key: WorkKey, items: WorkBoardItem[]): WorkAction {
  if (state.stage === "handoffForm") return reduceHandoffForm(state, key);
  if (state.stage === "handoffPreview") return reduceHandoffPreview(state, key);
  return reduceBoard(state, key, items);
}

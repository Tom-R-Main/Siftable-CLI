/**
 * childBar — pure formatter for the mergeMaster child-session segment of the
 * agent bar. Lane C renders children as their OWN segment, distinct from the
 * backend RunningAgent[] rows: a child is "a branch with a conversation," not a
 * queued backend agent, and conflating the two hides which is which.
 *
 * This module maps child sessions → display entries and is intentionally pure
 * (no Solid, no controller): the TUI calls it each render, tests assert it
 * directly. Each entry is keyed by the stable `sessionId`, never by array index,
 * so reordering the underlying list never renumbers a child or moves the active
 * marker onto the wrong one.
 */
import type {ChildSessionView} from "./childSessionController";
import type {MergeMasterStatus} from "./mergeMaster";

export interface ChildBarEntry {
  /** Stable handle — also what `/enter <id>` takes. Never the array index. */
  sessionId: number;
  /** Short, badged label, e.g. "child·a-1". */
  label: string;
  branch: string;
  status: MergeMasterStatus | "unknown";
  accessMode: "read_only" | "read_write";
  /** True for the single session the user is currently inside. */
  active: boolean;
}

/** Drop the `sift/` namespace prefix for a compact label; keep the rest. */
function branchLeaf(branch: string): string {
  return branch.replace(/^sift\//, "");
}

/**
 * Build the child-bar entries. Pure function of (children, activeChildId):
 * the same inputs always yield the same entries, and an entry's identity and
 * active flag depend only on its `sessionId`, not on its position in `children`.
 */
export function formatChildBar(
  children: ChildSessionView[],
  activeChildId: number | null,
): ChildBarEntry[] {
  return children.map((c) => ({
    sessionId: c.sessionId,
    label: `child·${branchLeaf(c.branch)}`,
    branch: c.branch,
    status: c.status,
    accessMode: c.accessMode,
    active: c.sessionId === activeChildId,
  }));
}

/** One-line summary for a compact status bar, e.g. "▶a-1·running  b-2·idle". */
export function formatChildBarLine(entries: ChildBarEntry[]): string {
  if (!entries.length) return "";
  return entries
    .map((e) => `${e.active ? "▶" : ""}${branchLeaf(e.branch)}·${e.status}`)
    .join("  ");
}

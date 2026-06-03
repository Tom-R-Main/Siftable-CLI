/**
 * Approval gate — the mutating-action approval round-trip shared by the codex
 * engine (command/file-change escalations) and the OpenFunction write tools.
 *
 * The brain and the TUI run in the SAME Bun process (SIFT_LOCAL_BRAIN), so a
 * handler that needs approval simply awaits a Promise the UI resolves on the
 * keypress: the caller invokes `requestApproval`, the UI registers a listener
 * via `setConfirmListener`, renders the overlay, and calls `resolveApproval`.
 *
 * Four decisions, mirroring how codex-cli / opencode present approvals:
 *   - "deny"   — reject this action (codex: decline / denied)
 *   - "allow"  — approve just this once (codex: accept / approved)
 *   - "always" — approve and don't ask again for THIS action this session
 *                (codex: acceptForSession / approved_for_session)
 *   - "bypass" — approve, and stop asking for the rest of the session
 *                (codex models this as approvalPolicy "never"; neither reference
 *                tool exposes it as a per-request button — it's our addition)
 *
 * Safety invariant: if no UI is listening, `requestApproval` DENIES — an action
 * never proceeds without an explicit interactive approval. Once the user picks
 * "bypass", that invariant is intentionally lifted for the rest of the session.
 */
import { randomUUID } from "node:crypto";

export type ApprovalDecision = "deny" | "allow" | "always" | "bypass";

export interface ConfirmSpec {
  kind: "write" | "edit" | "command";
  /** What's being approved — a target path (write/edit) or a command string. */
  path: string;
  /** Secondary line: byte count, char delta, cwd, or the escalation reason. */
  detail: string;
  /** Whether to offer the "always allow this action" option (default true). */
  allowAlways?: boolean;
}

export interface ConfirmRequest extends ConfirmSpec {
  id: string;
}

type Listener = (req: ConfirmRequest) => void;

let listener: Listener | null = null;
let bypassing = false;
const pending = new Map<string, (decision: ApprovalDecision) => void>();

/** Register (or clear, with null) the UI renderer for approval requests. */
export function setConfirmListener(next: Listener | null): void {
  listener = next;
}

/** True once the user chose "bypass" — approvals auto-allow for the rest of the session. */
export function isBypassing(): boolean {
  return bypassing;
}

/**
 * Ask the user to approve a mutating action. Resolves to one of the four
 * decisions. Auto-allows if the session is in bypass mode; denies if no UI is
 * listening. Never rejects — callers treat "deny" as "do not proceed".
 */
export function requestApproval(spec: ConfirmSpec): Promise<ApprovalDecision> {
  if (bypassing) return Promise.resolve("allow");
  if (!listener) return Promise.resolve("deny");
  const id = randomUUID();
  return new Promise<ApprovalDecision>((resolve) => {
    pending.set(id, resolve);
    listener!({ allowAlways: true, ...spec, id });
  });
}

/** The UI calls this when the user answers. No-op for unknown/stale ids. */
export function resolveApproval(id: string, decision: ApprovalDecision): void {
  const resolve = pending.get(id);
  if (!resolve) return;
  pending.delete(id);
  if (decision === "bypass") bypassing = true;
  resolve(decision);
}

/** Deny and clear every pending approval (e.g. on abort or teardown). */
export function rejectAllConfirms(): void {
  for (const resolve of pending.values()) resolve("deny");
  pending.clear();
}

export function pendingConfirmCount(): number {
  return pending.size;
}

/** Clear bypass mode (teardown / tests / an explicit "re-arm approvals"). */
export function resetBypass(): void {
  bypassing = false;
}

// ── Boolean shims — the OpenFunction write tools only care allow-vs-deny ──────

/** Boolean view of `requestApproval` for callers that don't need the 4-way decision. */
export function requestConfirm(spec: ConfirmSpec): Promise<boolean> {
  return requestApproval(spec).then((d) => d !== "deny");
}

/** Boolean view of `resolveApproval` (true → allow, false → deny). */
export function resolveConfirm(id: string, approved: boolean): void {
  resolveApproval(id, approved ? "allow" : "deny");
}

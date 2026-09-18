/**
 * Approval gate — the mutating-action approval round-trip shared by the codex
 * engine (command/file-change escalations) and the agent-harness write tools.
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
 * "bypass", that invariant is intentionally lifted for the rest of the session —
 * except for requests with `allowBypass: false`, which keep prompting; tools
 * declared `approval: "always"` are pinned that way by the registry.
 */
import { randomUUID } from "node:crypto";
import { assertExecutionActive, currentExecutionContext, type ToolExecutionContext } from './agent-harness/framework/execution-context';
import { CommandGrants, tokenizeCommand } from './commandPolicy';

export type ApprovalDecision = "deny" | "allow" | "always" | "bypass";

export interface ConfirmSpec {
  kind: "write" | "edit" | "command";
  /** What's being approved — a target path (write/edit) or a command string. */
  path: string;
  /** Secondary line: byte count, char delta, cwd, or the escalation reason. */
  detail: string;
  /** Whether to offer the "always allow this action" option (default true). */
  allowAlways?: boolean;
  /** Whether to offer the session-wide bypass option (default true). */
  allowBypass?: boolean;
  /** Trusted approval scope; never supplied from model arguments. */
  authorityScope?: string;
}

export interface ConfirmRequest extends ConfirmSpec {
  id: string;
}

type Listener = (req: ConfirmRequest) => void;
type CancellationListener = (id: string) => void;

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  authorityScope?: string;
  allowBypass?: boolean;
}

let listener: Listener | null = null;
let cancellationListener: CancellationListener | null = null;
let bypassing = false;
const bypassScopes = new Set<string>();
/** Session command-prefix grants recorded by "always allow" decisions. */
export const commandGrants = new CommandGrants();
const pending = new Map<string, PendingApproval>();

function notifyCancellation(id: string): void {
  try {
    cancellationListener?.(id);
  } catch {
    // UI cleanup is best-effort; it must never keep an approval pending.
  }
}

/** Register (or clear, with null) the UI renderer for approval requests. */
export function setConfirmListener(next: Listener | null): void {
  listener = next;
}

/** Register the UI hook that removes an approval overlay cancelled by its owner. */
export function setConfirmCancellationListener(next: CancellationListener | null): void {
  cancellationListener = next;
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
export function requestApproval(spec: ConfirmSpec, signal?: AbortSignal): Promise<ApprovalDecision> {
  if (signal?.aborted) return Promise.resolve("deny");
  if (spec.allowBypass !== false && (spec.authorityScope ? bypassScopes.has(spec.authorityScope) : bypassing)) return Promise.resolve("allow");
  const activeListener = listener;
  if (!activeListener) return Promise.resolve("deny");
  const id = randomUUID();
  return new Promise<ApprovalDecision>((resolve) => {
    const entry: PendingApproval = {resolve, signal, authorityScope: spec.authorityScope, allowBypass: spec.allowBypass};
    if (signal) {
      entry.onAbort = () => {
        if (pending.get(id) !== entry) return;
        pending.delete(id);
        notifyCancellation(id);
        resolve("deny");
      };
      signal.addEventListener("abort", entry.onAbort, {once: true});
    }
    pending.set(id, entry);
    try {
      activeListener({ allowAlways: true, allowBypass: true, ...spec, id });
    } catch {
      // Rendering is part of the fail-closed boundary. A renderer may throw
      // after observing the id, so revoke that exact request before denying.
      if (pending.get(id) !== entry) return;
      pending.delete(id);
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
      notifyCancellation(id);
      resolve("deny");
    }
  });
}

/** The UI calls this when the user answers. No-op for unknown/stale ids. */
export function resolveApproval(id: string, decision: ApprovalDecision): void {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
  if (entry.signal?.aborted) { entry.resolve('deny'); return; }
  if (decision === "bypass" && entry.allowBypass === false) { entry.resolve('deny'); return; }
  if (decision === "bypass") {
    if (entry.authorityScope) bypassScopes.add(entry.authorityScope);
    else bypassing = true;
  }
  entry.resolve(decision);
}

/** Deny and clear every pending approval (e.g. on abort or teardown). */
export function rejectAllConfirms(): void {
  const revoked = [...pending.entries()];
  // Revoke every id before invoking any resolver or UI callback. A reentrant
  // cancellation listener must never be able to answer teardown state.
  pending.clear();
  for (const [, entry] of revoked) {
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
  }
  for (const [id, entry] of revoked) {
    entry.resolve("deny");
    notifyCancellation(id);
  }
}

export function pendingConfirmCount(): number {
  return pending.size;
}

/** Clear bypass mode (teardown / tests / an explicit "re-arm approvals"). */
export function resetBypass(): void {
  bypassing = false;
  bypassScopes.clear();
  commandGrants.clear();
}

// ── Boolean shims — the agent-harness write tools only care allow-vs-deny ────

/** Boolean view of `requestApproval` for callers that don't need the 4-way decision. */
export async function requestConfirm(spec: ConfirmSpec, context: ToolExecutionContext | undefined = currentExecutionContext()): Promise<boolean> {
  try { assertExecutionActive(context); } catch { return false; }
  if (context?.approval?.policy === 'deny') return false;
  // Tools declared `approval: "always"` are pinned non-bypassable: compute the
  // flag before the headless-allow shortcut so a noninteractive allow policy
  // can never auto-approve a required prompt.
  const always = context?.toolApproval === 'always';
  if (context?.approval?.policy === 'allow' && !always) return true;
  // An explicit host-authored scope wins over the session's, so a tool can pin
  // its own scope (e.g. a vault) that a session-wide bypass never covers,
  // regardless of the spec their handler passes.
  const authorityScope = spec.authorityScope ?? context?.approval?.scopeId ?? context?.sessionId;
  // "Always allow" for a command is a token-prefix grant on its argv. Only a
  // single simple command qualifies; compound, redirected or expanding
  // commands tokenize to null, are never granted, and prompt every time.
  const argv = spec.kind === 'command' ? tokenizeCommand(spec.path) : null;
  const grantable = !always && argv !== null && authorityScope !== undefined;
  if (grantable && commandGrants.matches(authorityScope, argv)) return true;
  const decision = await requestApproval({
    ...spec,
    ...(always ? { allowAlways: false, allowBypass: false } : spec.kind === 'command' && !grantable ? { allowAlways: false } : {}),
    authorityScope,
  }, context?.signal);
  try { assertExecutionActive(context); } catch { return false; }
  if (decision === 'always' && grantable) commandGrants.grant(authorityScope, argv);
  return decision !== 'deny';
}


/** Boolean view of `resolveApproval` (true → allow, false → deny). */
export function resolveConfirm(id: string, approved: boolean): void {
  resolveApproval(id, approved ? "allow" : "deny");
}

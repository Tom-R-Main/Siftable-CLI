/**
 * sessionContext — the active-session model for mergeMaster parent/child sessions.
 *
 * Lane C's core realization (see docs/architecture/mergemaster-session-and-git-model.md)
 * is that "enter a child" is not one switch but several that must move together:
 * the session cwd, the model thread, the agent instance, AND the visible
 * transcript. If any one lags behind, a child's turns leak into the parent's
 * conversation and the "full interactive child thread" promise breaks.
 *
 * This module owns the two facets that are pure data — the **active session
 * pointer** and a **per-session transcript buffer** — plus the cwd swap, and
 * exposes `enter`/`leave` as the single place those move in lockstep. It is
 * deliberately free of any TUI (Solid), Codex, or OpenFunction coupling: the
 * engines key their own per-session state (threads / agent instances) off the
 * same `conversationKey` this module switches on, but they import nothing from
 * here. That keeps the foundation unit-testable without a renderer or a model.
 *
 * The transcript buffer is generic over the message type `M` so the TUI can
 * instantiate it with its own `Msg` shape without this module depending on it.
 *
 * Switches form a stack so nested enter/leave (parent → child A → child B) each
 * restore the *exact* cwd/workspace-root that was active when they entered,
 * rather than re-deriving it — see {@link restoreSessionCwd}.
 */
import {
  getSessionCwd,
  restoreSessionCwd,
  setSessionCwd,
  type SessionCwdChange,
} from "./navigation";

/** A session this context can make active. Mirrors the durable fields of a
 *  {@link MergeMasterSession} the switch actually needs. */
export interface ManagedSession {
  /** Process-local stable handle (the mergeMaster `sessionId`). */
  sessionId: number;
  /** Durable conversation identity — the transcript-buffer key, stable across
   *  enter/leave so re-entering a session restores its prior messages. */
  conversationKey: string;
  /** Where the cwd points while this session is active: the worktree for a
   *  child, the primary working tree for the parent. */
  sessionCwd: string;
}

/** The result of an `enter`/`leave`: the now-active session, its transcript
 *  buffer (live array reference), and the resolved cwd. */
export interface SessionSwitch<M> {
  session: ManagedSession;
  transcript: M[];
  cwd: string;
}

interface Frame {
  session: ManagedSession;
  /** cwd change applied when this frame was entered; absent for the root frame
   *  (there is nothing beneath the root to restore to). */
  applied?: SessionCwdChange;
}

export interface SessionContext<M> {
  /** The session at the top of the switch stack. */
  active(): ManagedSession;
  activeSessionId(): number;
  activeConversationKey(): string;
  /** Stack depth — 1 means only the root is active. */
  depth(): number;
  isRoot(): boolean;
  /** Live transcript buffer for the active session. */
  transcript(): M[];
  /** Live transcript buffer for any known session (empty if never seen). */
  transcriptFor(conversationKey: string): M[];
  /** Append one message to the active session's buffer. */
  append(message: M): void;
  /** Replace the active session's buffer contents in place (sync from a store). */
  replaceTranscript(messages: M[]): void;
  /** Make `session` active: swap cwd + transcript, push a switch frame. */
  enter(session: ManagedSession): SessionSwitch<M>;
  /** Pop back to the previous session, restoring its exact cwd. Null at root. */
  leave(): SessionSwitch<M> | null;
}

/**
 * Build a session context anchored at `root` (the parent session). The root's
 * cwd is taken to be whatever is already active — constructing the context does
 * not move the cwd — so `root.sessionCwd` is recorded for reference but not
 * applied. `leave()` from the root is a no-op returning null.
 */
export function createSessionContext<M>(root: ManagedSession): SessionContext<M> {
  const buffers = new Map<string, M[]>();
  const stack: Frame[] = [{ session: root }];
  bufferFor(root.conversationKey);

  function bufferFor(conversationKey: string): M[] {
    let buf = buffers.get(conversationKey);
    if (!buf) {
      buf = [];
      buffers.set(conversationKey, buf);
    }
    return buf;
  }

  function top(): Frame {
    return stack[stack.length - 1];
  }

  return {
    active: () => top().session,
    activeSessionId: () => top().session.sessionId,
    activeConversationKey: () => top().session.conversationKey,
    depth: () => stack.length,
    isRoot: () => stack.length === 1,
    transcript: () => bufferFor(top().session.conversationKey),
    transcriptFor: (conversationKey) => bufferFor(conversationKey),
    append: (message) => {
      bufferFor(top().session.conversationKey).push(message);
    },
    replaceTranscript: (messages) => {
      const buf = bufferFor(top().session.conversationKey);
      buf.splice(0, buf.length, ...messages);
    },
    enter: (session) => {
      const applied = setSessionCwd(session.sessionCwd);
      stack.push({ session, applied });
      return {
        session,
        transcript: bufferFor(session.conversationKey),
        cwd: getSessionCwd(),
      };
    },
    leave: () => {
      if (stack.length <= 1) return null;
      const frame = stack.pop()!;
      // Restore the *exact* cwd/workspace-root captured when we entered, not a
      // re-derivation — guarantees a clean round-trip through nested switches.
      if (frame.applied) {
        restoreSessionCwd(frame.applied);
      }
      const now = top().session;
      return {
        session: now,
        transcript: bufferFor(now.conversationKey),
        cwd: getSessionCwd(),
      };
    },
  };
}

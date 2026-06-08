/**
 * childSessionController — Lane C orchestration that turns "spawn a child" into
 * the right sequence over lanes A/B and the mergeMaster registry.
 *
 * The ordering is the load-bearing decision: **Gate-A admission is evaluated
 * BEFORE any Git is touched.** Gate A needs only the access mode and write
 * scope, so a blocked child must never create (and then tear down) a worktree —
 * the common "serialized behind a running sibling" path does zero filesystem
 * work. A worktree is created only after admission; the only place we remove one
 * is a genuine *post-creation* failure (the registry rejected the session, or a
 * later step threw), so we never strand a checkout with no session attached.
 *
 * Everything external is injectable (`deps`) so the sequencing — and especially
 * the cleanup branch — is unit-testable on a real temp Git repo without a TUI.
 */
import {homedir} from "node:os";
import {join} from "node:path";
import {getSessionCwd} from "./navigation";
import {
  createChildWorktree,
  removeChildWorktree,
  resolveRepoRoot,
  createGitRunner,
  squashMergeChild,
  rebaseChildOntoBase,
  WorktreeError,
  type GitRunner,
} from "./worktreeService";
import {appendTurn, rolloutPathForThread, persistEnabled} from "./openfunction/framework/rollout";
import {assembleParentMergeView, type MergeReadinessRow, type ParentMergeView} from "./mergeView";
import {
  conversationKeyForSession,
  createGatedChildSession,
  createParentSession,
  evaluateChildAdmission,
  getMergeMasterSession,
  isTerminalStatus,
  setSessionHeadCommit,
  transitionSessionStatus,
  type CreateChildInput,
  type CreateParentInput,
  type GatedChildResult,
  type MergeMasterAccessMode,
  type MergeMasterStatus,
} from "./mergeMaster";
import {commitChild as gitCommitChild, evaluateMerge, type MergePacket} from "./mergeGate";
import {isWorktreeDirty} from "./worktreeService";

/** A child session this controller created and tracks for enter/list/remove. */
export interface ChildSessionRecord {
  sessionId: number;
  parentSessionId: number;
  title: string;
  repoRoot: string;
  branch: string;
  baseBranch: string;
  /** The child's linked worktree — also its sessionCwd. */
  worktreePath: string;
  sessionCwd: string;
  baseCommit: string;
  headCommit: string;
  accessMode: MergeMasterAccessMode;
  writeScope: string[];
  conversationKey: string;
}

/** A record enriched with the child's live registry status, for the agent bar. */
export interface ChildSessionView extends ChildSessionRecord {
  status: MergeMasterStatus | "unknown";
}

export interface SpawnChildInput {
  title: string;
  accessMode: MergeMasterAccessMode;
  /** Files/resources a read_write child intends to write (Gate-A scope). */
  writeScope?: string[];
  /** Branch the child forks from; defaults to the repo's current branch. */
  baseBranch?: string;
  /** Flavors the generated branch slug; defaults to the title. */
  focus?: string;
  /** Where to resolve the repo from; defaults to the active session cwd. */
  cwd?: string;
}

export type SpawnChildResult =
  | {ok: true; session: ChildSessionRecord}
  | {ok: false; reason: string; blockedBy?: number; sharedScope?: string[]};

export interface ChildSessionControllerDeps {
  /** Git command runner — inject a spy to observe (or a fake to drive) git. */
  runner?: GitRunner;
  /** Root holding sift-managed worktrees; defaults to ~/.siftable/worktrees. */
  worktreesRoot?: string;
  /** Registry seam — defaults to the real gated spawn. */
  registerSession?: (input: CreateChildInput) => GatedChildResult;
  /** Parent-creation seam — defaults to the real registry call. */
  createParent?: (input: CreateParentInput) => number;
  /** Clock for registry timestamps (kept deterministic in tests). */
  now?: () => number;
  /**
   * Post a parent instruction into a child's conversation thread (lane F
   * send-back). Defaults to appending a user-role turn to the child's rollout;
   * inject a spy in tests. Returns true when the message was persisted.
   */
  postToThread?: (conversationKey: string, instruction: string) => boolean;
}

/** Options for {@link ChildSessionController.reviewChild}. */
export interface ReviewChildOptions {
  /** Stage + commit the child's working changes first (default off). */
  autoCommit?: boolean;
  /** Commit message used when `autoCommit` commits. */
  message?: string;
}

/** Outcome of running the lane-D gate on a child. */
export type ReviewChildResult =
  | {
      ok: true;
      /** The merge packet (diff stat, conflicts, scope, verdict, blockers). */
      packet: MergePacket;
      /** True if the gate's verdict was applied to the child's status. */
      statusApplied: boolean;
      /** True if `autoCommit` produced a new commit. */
      committed: boolean;
      /** Set when the verdict could not be applied (e.g. illegal transition). */
      note?: string;
    }
  | {ok: false; reason: string};

/** Options for {@link ChildSessionController.mergeChild}. */
export interface MergeChildOptions {
  /** Keep the child worktree + branch after a successful merge (default: remove). */
  keep?: boolean;
  /** Override the squash commit message. */
  message?: string;
}

/** Outcome of landing a child onto the base (lane E). */
export type MergeChildResult =
  | {
      ok: true;
      /** True when a squash commit was created; false when already up-to-date. */
      merged: boolean;
      /** The gate packet that authorized the merge. */
      packet: MergePacket;
      /** Base tip after the landing. */
      baseCommit: string;
      /** True when the child worktree + branch were removed. */
      cleaned: boolean;
      /** Extra context (already-up-to-date, cleanup skipped/failed, …). */
      note?: string;
    }
  | {ok: false; reason: string; packet?: MergePacket};

/** Outcome of rebasing a child onto the moved base (lane F). */
export type RebaseChildResult =
  | {
      ok: true;
      /** True if commits were replayed (false when already up to date). */
      rebased: boolean;
      /** The child branch tip after the rebase. */
      headCommit: string;
      /** The gate verdict re-evaluated after a clean rebase. */
      verdict: MergePacket["verdict"];
      /** True if the re-evaluated verdict was applied to the child's status. */
      statusApplied: boolean;
    }
  | {ok: false; reason: string; conflicts?: string[]};

/** Outcome of sending a child back to work with instructions (lane F). */
export type SendBackChildResult =
  | {ok: true; posted: boolean; conversationKey: string}
  | {ok: false; reason: string};

export interface ChildSessionController {
  spawnChild(input: SpawnChildInput): SpawnChildResult;
  listChildSessions(): ChildSessionView[];
  getChild(sessionId: number): ChildSessionRecord | undefined;
  /** Run the ready-to-merge gate (lane D) and set ready_to_merge / merge_blocked. */
  reviewChild(sessionId: number, opts?: ReviewChildOptions): ReviewChildResult;
  /** Stage + commit a child's working changes (no gate). Returns the new tip. */
  commitChild(sessionId: number, message?: string): {ok: boolean; committed?: boolean; headCommit?: string; reason?: string};
  /** Read-only dashboard: every child's mergeability as the parent sees it. */
  listMergeReadiness(): ParentMergeView;
  /** Land a ready child onto the base via squash-merge (lane E). */
  mergeChild(sessionId: number, opts?: MergeChildOptions): MergeChildResult;
  /** Replay a (usually blocked) child onto the moved base; re-gate on success (lane F). */
  rebaseChild(sessionId: number): RebaseChildResult;
  /** Resume a reviewed child, posting the parent's instructions into its thread (lane F). */
  sendBackChild(sessionId: number, instruction: string): SendBackChildResult;
  /** Reject a reviewed child: terminal, but keep its worktree + branch inspectable (lane F). */
  rejectChild(sessionId: number, reason?: string): {ok: boolean; reason?: string};
  removeChild(
    sessionId: number,
    opts?: {deleteBranch?: boolean; force?: boolean},
  ): {ok: boolean; reason?: string};
}

export function createChildSessionController(
  deps: ChildSessionControllerDeps = {},
): ChildSessionController {
  const runner = deps.runner ?? createGitRunner();
  const worktreesRoot = deps.worktreesRoot ?? join(homedir(), ".siftable", "worktrees");
  const registerSession = deps.registerSession ?? createGatedChildSession;
  const createParent = deps.createParent ?? createParentSession;
  const now = deps.now ?? (() => 0);
  const postToThread =
    deps.postToThread ??
    ((conversationKey: string, instruction: string): boolean => {
      // Append the parent's instruction as a user-role turn so the child agent
      // picks it up on resume. Skipped if rollout persistence is off / unavailable.
      if (!persistEnabled()) return false;
      try {
        appendTurn(rolloutPathForThread(conversationKey), instruction, null);
        return true;
      } catch {
        return false;
      }
    });

  const records = new Map<number, ChildSessionRecord>();
  const parents = new Map<string, number>(); // repoRoot → parent sessionId
  let seedCounter = 0;

  function currentBranch(repoRoot: string): string {
    const res = runner(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
    const branch = res.status === 0 ? res.stdout.trim() : "";
    return branch && branch !== "HEAD" ? branch : "main";
  }

  function ensureParent(repoRoot: string, branch: string, sessionCwd: string): number {
    const existing = parents.get(repoRoot);
    if (existing) return existing;
    const head = runner(["rev-parse", "HEAD"], repoRoot);
    const id = createParent({
      repoRoot,
      launchDir: repoRoot,
      sessionCwd,
      branch,
      headCommit: head.status === 0 ? head.stdout.trim() : undefined,
      conversationKey: conversationKeyForSession({repoRoot, role: "parent", branch, seed: ""}),
      nowMs: now(),
    });
    parents.set(repoRoot, id);
    return id;
  }

  function cleanupWorktree(repoRoot: string, worktreePath: string): void {
    // Best-effort: we are already on a failure path; force past a dirty tree and
    // drop the branch so a retry with the same seed isn't blocked by leftovers.
    try {
      removeChildWorktree({repoRoot, worktreePath, deleteBranch: true, force: true}, runner);
    } catch {
      /* nothing else we can do here — the caller surfaces the original failure */
    }
  }

  function spawnChild(input: SpawnChildInput): SpawnChildResult {
    // 1. Gate-A preflight — needs only access mode + scope, so do it before Git.
    const admission = evaluateChildAdmission({
      accessMode: input.accessMode,
      writeScope: input.writeScope,
    });
    if (!admission.admit) {
      return {
        ok: false,
        reason: admission.reason,
        blockedBy: admission.conflictSessionId,
        sharedScope: admission.sharedScope,
      };
    }

    // 2. Resolve repo/base/parent (still no mutation of the tree).
    const startCwd = input.cwd ?? getSessionCwd();
    const repoRoot = resolveRepoRoot(startCwd, runner);
    const baseBranch = input.baseBranch ?? currentBranch(repoRoot);
    const parentSessionId = ensureParent(repoRoot, baseBranch, startCwd);

    // 3. Create the worktree. Past this point, any failure must clean it up.
    const seed = `${input.title}#${++seedCounter}`;
    const wt = createChildWorktree(
      {repoRoot, baseBranch, seed, focus: input.focus ?? input.title, layout: {worktreesRoot}},
      runner,
    );
    try {
      const conversationKey = conversationKeyForSession({
        repoRoot,
        role: "child",
        branch: wt.branch,
        seed,
      });
      const gated = registerSession({
        parentSessionId,
        accessMode: input.accessMode,
        branch: wt.branch,
        worktreePath: wt.worktreePath,
        sessionCwd: wt.worktreePath,
        baseBranch: wt.baseBranch,
        baseCommit: wt.baseCommit,
        headCommit: wt.headCommit,
        writeScope: input.writeScope,
        conversationKey,
        nowMs: now(),
      });
      if (!gated.admitted) {
        cleanupWorktree(repoRoot, wt.worktreePath);
        return {ok: false, reason: gated.admission.reason};
      }
      const record: ChildSessionRecord = {
        sessionId: gated.sessionId,
        parentSessionId,
        title: input.title,
        repoRoot,
        branch: wt.branch,
        baseBranch: wt.baseBranch,
        worktreePath: wt.worktreePath,
        sessionCwd: wt.worktreePath,
        baseCommit: wt.baseCommit,
        headCommit: wt.headCommit,
        accessMode: input.accessMode,
        writeScope: input.writeScope ?? [],
        conversationKey,
      };
      records.set(record.sessionId, record);
      return {ok: true, session: record};
    } catch (err) {
      cleanupWorktree(repoRoot, wt.worktreePath);
      throw err;
    }
  }

  function listChildSessions(): ChildSessionView[] {
    return [...records.values()].map((r) => ({
      ...r,
      status: getMergeMasterSession(r.sessionId)?.status ?? "unknown",
    }));
  }

  function commitChild(
    sessionId: number,
    message?: string,
  ): {ok: boolean; committed?: boolean; headCommit?: string; reason?: string} {
    const rec = records.get(sessionId);
    if (!rec) return {ok: false, reason: "unknown child session"};
    try {
      const res = gitCommitChild(rec, message ?? `sift: child #${sessionId} work`, runner);
      // Keep the registry's recorded tip in sync with the branch's real tip.
      if (res.committed) setSessionHeadCommit(sessionId, res.headCommit, now());
      return {ok: true, committed: res.committed, headCommit: res.headCommit};
    } catch (err) {
      return {ok: false, reason: err instanceof Error ? err.message : String(err)};
    }
  }

  function reviewChild(sessionId: number, opts: ReviewChildOptions = {}): ReviewChildResult {
    const rec = records.get(sessionId);
    if (!rec) return {ok: false, reason: "unknown child session"};
    const live = getMergeMasterSession(sessionId);
    if (live && isTerminalStatus(live.status)) {
      return {ok: false, reason: `child #${sessionId} is ${live.status} (terminal) — nothing to review`};
    }

    let committed = false;
    try {
      if (opts.autoCommit && isWorktreeDirty(rec.worktreePath, runner)) {
        const c = gitCommitChild(rec, opts.message ?? `sift: child #${sessionId} work`, runner);
        committed = c.committed;
        if (c.committed) setSessionHeadCommit(sessionId, c.headCommit, now());
      }
      const packet = evaluateMerge(rec, runner);
      // The gate read the live branch tip; mirror it into the registry so the
      // merge view (lane E) and any reader sees the same headCommit we judged.
      setSessionHeadCommit(sessionId, packet.headCommit, now());
      const code = transitionSessionStatus(sessionId, packet.verdict, now());
      const statusApplied = code === 0;
      return {
        ok: true,
        packet,
        statusApplied,
        committed,
        note: statusApplied
          ? undefined
          : `verdict ${packet.verdict} not applied from status ${live?.status ?? "unknown"} (code ${code})`,
      };
    } catch (err) {
      return {ok: false, reason: err instanceof Error ? err.message : String(err)};
    }
  }

  function listMergeReadiness(): ParentMergeView {
    const rows: MergeReadinessRow[] = [];
    for (const rec of records.values()) {
      const live = getMergeMasterSession(rec.sessionId);
      const status = live?.status ?? "unknown";
      // Terminal children and read-only children have nothing to land → null verdict.
      if ((live && isTerminalStatus(live.status)) || rec.accessMode === "read_only") {
        rows.push({
          sessionId: rec.sessionId,
          branch: rec.branch,
          baseBranch: rec.baseBranch,
          status,
          verdict: null,
          files: 0,
          additions: 0,
          deletions: 0,
          behindBy: 0,
          blockers: [],
        });
        continue;
      }
      try {
        const packet = evaluateMerge(rec, runner);
        rows.push({
          sessionId: rec.sessionId,
          branch: rec.branch,
          baseBranch: rec.baseBranch,
          status,
          verdict: packet.verdict,
          files: packet.files.length,
          additions: packet.totalAdditions,
          deletions: packet.totalDeletions,
          behindBy: packet.behindBy,
          blockers: packet.blockers,
        });
      } catch (err) {
        rows.push({
          sessionId: rec.sessionId,
          branch: rec.branch,
          baseBranch: rec.baseBranch,
          status,
          verdict: null,
          files: 0,
          additions: 0,
          deletions: 0,
          behindBy: 0,
          blockers: [err instanceof Error ? err.message : String(err)],
        });
      }
    }
    return assembleParentMergeView(rows);
  }

  function mergeChild(sessionId: number, opts: MergeChildOptions = {}): MergeChildResult {
    const rec = records.get(sessionId);
    if (!rec) return {ok: false, reason: "unknown child session"};
    const live = getMergeMasterSession(sessionId);
    if (live && isTerminalStatus(live.status)) {
      return {ok: false, reason: `child #${sessionId} is ${live.status} (terminal) — nothing to merge`};
    }

    // Re-gate at merge time: the base may have moved since /ready. The gate sets
    // the child's status; we only land when both the verdict AND the registry agree.
    let packet: MergePacket;
    try {
      packet = evaluateMerge(rec, runner);
    } catch (err) {
      return {ok: false, reason: err instanceof Error ? err.message : String(err)};
    }
    setSessionHeadCommit(sessionId, packet.headCommit, now());
    const code = transitionSessionStatus(sessionId, packet.verdict, now());
    if (packet.verdict !== "ready_to_merge") {
      return {ok: false, reason: `merge blocked: ${packet.blockers.join("; ") || "not ready"}`, packet};
    }
    if (code !== 0) {
      // Verdict is clean, but the registry refused it (e.g. child is needs_input).
      return {
        ok: false,
        reason: `child #${sessionId} is ${live?.status ?? "unknown"} — resume it (set running) before merging`,
        packet,
      };
    }

    // Land it. squashMergeChild is fully self-rolling-back on any failure.
    let result;
    try {
      result = squashMergeChild(
        {
          repoRoot: rec.repoRoot,
          parentWorktreePath: rec.repoRoot,
          baseBranch: rec.baseBranch,
          childBranch: rec.branch,
          message: opts.message ?? `sift: merge child #${sessionId} (${rec.branch}) — ${rec.title}`,
        },
        runner,
      );
    } catch (err) {
      // A conflict that surfaced between the gate and the merge → fall back to blocked.
      if (err instanceof WorktreeError && err.kind === "merge_conflict") {
        transitionSessionStatus(sessionId, "merge_blocked", now());
      }
      return {ok: false, reason: err instanceof Error ? err.message : String(err), packet};
    }

    // The work is on the base now → terminal merged; free its Gate-A scope.
    transitionSessionStatus(sessionId, "merged", now());
    // Keep the parent's recorded tip in step with the advanced base.
    setSessionHeadCommit(rec.parentSessionId, result.baseCommitAfter, now());

    let cleaned = false;
    let note = result.alreadyUpToDate ? "child had no net changes (already up-to-date)" : undefined;
    if (!opts.keep) {
      // Force-delete the branch: squash doesn't mark it merged, so `-d` would
      // refuse — but the work is provably preserved in the base squash commit.
      const removal = removeChild_internal(rec, {deleteBranch: true, forceBranchDelete: true});
      cleaned = removal.ok;
      // Drop the record only once its worktree is actually gone; on a cleanup
      // failure (or with --keep) the merged child stays listed for follow-up.
      if (removal.ok) records.delete(sessionId);
      else note = `merged, but cleanup failed: ${removal.reason}`;
    }
    return {ok: true, merged: result.merged, packet, baseCommit: result.baseCommitAfter, cleaned, note};
  }

  function rebaseChild(sessionId: number): RebaseChildResult {
    const rec = records.get(sessionId);
    if (!rec) return {ok: false, reason: "unknown child session"};
    const live = getMergeMasterSession(sessionId);
    if (live && isTerminalStatus(live.status)) {
      return {ok: false, reason: `child #${sessionId} is ${live.status} (terminal) — nothing to rebase`};
    }

    let rebased: boolean;
    let headCommitAfter: string;
    try {
      const res = rebaseChildOntoBase(
        {worktreePath: rec.worktreePath, childBranch: rec.branch, baseBranch: rec.baseBranch},
        runner,
      );
      rebased = res.rebased;
      headCommitAfter = res.headCommitAfter;
    } catch (err) {
      // A conflict left the child untouched (rebase --abort); mark it blocked so
      // the parent knows it needs a send-back, and surface the conflicted paths.
      if (err instanceof WorktreeError && err.kind === "merge_conflict") {
        transitionSessionStatus(sessionId, "merge_blocked", now());
        return {ok: false, reason: err.message, conflicts: err.paths ?? []};
      }
      return {ok: false, reason: err instanceof Error ? err.message : String(err)};
    }

    setSessionHeadCommit(sessionId, headCommitAfter, now());
    // Re-gate against the (now-current) base; a clean rebase usually flips
    // merge_blocked → ready_to_merge.
    try {
      const packet = evaluateMerge(rec, runner);
      setSessionHeadCommit(sessionId, packet.headCommit, now());
      const code = transitionSessionStatus(sessionId, packet.verdict, now());
      return {ok: true, rebased, headCommit: packet.headCommit, verdict: packet.verdict, statusApplied: code === 0};
    } catch (err) {
      return {ok: false, reason: err instanceof Error ? err.message : String(err)};
    }
  }

  function sendBackChild(sessionId: number, instruction: string): SendBackChildResult {
    const rec = records.get(sessionId);
    if (!rec) return {ok: false, reason: "unknown child session"};
    const live = getMergeMasterSession(sessionId);
    if (!live) return {ok: false, reason: `child #${sessionId} not in registry`};
    if (isTerminalStatus(live.status)) {
      return {ok: false, reason: `child #${sessionId} is ${live.status} (terminal) — cannot send back`};
    }
    if (live.status === "running") {
      // Already working — there's nothing to "send back". (The backend treats a
      // running→running set as an idempotent no-op, so guard it here explicitly.)
      return {ok: false, reason: `child #${sessionId} is already running — nothing to send back`};
    }
    // Resume the work first; only post once the transition is legal.
    const code = transitionSessionStatus(sessionId, "running", now());
    if (code !== 0) {
      return {ok: false, reason: `cannot resume child #${sessionId} from ${live.status}`};
    }
    const text = instruction.trim();
    const posted = text ? postToThread(rec.conversationKey, text) : false;
    return {ok: true, posted, conversationKey: rec.conversationKey};
  }

  function rejectChild(sessionId: number, _reason?: string): {ok: boolean; reason?: string} {
    const rec = records.get(sessionId);
    if (!rec) return {ok: false, reason: "unknown child session"};
    const live = getMergeMasterSession(sessionId);
    if (live && isTerminalStatus(live.status)) {
      return {ok: false, reason: `child #${sessionId} is ${live.status} (terminal)`};
    }
    const code = transitionSessionStatus(sessionId, "rejected", now());
    if (code !== 0) {
      return {
        ok: false,
        reason: `cannot reject child #${sessionId} from ${live?.status ?? "unknown"} — review it first (only a ready/blocked child can be rejected)`,
      };
    }
    // Deliberately leave the worktree + branch on disk: rejected is terminal but
    // inspectable. The record stays tracked so it still shows in the merge view.
    return {ok: true};
  }

  /** Internal worktree teardown that does not touch registry status (merge already did). */
  function removeChild_internal(
    rec: ChildSessionRecord,
    opts: {deleteBranch?: boolean; force?: boolean; forceBranchDelete?: boolean},
  ): {ok: boolean; reason?: string} {
    try {
      removeChildWorktree(
        {
          repoRoot: rec.repoRoot,
          worktreePath: rec.worktreePath,
          deleteBranch: opts.deleteBranch ?? true,
          force: opts.force ?? false,
          forceBranchDelete: opts.forceBranchDelete ?? false,
        },
        runner,
      );
      return {ok: true};
    } catch (err) {
      return {ok: false, reason: err instanceof Error ? err.message : String(err)};
    }
  }

  function removeChild(
    sessionId: number,
    opts?: {deleteBranch?: boolean; force?: boolean},
  ): {ok: boolean; reason?: string} {
    const rec = records.get(sessionId);
    if (!rec) return {ok: false, reason: "unknown child session"};
    // Free the child's Gate-A scope so coupled work can be admitted again.
    const live = getMergeMasterSession(sessionId);
    if (live && !isTerminalStatus(live.status)) {
      transitionSessionStatus(sessionId, "abandoned", now());
    }
    try {
      removeChildWorktree(
        {
          repoRoot: rec.repoRoot,
          worktreePath: rec.worktreePath,
          deleteBranch: opts?.deleteBranch ?? true,
          force: opts?.force ?? false,
        },
        runner,
      );
    } catch (err) {
      return {ok: false, reason: err instanceof Error ? err.message : String(err)};
    }
    records.delete(sessionId);
    return {ok: true};
  }

  return {
    spawnChild,
    listChildSessions,
    getChild: (sessionId) => records.get(sessionId),
    reviewChild,
    commitChild,
    listMergeReadiness,
    mergeChild,
    rebaseChild,
    sendBackChild,
    rejectChild,
    removeChild,
  };
}

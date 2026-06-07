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
  type GitRunner,
} from "./worktreeService";
import {
  conversationKeyForSession,
  createGatedChildSession,
  createParentSession,
  evaluateChildAdmission,
  getMergeMasterSession,
  isTerminalStatus,
  transitionSessionStatus,
  type CreateChildInput,
  type CreateParentInput,
  type GatedChildResult,
  type MergeMasterAccessMode,
  type MergeMasterStatus,
} from "./mergeMaster";

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
}

export interface ChildSessionController {
  spawnChild(input: SpawnChildInput): SpawnChildResult;
  listChildSessions(): ChildSessionView[];
  getChild(sessionId: number): ChildSessionRecord | undefined;
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
    removeChild,
  };
}

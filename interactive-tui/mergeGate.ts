/**
 * mergeGate — lane D: the ready-to-merge gate and its "merge packet".
 *
 * A child session is "a branch with a conversation"; before the parent can land
 * it (lane E), the work must pass this gate. The gate answers, **read-only**,
 * one question: *what would merging this child onto the CURRENT base produce?*
 * and turns the answer into a verdict — `ready_to_merge` or `merge_blocked` —
 * plus a packet of the concrete facts behind it (diff stat, predicted conflicts,
 * out-of-scope writes, base drift). It evaluates against the live base tip, not
 * the stale fork commit, because the base branch may have moved since the child
 * forked.
 *
 * Split by purity so each half is independently testable:
 *  - {@link assembleMergePacket} is pure: given git facts + the child's scope, it
 *    computes the verdict and blockers. No git, no kernel.
 *  - {@link evaluateMerge} gathers those facts with the read-only lane-D git
 *    helpers (it never checks out, stages, commits, or merges).
 *  - {@link commitChild} is the one *mutating* helper, kept here so the
 *    interactive "edit then /ready" flow works: it stages and commits inside the
 *    child's own worktree (never the parent's).
 *
 * The status transition itself stays with the registry kernel; the controller
 * calls {@link assembleMergePacket}/{@link evaluateMerge} and then
 * `transitionSessionStatus`. The kernel is never taught about git. (See
 * docs/architecture/mergemaster-session-and-git-model.md.)
 */
import {filesOutsideScope} from "./planning/scope";
import type {MergeMasterAccessMode, MergeMasterStatus} from "./mergeMaster";
import {
  countCommits,
  diffNumstat,
  isWorktreeDirty,
  mergeBase,
  predictMergeConflicts,
  resolveCommit,
  worktreeStatus,
  WorktreeError,
  createGitRunner,
  type DiffFile,
  type GitRunner,
} from "./worktreeService";

/** The verdicts this gate can issue. A subset of {@link MergeMasterStatus}. */
export type MergeVerdict = Extract<MergeMasterStatus, "ready_to_merge" | "merge_blocked">;

/** The minimal child description the gate needs — a {@link ChildSessionRecord} satisfies it. */
export interface MergeGateChild {
  sessionId: number;
  parentSessionId: number;
  repoRoot: string;
  branch: string;
  baseBranch: string;
  /** Commit the child forked from (fallback merge-base anchor). */
  baseCommit: string;
  worktreePath: string;
  accessMode: MergeMasterAccessMode;
  /** Declared write scope; empty means unscoped (`--rw-any`), exempt from the scope check. */
  writeScope: string[];
}

/** Pure inputs to {@link assembleMergePacket}: the child plus gathered git facts. */
export interface MergeGateInputs {
  child: MergeGateChild;
  /** Current tip of the base branch (what the merge is evaluated against). */
  baseTip: string;
  /** Current tip of the child's branch — what would merge. */
  headCommit: string;
  /** Commits the base advanced since the fork point. */
  behindBy: number;
  /** Per-file diff of the child's net changes (mergeBase..head). */
  changedFiles: DiffFile[];
  /** Paths git predicts would conflict (empty when clean). */
  conflicts: string[];
  /** Child worktree has uncommitted changes (nothing to merge until committed). */
  dirty: boolean;
}

/** The artifact the gate produces — rendered by lane E, drives the verdict. */
export interface MergePacket {
  childSessionId: number;
  parentSessionId: number;
  baseBranch: string;
  childBranch: string;
  baseCommit: string;
  baseTip: string;
  behindBy: number;
  headCommit: string;
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  conflicts: string[];
  /** Changed files outside the declared scope (empty when in-scope or unscoped). */
  outOfScope: string[];
  dirty: boolean;
  verdict: MergeVerdict;
  /** Human-readable reasons, present iff verdict is `merge_blocked`. */
  blockers: string[];
}

/**
 * Pure verdict computation. A child is `ready_to_merge` only when it is
 * committed, free of predicted conflicts against the current base, and stayed
 * within its declared scope; otherwise `merge_blocked` with one blocker line per
 * failed condition. Unscoped children (`--rw-any`, empty scope) skip the scope
 * check — they explicitly opted out of the serialization contract at spawn.
 */
export function assembleMergePacket(inputs: MergeGateInputs): MergePacket {
  const {child} = inputs;
  const changedPaths = inputs.changedFiles.map((f) => f.path);
  const outOfScope = filesOutsideScope(changedPaths, child.writeScope);

  const blockers: string[] = [];
  if (inputs.dirty) {
    blockers.push("child worktree has uncommitted changes — commit (or /ready commits for you) before merging");
  }
  if (inputs.conflicts.length > 0) {
    blockers.push(`conflicts with ${child.baseBranch} in: ${inputs.conflicts.join(", ")}`);
  }
  if (outOfScope.length > 0) {
    blockers.push(`wrote outside declared scope (${child.writeScope.join(", ")}): ${outOfScope.join(", ")}`);
  }

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const f of inputs.changedFiles) {
    totalAdditions += f.additions ?? 0;
    totalDeletions += f.deletions ?? 0;
  }

  return {
    childSessionId: child.sessionId,
    parentSessionId: child.parentSessionId,
    baseBranch: child.baseBranch,
    childBranch: child.branch,
    baseCommit: child.baseCommit,
    baseTip: inputs.baseTip,
    behindBy: inputs.behindBy,
    headCommit: inputs.headCommit,
    files: inputs.changedFiles,
    totalAdditions,
    totalDeletions,
    conflicts: inputs.conflicts,
    outOfScope,
    dirty: inputs.dirty,
    verdict: blockers.length > 0 ? "merge_blocked" : "ready_to_merge",
    blockers,
  };
}

/**
 * Gather git facts for a child and assemble its merge packet — fully read-only.
 * Reads the LIVE branch tips (the child may have committed since it was spawned)
 * and predicts the merge against the current base tip, not the fork commit.
 */
export function evaluateMerge(child: MergeGateChild, runner: GitRunner = createGitRunner()): MergePacket {
  const dirty = isWorktreeDirty(child.worktreePath, runner);
  // Live tips: read the child branch and base branch as they are right now.
  const headCommit = resolveCommit(child.repoRoot, child.branch, runner) ?? child.baseCommit;
  const baseTip = resolveCommit(child.repoRoot, child.baseBranch, runner) ?? child.baseCommit;
  // Fork point against the current base tip; fall back to the recorded baseCommit.
  const forkPoint = mergeBase(child.repoRoot, baseTip, headCommit, runner) ?? child.baseCommit;
  const behindBy = countCommits(child.repoRoot, `${forkPoint}..${baseTip}`, runner);
  const changedFiles = diffNumstat(child.repoRoot, forkPoint, headCommit, runner);
  const {conflicts} = predictMergeConflicts(child.repoRoot, baseTip, headCommit, runner);

  return assembleMergePacket({child, baseTip, headCommit, behindBy, changedFiles, conflicts, dirty});
}

/** Result of {@link commitChild}. */
export interface CommitChildResult {
  /** True if a commit was made; false when there was nothing to commit. */
  committed: boolean;
  /** New branch tip after the commit (or the unchanged tip when nothing changed). */
  headCommit: string;
}

/**
 * Stage everything in the child's worktree and commit it, so an interactive
 * child's edits become a mergeable commit. Operates only inside the child's own
 * linked worktree (never the parent's). A no-op when the tree is already clean.
 */
export function commitChild(
  child: MergeGateChild,
  message: string,
  runner: GitRunner = createGitRunner(),
): CommitChildResult {
  const headBefore = resolveCommit(child.repoRoot, child.branch, runner) ?? child.baseCommit;
  if (!isWorktreeDirty(child.worktreePath, runner)) {
    return {committed: false, headCommit: headBefore};
  }
  const add = runner(["add", "-A"], child.worktreePath);
  if (add.status !== 0) {
    throw new WorktreeError("git_failed", `git add -A failed: ${add.stderr || add.spawnError || `exit ${add.status}`}`);
  }
  // Re-check: `add -A` of only-ignored files can leave nothing staged.
  if (worktreeStatus(child.worktreePath, runner).staged === 0) {
    return {committed: false, headCommit: headBefore};
  }
  const commit = runner(["commit", "-m", message], child.worktreePath);
  if (commit.status !== 0) {
    throw new WorktreeError("git_failed", `git commit failed: ${commit.stderr || commit.spawnError || `exit ${commit.status}`}`);
  }
  const headAfter = resolveCommit(child.repoRoot, child.branch, runner) ?? headBefore;
  return {committed: true, headCommit: headAfter};
}

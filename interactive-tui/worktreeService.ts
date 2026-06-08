/**
 * worktreeService — Git worktree lifecycle for mergeMaster child sessions (lane B).
 *
 * Lane A (`mergeMaster.ts`) owns the *data model*: the session/git-state types,
 * the status lifecycle, and the pure naming helpers. This module is the *Git
 * orchestration* layer that actually materializes a child's branch + linked
 * worktree on disk, lists/inspects them, detects dirty state, and removes them —
 * but only when explicitly asked.
 *
 * Subprocess, not Zig (deliberately). Lane A keeps its hot, concurrently-read
 * registry state in a Zig kernel because that is a tight in-memory data
 * structure read from many places. Worktree lifecycle is the opposite: it is
 * I/O-bound git plumbing where the cost lives entirely in the `git` child
 * process, the surface area is small, and correctness depends on matching git's
 * own semantics exactly. Shelling out to the user's real `git` (the same one
 * their hooks/config target) is both simpler and more faithful than
 * reimplementing worktree management, so this layer is plain TypeScript over
 * `spawnSync`, mirroring `cellRender.ts`'s runner pattern. The `GitRunner` seam
 * is injectable so unit tests can drive validation paths without a repo, while
 * the lifecycle tests run real git against a temporary repository.
 *
 * What this module guarantees:
 *  - deterministic, namespaced child branches (`sift/<slug>-<hash6>`, via lane A)
 *    and worktree paths kept OUTSIDE the user's repo (`resolveChildWorktreePath`);
 *  - every path/branch is validated before it reaches git — no NULs, control
 *    characters, parent traversal, or paths that escape the managed root or nest
 *    inside the repo;
 *  - non-git directories surface an actionable {@link WorktreeError} instead of a
 *    raw git failure;
 *  - dirty working trees (child *or* parent) are detected and block destructive
 *    actions unless the caller explicitly forces them.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import {
  buildChildBranchName,
  resolveChildWorktreePath,
  type ChildWorktreeLayout,
} from "./mergeMaster";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type WorktreeErrorKind =
  /** The given directory is not inside a Git repository. */
  | "not_a_git_repo"
  /** A branch name or worktree path failed validation (NUL, traversal, escape…). */
  | "unsafe_input"
  /** A working tree had uncommitted changes when a clean tree was required. */
  | "dirty_worktree"
  /** The branch or worktree already exists and we refuse to clobber it. */
  | "already_exists"
  /** A referenced worktree/branch could not be found. */
  | "not_found"
  /** Refused to operate on the primary (repo-root) worktree. */
  | "primary_worktree"
  /** A merge could not proceed because the predicted/actual result conflicts. */
  | "merge_conflict"
  /** The parent worktree is not on the branch the merge targets. */
  | "wrong_branch"
  /** The squash commit was rejected (commit hook, signing, validation…). */
  | "commit_failed"
  /** The underlying `git` invocation failed (non-zero exit or spawn error). */
  | "git_failed";

/**
 * A lifecycle failure with a machine-readable {@link kind} and, where useful, a
 * human-facing {@link remedy} the UI can show. Carrying the kind lets callers
 * (lane C's spawn flow, lane F's send-back) branch without string-matching.
 */
export class WorktreeError extends Error {
  constructor(
    readonly kind: WorktreeErrorKind,
    message: string,
    readonly remedy?: string,
    /** Conflicted paths, when {@link kind} is `merge_conflict`. */
    readonly paths?: string[],
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

// ---------------------------------------------------------------------------
// Git runner seam
// ---------------------------------------------------------------------------

export interface GitCommandResult {
  /** Process exit code, or -1 when git could not be spawned at all. */
  status: number;
  stdout: string;
  stderr: string;
  /** Spawn-level error message (ENOENT etc.); set only when git never ran. */
  spawnError?: string;
}

/** Runs `git <args>` with the given working directory. Injectable for tests. */
export type GitRunner = (args: string[], cwd: string) => GitCommandResult;

/** The real runner: shells out to `git` (overridable via `SIFT_GIT_BIN`). */
export function createGitRunner(gitBin = process.env.SIFT_GIT_BIN || "git"): GitRunner {
  return (args, cwd) => {
    const res = spawnSync(gitBin, args, { cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES });
    if (res.error) {
      return { status: -1, stdout: "", stderr: "", spawnError: res.error.message };
    }
    return {
      status: res.status ?? -1,
      stdout: (res.stdout as string) ?? "",
      stderr: ((res.stderr as string) ?? "").trim(),
    };
  };
}

const defaultRunner = createGitRunner();

/** Resolve symlinks where possible so paths compare equal to git's canonical output. */
function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Run git and throw a {@link WorktreeError} of kind `git_failed` on any failure. */
function git(runner: GitRunner, args: string[], cwd: string): string {
  const res = runner(args, cwd);
  if (res.spawnError) {
    throw new WorktreeError(
      "git_failed",
      `failed to run git: ${res.spawnError}`,
      "Ensure `git` is installed and on PATH (or set SIFT_GIT_BIN).",
    );
  }
  if (res.status !== 0) {
    throw new WorktreeError(
      "git_failed",
      `git ${args.join(" ")} exited ${res.status}: ${res.stderr || "(no stderr)"}`,
    );
  }
  return res.stdout;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// git's own ref-format forbids these in a branch component; we additionally
// forbid them so a malicious "branch name" can never reach the shell or git.
const BRANCH_FORBIDDEN_CHARS = /[\x00-\x20~^:?*[\\\x7f]/;

/**
 * Validate a child branch name. Beyond git's ref rules we require the `sift/`
 * namespace so child branches are unmistakable and never collide with the
 * user's own branches. Returns the branch unchanged on success.
 */
export function validateChildBranchName(branch: string): string {
  const fail = (why: string) =>
    new WorktreeError("unsafe_input", `unsafe child branch name (${why}): ${JSON.stringify(branch)}`);
  if (!branch) throw fail("empty");
  if (!branch.startsWith("sift/")) throw fail("must be namespaced under sift/");
  if (BRANCH_FORBIDDEN_CHARS.test(branch)) throw fail("control char, space, or git-reserved char");
  if (branch.includes("..")) throw fail("contains ..");
  if (branch.includes("//")) throw fail("empty path component");
  if (branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock")) throw fail("bad suffix");
  if (branch.includes("@{")) throw fail("contains @{");
  // Each slash-separated component must be non-empty and not start with a dot or dash.
  for (const part of branch.split("/")) {
    if (!part) throw fail("empty path component");
    if (part.startsWith(".") || part.startsWith("-")) throw fail("component starts with . or -");
  }
  return branch;
}

/**
 * Validate a worktree path. The path must be absolute, free of NULs/control
 * characters and `..` traversal, confined to {@link ChildWorktreeLayout.worktreesRoot},
 * and never nested inside the user's repository. Returns the normalized path.
 *
 * This is the guard against "absolute injected paths": an attacker-supplied
 * absolute path that points anywhere (e.g. `/etc`, the repo itself, a sibling
 * project) is rejected because it does not live under the managed root.
 */
export function validateChildWorktreePath(
  candidate: string,
  opts: { worktreesRoot: string; repoRoot: string },
): string {
  const fail = (why: string) =>
    new WorktreeError("unsafe_input", `unsafe worktree path (${why}): ${JSON.stringify(candidate)}`);
  if (!candidate) throw fail("empty");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(candidate)) throw fail("control char or NUL");
  if (!isAbsolute(candidate)) throw fail("must be absolute");
  // Reject traversal in the *raw* input before normalization collapses it away,
  // so a path is never silently rewritten into the managed root.
  if (candidate.split(/[\\/]/).includes("..")) throw fail("contains .. traversal");

  const root = resolve(opts.worktreesRoot);
  const repo = resolve(opts.repoRoot);
  const normalized = resolve(candidate);
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  if (normalized !== root && !normalized.startsWith(rootPrefix)) {
    throw fail(`escapes the managed worktrees root ${root}`);
  }
  const repoPrefix = repo.endsWith(sep) ? repo : repo + sep;
  if (normalized === repo || normalized.startsWith(repoPrefix)) {
    throw fail("must not be nested inside the repository");
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Repo detection
// ---------------------------------------------------------------------------

/**
 * Resolve the top-level directory of the repository containing `dir`. Throws a
 * `not_a_git_repo` {@link WorktreeError} (with an actionable remedy) when `dir`
 * is not inside a working tree — this is the "actionable unsupported state".
 */
export function resolveRepoRoot(dir: string, runner: GitRunner = defaultRunner): string {
  const res = runner(["rev-parse", "--show-toplevel"], dir);
  if (res.spawnError) {
    throw new WorktreeError(
      "git_failed",
      `failed to run git: ${res.spawnError}`,
      "Ensure `git` is installed and on PATH (or set SIFT_GIT_BIN).",
    );
  }
  if (res.status !== 0) {
    throw new WorktreeError(
      "not_a_git_repo",
      `not a git repository: ${dir}`,
      "mergeMaster child sessions require a Git repo. Run `git init` here (or open a directory that is inside one) first.",
    );
  }
  return res.stdout.trim();
}

/** Non-throwing repo check — true iff `dir` is inside a Git working tree. */
export function isGitRepo(dir: string, runner: GitRunner = defaultRunner): boolean {
  return runner(["rev-parse", "--show-toplevel"], dir).status === 0;
}

// ---------------------------------------------------------------------------
// Inspection: list + status
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  /** Absolute path of the worktree's working directory. */
  path: string;
  /** Short branch name, or "" when detached. */
  branch: string;
  /** Tip commit (full SHA), or "" when unborn. */
  head: string;
  /** True for the primary working tree (the repo root checkout). */
  isPrimary: boolean;
  /** True when HEAD is detached (no branch). */
  isDetached: boolean;
  /** True when `git worktree lock` has been applied. */
  locked: boolean;
  /** True when git reports the worktree as prunable (its directory is gone). */
  prunable: boolean;
  /** True when this is a sift-managed child branch (`sift/…`). */
  isSiftManaged: boolean;
}

/** Parse `git worktree list --porcelain`. The first record is always primary. */
function parseWorktreePorcelain(stdout: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> | null = null;
  const flush = () => {
    if (cur && cur.path != null) {
      const branch = cur.branch ?? "";
      out.push({
        path: cur.path,
        branch,
        head: cur.head ?? "",
        isPrimary: out.length === 0,
        isDetached: cur.isDetached ?? false,
        locked: cur.locked ?? false,
        prunable: cur.prunable ?? false,
        isSiftManaged: branch.startsWith("sift/"),
      });
    }
    cur = null;
  };
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice("worktree ".length) };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      cur.isDetached = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      cur.locked = true;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      cur.prunable = true;
    }
  }
  flush();
  return out;
}

/** List every worktree git knows about for the repo containing `repoRoot`. */
export function listWorktrees(repoRoot: string, runner: GitRunner = defaultRunner): WorktreeInfo[] {
  resolveRepoRoot(repoRoot, runner); // surfaces not_a_git_repo with a remedy
  return parseWorktreePorcelain(git(runner, ["worktree", "list", "--porcelain"], repoRoot));
}

/** List only the sift-managed child worktrees (branch under `sift/`). */
export function listChildWorktrees(repoRoot: string, runner: GitRunner = defaultRunner): WorktreeInfo[] {
  return listWorktrees(repoRoot, runner).filter((w) => w.isSiftManaged && !w.isPrimary);
}

export interface WorktreeStatus {
  path: string;
  clean: boolean;
  /** Raw `git status --porcelain` entries (e.g. " M file", "?? new"). */
  entries: string[];
  staged: number;
  unstaged: number;
  untracked: number;
}

/**
 * Working-tree status for any worktree path (child *or* parent). Used to detect
 * dirty state before destructive lifecycle actions.
 */
export function worktreeStatus(worktreePath: string, runner: GitRunner = defaultRunner): WorktreeStatus {
  const stdout = git(runner, ["status", "--porcelain"], worktreePath);
  const entries = stdout.split("\n").filter((l) => l.length > 0);
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const e of entries) {
    const x = e[0];
    const y = e[1];
    if (x === "?") {
      untracked++;
      continue;
    }
    if (x && x !== " ") staged++;
    if (y && y !== " ") unstaged++;
  }
  return { path: worktreePath, clean: entries.length === 0, entries, staged, unstaged, untracked };
}

/** Convenience: true iff the worktree has any staged/unstaged/untracked change. */
export function isWorktreeDirty(worktreePath: string, runner: GitRunner = defaultRunner): boolean {
  return !worktreeStatus(worktreePath, runner).clean;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateChildWorktreeOptions {
  /** Any directory inside the repo; the real top-level is resolved from it. */
  repoRoot: string;
  /** The parent integration branch the child forks from (e.g. "main"). */
  baseBranch: string;
  /** Stable per-child seed used to derive a deterministic branch name. */
  seed: string;
  /** Human label that flavors the branch slug (e.g. the task focus). */
  focus?: string;
  /** Where sift keeps managed worktrees (e.g. `~/.siftable/worktrees`). */
  layout: ChildWorktreeLayout;
  /** Override the derived branch name (still validated). */
  branch?: string;
  /** Override the derived worktree path (still validated). */
  worktreePath?: string;
}

export interface CreateChildWorktreeResult {
  repoRoot: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  /** Commit the child forked from (resolved tip of baseBranch). */
  baseCommit: string;
  /** Tip of the new child branch (equals baseCommit immediately after creation). */
  headCommit: string;
}

/**
 * Create a child branch and its linked worktree, forked from `baseBranch`.
 *
 * Validates the (derived or overridden) branch and path, confirms the repo and
 * base branch exist, and refuses to clobber an existing branch or a non-empty
 * target directory. The new worktree is created with `git worktree add -b` so
 * the branch and checkout are made atomically by git.
 */
export function createChildWorktree(
  opts: CreateChildWorktreeOptions,
  runner: GitRunner = defaultRunner,
): CreateChildWorktreeResult {
  const repoRoot = resolveRepoRoot(opts.repoRoot, runner);

  const branch = validateChildBranchName(opts.branch ?? buildChildBranchName(opts.seed, opts.focus));
  const worktreePath = validateChildWorktreePath(
    opts.worktreePath ?? resolveChildWorktreePath(opts.layout, repoRoot, branch),
    { worktreesRoot: opts.layout.worktreesRoot, repoRoot },
  );

  // Resolve the base anchor up front — this also validates baseBranch exists.
  const baseRes = runner(["rev-parse", "--verify", "--quiet", `${opts.baseBranch}^{commit}`], repoRoot);
  if (baseRes.status !== 0 || !baseRes.stdout.trim()) {
    throw new WorktreeError(
      "not_found",
      `base branch not found: ${opts.baseBranch}`,
      "Create or check out the base branch before spawning a child session.",
    );
  }
  const baseCommit = baseRes.stdout.trim();

  // Refuse to clobber an existing branch.
  if (runner(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot).status === 0) {
    throw new WorktreeError(
      "already_exists",
      `branch already exists: ${branch}`,
      "Use a different seed/focus, or remove the existing child worktree first.",
    );
  }

  git(runner, ["worktree", "add", "-b", branch, worktreePath, baseCommit], repoRoot);

  const headCommit =
    runner(["rev-parse", "HEAD"], worktreePath).stdout.trim() || baseCommit;

  return { repoRoot, branch, worktreePath, baseBranch: opts.baseBranch, baseCommit, headCommit };
}

// ---------------------------------------------------------------------------
// Remove / archive
// ---------------------------------------------------------------------------

export interface RemoveChildWorktreeOptions {
  /** Any directory inside the repo. */
  repoRoot: string;
  /** The child worktree to remove. */
  worktreePath: string;
  /** Also delete the child branch after the worktree is gone. */
  deleteBranch?: boolean;
  /**
   * Remove even if the child worktree is dirty. Off by default: a dirty child
   * is a destructive-action guard, not a thing to silently discard.
   */
  force?: boolean;
  /**
   * Force-delete the branch (`git branch -D`) instead of the safe `-d`, even when
   * the worktree removal itself is *not* forced. This is what a post-squash-merge
   * cleanup needs: `git merge --squash` lands the work as a fresh single-parent
   * commit on the base without marking the child branch as merged, so `-d` would
   * refuse ("not fully merged") even though the work is provably preserved. Kept
   * separate from {@link force} so forcing a branch delete never loosens the
   * dirty-worktree guard.
   */
  forceBranchDelete?: boolean;
}

export interface RemoveChildWorktreeResult {
  worktreePath: string;
  branch: string;
  branchDeleted: boolean;
  /**
   * Set when `deleteBranch` was requested but the branch was kept rather than
   * deleted (e.g. it held unmerged commits and `-d` refused). The worktree was
   * still removed; this explains why the branch survived so the UI can offer to
   * force-delete it.
   */
  branchRetainedReason?: string;
}

/**
 * Remove a child worktree (and optionally its branch). This is the only
 * destructive lifecycle action and it never runs implicitly — the caller asks
 * for it explicitly. Before removing, it refuses on a dirty child worktree
 * unless `force` is set, so in-flight work is never thrown away by accident.
 */
export function removeChildWorktree(
  opts: RemoveChildWorktreeOptions,
  runner: GitRunner = defaultRunner,
): RemoveChildWorktreeResult {
  const repoRoot = resolveRepoRoot(opts.repoRoot, runner);
  const target = canonicalize(opts.worktreePath);

  const known = listWorktrees(repoRoot, runner);
  const entry = known.find((w) => canonicalize(w.path) === target);
  if (!entry) {
    throw new WorktreeError("not_found", `no registered worktree at ${target}`);
  }
  if (entry.isPrimary) {
    throw new WorktreeError(
      "primary_worktree",
      "refusing to remove the primary (repo-root) worktree",
      "Only sift-managed child worktrees can be removed through this service.",
    );
  }

  if (!opts.force && isWorktreeDirty(target, runner)) {
    throw new WorktreeError(
      "dirty_worktree",
      `child worktree has uncommitted changes: ${target}`,
      "Commit, stash, or discard the changes — or pass force to remove anyway.",
    );
  }

  const args = ["worktree", "remove", target];
  if (opts.force) args.push("--force");
  git(runner, args, repoRoot);

  let branchDeleted = false;
  let branchRetainedReason: string | undefined;
  if (opts.deleteBranch && entry.branch) {
    // The worktree is already gone, so a failed branch delete must not throw and
    // strand the caller in a half-done state. `-d` refuses an unmerged branch;
    // surface that as a retained branch (with a reason) the UI can act on, rather
    // than a raw git_failed that hides the fact the worktree removal succeeded.
    const forceDelete = opts.force || opts.forceBranchDelete;
    const del = runner(["branch", forceDelete ? "-D" : "-d", entry.branch], repoRoot);
    if (del.status === 0) {
      branchDeleted = true;
    } else {
      branchRetainedReason =
        del.stderr || del.spawnError || `git branch delete exited ${del.status}`;
    }
  }

  return { worktreePath: target, branch: entry.branch, branchDeleted, branchRetainedReason };
}

/**
 * Guard helper for destructive actions that must see a clean tree (the parent
 * before a merge, the child before removal). Throws `dirty_worktree` with the
 * offending entries when the tree is not clean.
 */
export function assertWorktreeClean(
  worktreePath: string,
  label: string,
  runner: GitRunner = defaultRunner,
): void {
  const status = worktreeStatus(worktreePath, runner);
  if (!status.clean) {
    throw new WorktreeError(
      "dirty_worktree",
      `${label} worktree is dirty (${status.entries.length} change(s)): ${worktreePath}`,
      "Commit, stash, or discard the changes before continuing.",
    );
  }
}

// ---------------------------------------------------------------------------
// Merge evaluation (read-only) — lane D
// ---------------------------------------------------------------------------
//
// These helpers answer "what would merging this child onto the current base
// produce?" WITHOUT mutating anything. They never check out, stage, commit, or
// create a merge — every operation runs against the shared object database only
// (`merge-base`, `diff`, and crucially `merge-tree --write-tree`, which predicts
// the merged tree in-memory). The lane D gate (`mergeGate.ts`) composes them.

/** Resolve a revision to its full commit SHA, or null if it does not resolve. */
export function resolveCommit(
  repoRoot: string,
  rev: string,
  runner: GitRunner = defaultRunner,
): string | null {
  const res = runner(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], repoRoot);
  const sha = res.status === 0 ? res.stdout.trim() : "";
  return sha || null;
}

/**
 * Best-common-ancestor of two commits (the fork point), or null when they share
 * no history. Read-only: `git merge-base` only walks the commit graph.
 */
export function mergeBase(
  repoRoot: string,
  a: string,
  b: string,
  runner: GitRunner = defaultRunner,
): string | null {
  const res = runner(["merge-base", a, b], repoRoot);
  // Exit 1 here means "no merge base" (unrelated histories), not an error.
  if (res.status === 1) return null;
  if (res.spawnError || res.status !== 0) {
    throw new WorktreeError(
      "git_failed",
      `git merge-base ${a} ${b} failed: ${res.spawnError ?? res.stderr ?? `exit ${res.status}`}`,
    );
  }
  return res.stdout.trim() || null;
}

/**
 * Count commits in a revision range, e.g. `countCommits(root, "base..tip")` for
 * how far the base branch moved since a child forked. Read-only graph walk.
 */
export function countCommits(
  repoRoot: string,
  range: string,
  runner: GitRunner = defaultRunner,
): number {
  const out = git(runner, ["rev-list", "--count", range], repoRoot);
  const n = Number.parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/** One file in a diff stat. `binary` files report null line counts. */
export interface DiffFile {
  path: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

/**
 * `git diff --numstat from..to` parsed per file. Renames are disabled
 * (`--no-renames`) so a moved file shows as a delete of the old path plus an add
 * of the new one — both real paths, which keeps the lane D scope check honest
 * (a rename out of scope is still a write out of scope).
 */
export function diffNumstat(
  repoRoot: string,
  from: string,
  to: string,
  runner: GitRunner = defaultRunner,
): DiffFile[] {
  const out = git(runner, ["diff", "--numstat", "--no-renames", `${from}..${to}`], repoRoot);
  const files: DiffFile[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tab = line.split("\t");
    if (tab.length < 3) continue;
    const [add, del, ...rest] = tab;
    const path = rest.join("\t");
    const binary = add === "-" && del === "-";
    files.push({
      path,
      additions: binary ? null : Number.parseInt(add, 10) || 0,
      deletions: binary ? null : Number.parseInt(del, 10) || 0,
      binary,
    });
  }
  return files;
}

/** Outcome of a read-only merge prediction. */
export interface MergeConflictPrediction {
  /** True when the merge would apply with no conflicts. */
  clean: boolean;
  /** Paths git reports as conflicting (empty when clean). */
  conflicts: string[];
  /** OID of the merged tree git wrote in-memory (informational; null on error). */
  mergedTree: string | null;
}

/**
 * Predict whether merging `head` into `base` conflicts — WITHOUT touching any
 * working tree or index. Uses `git merge-tree --write-tree` (git ≥2.38), which
 * computes the merged tree in the object store and exits 1 iff there are
 * conflicts. Output is: the merged-tree OID on line 1, then the conflicted file
 * names (`--name-only`), then a blank line before informational messages.
 *
 * Exit 1 is a normal result here (conflicts), so this bypasses the throwing
 * `git()` wrapper; only a spawn failure or an unexpected exit code throws.
 */
export function predictMergeConflicts(
  repoRoot: string,
  base: string,
  head: string,
  runner: GitRunner = defaultRunner,
): MergeConflictPrediction {
  const res = runner(["merge-tree", "--write-tree", "--name-only", base, head], repoRoot);
  if (res.spawnError) {
    throw new WorktreeError(
      "git_failed",
      `failed to run git merge-tree: ${res.spawnError}`,
      "Ensure `git` ≥ 2.38 is installed and on PATH (or set SIFT_GIT_BIN).",
    );
  }
  if (res.status !== 0 && res.status !== 1) {
    throw new WorktreeError(
      "git_failed",
      `git merge-tree exited ${res.status}: ${res.stderr || "(no stderr)"}`,
    );
  }
  const lines = res.stdout.split("\n");
  const mergedTree = lines[0]?.trim() || null;
  if (res.status === 0) return { clean: true, conflicts: [], mergedTree };
  // Conflicted file names run from line 1 up to the blank line that precedes
  // the human-readable "Auto-merging…/CONFLICT…" messages.
  const conflicts: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "") break;
    if (lines[i].trim()) conflicts.push(lines[i]);
  }
  return { clean: false, conflicts, mergedTree };
}

// ---------------------------------------------------------------------------
// Squash-merge landing (mutating) — lane E
// ---------------------------------------------------------------------------
//
// This is the one *mutating* git action lane E adds: it lands a child's branch
// onto the base as a single squash commit, the way Pro Git's
// `git merge --squash <branch>` + `git commit` workflow does. It runs in the
// parent's primary worktree (the user's real checkout), so it is fenced by hard
// guards — the tree must be clean, on the target branch, and the merge must be
// predicted conflict-free *first* (read-only). Any failure rolls the base back
// to the exact tip it had before, so a refused merge is a perfect no-op.

export interface SquashMergeOptions {
  /** Any directory inside the repo; the real top-level is resolved from it. */
  repoRoot: string;
  /** The parent's primary working tree (must equal the resolved repo root). */
  parentWorktreePath: string;
  /** Branch the child lands onto; must be checked out in the parent worktree. */
  baseBranch: string;
  /** The child's `sift/…` branch to squash in. */
  childBranch: string;
  /** Message for the squash commit. */
  message: string;
}

export interface SquashMergeResult {
  /** True when a squash commit was actually created. */
  merged: boolean;
  /** True when there was nothing to land (child already in base / empty diff). */
  alreadyUpToDate: boolean;
  /** Base tip before the action. */
  baseCommitBefore: string;
  /** Base tip after the action (equals `baseCommitBefore` when up-to-date). */
  baseCommitAfter: string;
}

/**
 * Squash-merge `childBranch` into `baseBranch` in the parent's primary worktree.
 *
 * Sequence (every guard runs before any mutation):
 *  1. the parent worktree is the canonical primary worktree for the repo;
 *  2. it is on `baseBranch`;
 *  3. it is clean (no staged/unstaged/untracked changes);
 *  4. if the child tip is already an ancestor of the base tip → up-to-date no-op;
 *  5. a read-only conflict prediction (`merge-tree --write-tree`) is clean.
 * Only then does it run `git merge --squash` + `git commit`. A conflict that
 * appears during the real `--squash` (the base moved between prediction and now),
 * an empty squash, or a commit rejected by a hook all roll the base back to its
 * prior tip with `git reset --hard <baseTip>` — safe because the tree was clean.
 */
export function squashMergeChild(
  opts: SquashMergeOptions,
  runner: GitRunner = defaultRunner,
): SquashMergeResult {
  const repoRoot = resolveRepoRoot(opts.repoRoot, runner);
  const parent = canonicalize(opts.parentWorktreePath);

  // 1. Parent must be the canonical primary worktree, not a child checkout.
  if (parent !== canonicalize(repoRoot)) {
    throw new WorktreeError(
      "primary_worktree",
      `parent worktree ${parent} is not the repo root ${canonicalize(repoRoot)}`,
      "Squash-merge lands onto the parent's primary worktree; pass the repo root.",
    );
  }
  const entry = listWorktrees(repoRoot, runner).find((w) => canonicalize(w.path) === parent);
  if (!entry || !entry.isPrimary) {
    throw new WorktreeError(
      "primary_worktree",
      `${parent} is not the primary worktree`,
      "Only the primary (repo-root) worktree can receive a squash merge.",
    );
  }

  // 2. Parent must be on the branch the child lands onto.
  const headBranch = runner(["rev-parse", "--abbrev-ref", "HEAD"], parent).stdout.trim();
  if (headBranch !== opts.baseBranch) {
    throw new WorktreeError(
      "wrong_branch",
      `parent worktree is on "${headBranch}", not the base branch "${opts.baseBranch}"`,
      `Check out "${opts.baseBranch}" in the repo root before merging.`,
    );
  }

  // 3. Parent must be clean — we never squash into a dirty working tree.
  assertWorktreeClean(parent, "parent", runner);

  const baseTip = resolveCommit(repoRoot, opts.baseBranch, runner);
  const childHead = resolveCommit(repoRoot, opts.childBranch, runner);
  if (!baseTip) throw new WorktreeError("not_found", `base branch not found: ${opts.baseBranch}`);
  if (!childHead) throw new WorktreeError("not_found", `child branch not found: ${opts.childBranch}`);

  // 4. Already-landed: child tip is reachable from the base tip → nothing to do.
  const ancestor = runner(["merge-base", "--is-ancestor", childHead, baseTip], repoRoot);
  if (ancestor.status === 0) {
    return { merged: false, alreadyUpToDate: true, baseCommitBefore: baseTip, baseCommitAfter: baseTip };
  }

  // 5. Read-only prediction: never start a merge that would conflict.
  const prediction = predictMergeConflicts(repoRoot, baseTip, childHead, runner);
  if (!prediction.clean) {
    throw new WorktreeError(
      "merge_conflict",
      `squash merge would conflict with ${opts.baseBranch} in: ${prediction.conflicts.join(", ")}`,
      "Rebase or resolve the child against the current base, then re-run the gate.",
    );
  }

  // --- mutate: stage the squashed changeset, then commit it ---
  const rollback = () => runner(["reset", "--hard", baseTip], parent);

  const squash = runner(["merge", "--squash", opts.childBranch], parent);
  if (squash.status !== 0 || worktreeStatus(parent, runner).entries.some((e) => /^(U.|.U|DD|AA)/.test(e))) {
    rollback();
    throw new WorktreeError(
      "merge_conflict",
      `git merge --squash ${opts.childBranch} hit a conflict (base moved since prediction): ${squash.stderr || "(no stderr)"}`,
      "The base advanced under the child; rebase/resolve and re-run the gate.",
    );
  }

  const commit = runner(["commit", "-m", opts.message], parent);
  if (commit.status !== 0) {
    rollback();
    if (/nothing to commit/i.test(`${commit.stdout}\n${commit.stderr}`)) {
      // The squash produced an empty diff (child only re-did base churn).
      return { merged: false, alreadyUpToDate: true, baseCommitBefore: baseTip, baseCommitAfter: baseTip };
    }
    throw new WorktreeError(
      "commit_failed",
      `squash commit rejected: ${commit.stderr || commit.stdout || `exit ${commit.status}`}`,
      "A commit hook or signing step rejected the merge; the base was rolled back to its prior tip.",
    );
  }

  const baseCommitAfter = resolveCommit(repoRoot, opts.baseBranch, runner) ?? baseTip;
  return { merged: true, alreadyUpToDate: false, baseCommitBefore: baseTip, baseCommitAfter };
}

// ---------------------------------------------------------------------------
// Child rebase (catch up to a moved base) — lane F
// ---------------------------------------------------------------------------

export interface RebaseChildOptions {
  /** The child's linked worktree — the rebase runs here, on the child branch. */
  worktreePath: string;
  /** The child's own branch (the one checked out in `worktreePath`). */
  childBranch: string;
  /** The branch to replay the child's commits onto (the parent's base). */
  baseBranch: string;
}

export interface RebaseChildResult {
  /** True if commits were replayed; false if the child already contained the base. */
  rebased: boolean;
  /** The child branch tip after the rebase (== before, when `rebased` is false). */
  headCommitAfter: string;
  /** The base tip the child was replayed onto. */
  baseTip: string;
}

/** Paths git reports as unmerged (conflicted) in `worktree`. */
function unmergedPaths(worktree: string, runner: GitRunner): string[] {
  const res = runner(["diff", "--name-only", "--diff-filter=U"], worktree);
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Replay the child's branch onto the current base tip, inside the child's own
 * worktree (refs are shared across linked worktrees, so the base ref resolves
 * here). **Self-aborting:** a conflict triggers `git rebase --abort`, so the
 * child is left byte-identical to before the attempt (still inspectable), and a
 * `WorktreeError("merge_conflict", …, …, conflictedPaths)` is thrown. A clean
 * rebase leaves the child on its branch at the replayed tip; the caller re-runs
 * the lane-D gate, which typically flips `merge_blocked` → `ready_to_merge`.
 *
 * This is the read_write counterpart to the read-only lane-D conflict
 * *prediction*: the gate tells you a child won't land; this is the one supported
 * way to fix that without leaving the user in a half-rebased worktree.
 */
export function rebaseChildOntoBase(
  opts: RebaseChildOptions,
  runner: GitRunner = defaultRunner,
): RebaseChildResult {
  const worktree = canonicalize(opts.worktreePath);
  // A rebase rewrites commits and churns the index → demand a clean tree first.
  assertWorktreeClean(worktree, "child", runner);

  const baseTip = resolveCommit(worktree, opts.baseBranch, runner);
  if (!baseTip) throw new WorktreeError("not_found", `base branch not found: ${opts.baseBranch}`);
  const before = resolveCommit(worktree, "HEAD", runner);
  if (!before) throw new WorktreeError("not_found", `child HEAD not found in ${worktree}`);

  // Already current: the base tip is reachable from the child tip → no replay.
  if (runner(["merge-base", "--is-ancestor", baseTip, before], worktree).status === 0) {
    return {rebased: false, headCommitAfter: before, baseTip};
  }

  const res = runner(["rebase", baseTip], worktree);
  if (res.status !== 0) {
    // Capture conflicts BEFORE aborting (abort clears the unmerged index).
    const conflicts = unmergedPaths(worktree, runner);
    runner(["rebase", "--abort"], worktree);
    throw new WorktreeError(
      "merge_conflict",
      `rebase onto ${opts.baseBranch} conflicts in: ${conflicts.join(", ") || "(unknown)"}`,
      "The rebase was aborted (child unchanged). Resolve in the child, or send it back with instructions.",
      conflicts,
    );
  }
  const after = resolveCommit(worktree, "HEAD", runner) ?? before;
  return {rebased: after !== before, headCommitAfter: after, baseTip};
}

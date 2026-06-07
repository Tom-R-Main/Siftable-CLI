import { existsSync } from "node:fs";
import { scopeTokenSet, scopesConflict, sharedScopeTokens } from "./planning/scope";

/**
 * mergeMaster — Git-native parent/child session model for `sift interactive`.
 *
 * This module is the *data model and merge authority* layer (lane A). It does
 * NOT spawn worktrees, run git, or render UI — those belong to later lanes
 * (B: child worktree lifecycle service, D: merge packet/gate, E: parent merge
 * view). Here we define the types every other lane shares, the pure functions
 * that keep the path/ref bookkeeping honest, and the registry that owns the
 * live parent/child session state.
 *
 * Native kernel: the registry's hot, concurrently-read state lives in Zig
 * (`native/merge_master.zig`), loaded over Bun FFI exactly like `collabEngine`.
 * The pure TypeScript here doubles as the reference implementation and the
 * fallback used whenever the dylib is absent (e.g. under ts-jest/node) — the two
 * are kept in lockstep (same status table, same worktree rule, same merge-view
 * field set), mirroring how `threadEngine` mirrors its Zig token heuristic.
 *
 * Mental model
 * ------------
 * A *parent* session is the merge authority. It owns the primary working tree
 * (the original checkout, the one whose `.git` is a real directory) and decides
 * what lands. A *child* session is "a Git branch with a conversation attached":
 * it does its work on its own branch and — when it needs to write files — in
 * its own *linked worktree* so the parent's working tree is never disturbed.
 *
 * Why this is a separate type surface from {@link CollabSessionSnapshot}:
 * the existing collab engine (`collabEngine.ts`) models *peer branches within a
 * single process-local session* — `sessionId` is a `number`, branches share one
 * `root`/`cwd`, and the whole thing is ephemeral. mergeMaster sessions are
 * longer-lived, hierarchical (parent/child), each pinned to a distinct working
 * directory and git ref, and each carries its own persisted conversation
 * (keyed into the thread rollout store, see `threadEngine.rolloutPathForKey`).
 * Session handles stay numeric and process-local (like collab) for cheap FFI;
 * durable identity is the per-session `conversationKey` string.
 */

// ---------------------------------------------------------------------------
// Status lifecycle
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a mergeMaster child session, from the parent's point of view.
 *
 * - `running`         — agent is actively working in its branch/worktree.
 * - `needs_input`     — paused awaiting a human/parent answer; not mergeable.
 * - `ready_to_merge`  — work is done, merge packet built, gate passed.
 * - `merge_blocked`   — merge attempted/evaluated but cannot land (e.g. conflict
 *                       with base, failing checks). Inspectable; recoverable.
 * - `merged`          — squash/merge landed onto the base branch. Terminal.
 * - `rejected`        — parent declined the work. Branch + worktree remain
 *                       inspectable (see lane G); terminal for the session.
 * - `abandoned`       — session dropped without merging (timeout, cancel, crash).
 *                       Terminal.
 *
 * The parent (read-only or otherwise) never carries these statuses — it is the
 * authority, not a unit of mergeable work. Use {@link MergeMasterRole} to tell
 * them apart.
 */
export type MergeMasterStatus =
  | "running"
  | "needs_input"
  | "ready_to_merge"
  | "merge_blocked"
  | "merged"
  | "rejected"
  | "abandoned";

export const MERGE_MASTER_STATUSES: readonly MergeMasterStatus[] = [
  "running",
  "needs_input",
  "ready_to_merge",
  "merge_blocked",
  "merged",
  "rejected",
  "abandoned",
] as const;

/** Statuses from which no further transition is allowed. */
export const TERMINAL_STATUSES: readonly MergeMasterStatus[] = [
  "merged",
  "rejected",
  "abandoned",
] as const;

/** Legal status transitions. A status maps to the set it may move to next. */
const STATUS_TRANSITIONS: Record<MergeMasterStatus, readonly MergeMasterStatus[]> = {
  running: ["needs_input", "ready_to_merge", "merge_blocked", "abandoned"],
  needs_input: ["running", "abandoned"],
  // ready_to_merge can fall back to running if the parent reopens the work, or
  // to merge_blocked if the gate is re-evaluated against a moved base.
  ready_to_merge: ["merged", "rejected", "merge_blocked", "running", "abandoned"],
  // merge_blocked is recoverable: rebase/resolve sends it back to running, or a
  // fresh gate pass sends it to ready_to_merge; the parent may also reject it.
  merge_blocked: ["running", "ready_to_merge", "rejected", "abandoned"],
  merged: [],
  rejected: [],
  abandoned: [],
};

export function isTerminalStatus(status: MergeMasterStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: MergeMasterStatus, to: MergeMasterStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Roles and access
// ---------------------------------------------------------------------------

export type MergeMasterRole = "parent" | "child";

/**
 * Whether a child session needs to write files.
 *
 * - `read_only`  — the child only reads/searches the tree (e.g. an investigator
 *   crew member). It may safely *share the parent's working tree* (same cwd):
 *   no checkout, no branch switch, nothing to merge.
 * - `read_write` — the child edits files. It MUST get its own linked worktree on
 *   its own branch so concurrent children never fight over the parent's index /
 *   working files and so each child's changes stay isolated until merged.
 *
 * See {@link childRequiresWorktree}.
 */
export type MergeMasterAccessMode = "read_only" | "read_write";

export type MergeStrategy = "squash_merge" | "merge_commit" | "rebase_merge";

/** Default for the git-native mergeMaster initiative (inputContext.defaultMergeStrategy). */
export const DEFAULT_MERGE_STRATEGY: MergeStrategy = "squash_merge";

/**
 * The core rule that justifies the whole directory model.
 *
 * A write-capable child requires an isolated worktree because git's index and
 * working tree are per-worktree but the object database is shared. Two agents
 * editing files and committing in the *same* working tree would corrupt each
 * other's staged state and HEAD. A read-only child touches neither index nor
 * HEAD, so it can run in the parent's working tree directly.
 */
export function childRequiresWorktree(accessMode: MergeMasterAccessMode): boolean {
  return accessMode === "read_write";
}

// ---------------------------------------------------------------------------
// Git state
// ---------------------------------------------------------------------------

/**
 * The git facts for a single session's working tree. Every path/ref the task
 * spec calls out is kept as its own field — nothing is derived implicitly or
 * collapsed together.
 */
export interface MergeMasterGitState {
  /**
   * The primary repository's top-level directory: the original checkout whose
   * `.git` is a real directory and whose object database every linked worktree
   * shares. Same value for parent and all of its children.
   */
  repoRoot: string;
  /**
   * This session's working tree. For the parent and for read-only children this
   * equals {@link repoRoot}. For a read_write child this is a distinct linked
   * worktree directory (a `.git` *file* pointing back into the primary repo).
   */
  worktreePath: string;
  /** Branch checked out in {@link worktreePath} (short name, e.g. "main"). */
  branch: string;
  /** Tip commit of {@link branch} in this worktree (full 40-char SHA, or "" if unborn). */
  headCommit: string;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Directory anchors that are deliberately kept distinct from git state.
 *
 * - `launchDir`  — where the `sift interactive` process was started
 *   (`process.cwd()` at boot). Fixed for the life of the process; NOT necessarily
 *   inside the repo.
 * - `sessionCwd` — the session's current directory (the user can `cd`). Mirrors
 *   `navigation.NavigationState.sessionCwd`. For a child this lives inside its
 *   worktree; for the parent inside the primary working tree.
 *
 * These are separate from `git.repoRoot`/`git.worktreePath` on purpose: the cwd
 * is a navigation concern (where commands run, what the file explorer shows),
 * the worktree/repo are the git identity. Conflating them is the bug this model
 * exists to prevent.
 */
export interface MergeMasterSession {
  /**
   * Process-local numeric handle, like `CollabSessionSnapshot.sessionId`. Cheap
   * to pass across FFI and stable for the life of the process. Durable identity
   * (across restarts / rollout files) is carried by {@link conversationKey}.
   */
  sessionId: number;
  role: MergeMasterRole;
  /** The parent's session handle; `null` iff `role === "parent"`. */
  parentSessionId: number | null;
  /** Only meaningful for children; parents are authorities, not mergeable units. */
  status: MergeMasterStatus;
  accessMode: MergeMasterAccessMode;

  launchDir: string;
  sessionCwd: string;
  git: MergeMasterGitState;

  /**
   * For a child branch: the branch its work merges back into and the commit it
   * forked from. `null` on the parent (the parent defines the base, it has no
   * base of its own within this model). `baseBranch` is the parent's branch;
   * `baseCommit` is the merge-base anchor used to compute the child's diff and
   * to detect when the base has moved underneath the child.
   */
  baseBranch: string | null;
  baseCommit: string | null;

  /** Thread rollout key for this session's conversation (threadEngine.rolloutPathForKey). */
  conversationKey: string;

  createdAtMs: number;
  updatedAtMs: number;
}

// ---------------------------------------------------------------------------
// Merge view (relational projection consumed by the parent + UI)
// ---------------------------------------------------------------------------

/**
 * The parent's-eye view of one child, pulling parent and child facts into the
 * exact, separately-named fields the merge authority and the parent merge UI
 * (lane E) need to reason about a landing. This is the projection that proves
 * nothing is collapsed: every distinct path and ref has its own slot.
 */
export interface MergeMasterMergeView {
  parentSessionId: number;
  childSessionId: number;

  /** Shared primary repo top-level. */
  repoRoot: string;

  /** Parent's working tree (the primary checkout). */
  parentWorktreePath: string;
  /** Child's working tree (its own linked worktree if read_write; else == parent's). */
  childWorktreePath: string;

  /** Branch the child merges into (the parent's branch). */
  baseBranch: string;
  /** The child's own branch. */
  childBranch: string;

  /** Commit the child forked from (merge-base anchor). */
  baseCommit: string;
  /** Tip of the child's branch — what would be merged. */
  headCommit: string;

  status: MergeMasterStatus;
  mergeStrategy: MergeStrategy;
}

// ---------------------------------------------------------------------------
// Child worktree directory layout
// ---------------------------------------------------------------------------

/**
 * Where sift keeps the linked worktrees it creates for write-capable children.
 *
 * Following the directory model proven out by parallel-agent tools (Codex /
 * OpenCode / T3 keep each session's checkout in a dedicated, app-owned location
 * keyed by branch rather than nested inside the user's repo), sift places child
 * worktrees OUTSIDE the primary working tree. Keeping them out of `repoRoot`
 * avoids: the parent's file explorer/search walking into sibling worktrees, the
 * checkout accidentally tracking itself, and `.gitignore` churn in the user's
 * repo. The default root lives under the siftable home so it survives `cd` and
 * is shared across launches.
 */
export interface ChildWorktreeLayout {
  /** Directory that holds all sift-managed child worktrees, e.g. `~/.siftable/worktrees`. */
  worktreesRoot: string;
}

/** FNV-1a 32-bit — mirrors threadEngine's keying so paths are short and stable. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "session";
}

/**
 * Branch name for a child session. Namespaced under `sift/` so child branches
 * are obvious in `git branch` and never collide with the user's own branches.
 */
export function buildChildBranchName(seed: string, focus?: string): string {
  const base = focus ? slugify(focus) : slugify(seed);
  const suffix = fnv1a32(seed).toString(16).padStart(8, "0").slice(0, 6);
  return `sift/${base}-${suffix}`;
}

/**
 * Absolute path for a child's linked worktree. Keyed by a hash of
 * repoRoot + branch so two repos with the same branch name never collide and
 * the same (repo, branch) is idempotent across launches.
 */
export function resolveChildWorktreePath(
  layout: ChildWorktreeLayout,
  repoRoot: string,
  childBranch: string,
): string {
  const key = `${repoRoot} ${childBranch}`;
  const hash = fnv1a32(key).toString(16).padStart(8, "0");
  // basename of repoRoot for human readability, hash for uniqueness.
  const repoName = slugify(repoRoot.split("/").filter(Boolean).pop() || "repo");
  const branchLeaf = slugify(childBranch.split("/").pop() || "branch");
  return `${layout.worktreesRoot}/${repoName}-${hash}/${branchLeaf}`;
}

/** Thread rollout key for a session's conversation. Each child gets its own. */
export function conversationKeyForSession(params: {
  repoRoot: string;
  role: MergeMasterRole;
  branch: string;
  /** A stable per-child seed (e.g. focus label or uuid) — distinct conversations. */
  seed: string;
}): string {
  if (params.role === "parent") return `${params.repoRoot} parent`;
  return `${params.repoRoot} child ${params.branch} ${params.seed}`;
}

// ---------------------------------------------------------------------------
// Builders / validators
// ---------------------------------------------------------------------------

export class MergeMasterModelError extends Error {}

/**
 * Assemble the parent's merge view for a child, validating the relationship and
 * the distinctness invariants. Throws {@link MergeMasterModelError} on any
 * structural inconsistency rather than returning a half-built view.
 */
export function buildMergeView(
  parent: MergeMasterSession,
  child: MergeMasterSession,
  mergeStrategy: MergeStrategy = DEFAULT_MERGE_STRATEGY,
): MergeMasterMergeView {
  if (parent.role !== "parent") {
    throw new MergeMasterModelError(`expected parent role, got "${parent.role}"`);
  }
  if (child.role !== "child") {
    throw new MergeMasterModelError(`expected child role, got "${child.role}"`);
  }
  if (child.parentSessionId !== parent.sessionId) {
    throw new MergeMasterModelError(
      `child.parentSessionId (${child.parentSessionId}) does not point at parent (${parent.sessionId})`,
    );
  }
  if (parent.parentSessionId !== null) {
    throw new MergeMasterModelError("parent must have a null parentSessionId");
  }
  if (child.git.repoRoot !== parent.git.repoRoot) {
    throw new MergeMasterModelError("child and parent must share the same repoRoot");
  }
  if (child.baseBranch === null || child.baseCommit === null) {
    throw new MergeMasterModelError("child must declare baseBranch and baseCommit");
  }
  // Distinctness invariant: a write-capable child must NOT share the parent's
  // working tree. A read-only child is allowed (and expected) to.
  if (childRequiresWorktree(child.accessMode) && child.git.worktreePath === parent.git.worktreePath) {
    throw new MergeMasterModelError(
      "read_write child must have its own worktree distinct from the parent's",
    );
  }
  return {
    parentSessionId: parent.sessionId,
    childSessionId: child.sessionId,
    repoRoot: parent.git.repoRoot,
    parentWorktreePath: parent.git.worktreePath,
    childWorktreePath: child.git.worktreePath,
    baseBranch: child.baseBranch,
    childBranch: child.git.branch,
    baseCommit: child.baseCommit,
    headCommit: child.git.headCommit,
    status: child.status,
    mergeStrategy,
  };
}

// ---------------------------------------------------------------------------
// Registry — live session state, native-backed with a pure-TS fallback.
// ---------------------------------------------------------------------------
//
// The hot, concurrently-read state lives in native/merge_master.zig. We pick the
// native backend when running under Bun with the dylib built; otherwise we use
// the in-memory fallback below (which the Zig kernel must stay in lockstep with).
// Selection mirrors collabEngine.ts.

export interface CreateParentInput {
  repoRoot: string;
  launchDir: string;
  sessionCwd: string;
  branch: string;
  headCommit?: string;
  conversationKey?: string;
  nowMs?: number;
}

export interface CreateChildInput {
  parentSessionId: number;
  accessMode: MergeMasterAccessMode;
  branch: string;
  worktreePath: string;
  sessionCwd: string;
  baseBranch: string;
  baseCommit: string;
  headCommit?: string;
  conversationKey?: string;
  nowMs?: number;
  /**
   * Files/resources this child intends to write (Gate A scope). Only meaningful
   * for `read_write` children. When provided to {@link createGatedChildSession},
   * the child is serialized behind any running write-capable child whose scope
   * it shares. Lives TS-side (a planning attribute, not git state), so it is not
   * carried in the native session struct.
   */
  writeScope?: string[];
}

interface MergeMasterBackend {
  reset(): void;
  createParent(input: CreateParentInput): number;
  createChild(input: CreateChildInput): number;
  setStatus(sessionId: number, status: MergeMasterStatus, nowMs: number): number;
  setHeadCommit(sessionId: number, headCommit: string, nowMs: number): number;
  snapshotSession(sessionId: number): MergeMasterSession | null;
  snapshotMergeView(childSessionId: number, mergeStrategy: MergeStrategy): MergeMasterMergeView | null;
  listSessions(): MergeMasterSession[];
}

// Status codes shared with native/merge_master.zig.
const MM_OK = 0;
const MM_NOT_FOUND = 2;

const STATUS_TO_CODE: Record<MergeMasterStatus, number> = {
  running: 0,
  needs_input: 1,
  ready_to_merge: 2,
  merge_blocked: 3,
  merged: 4,
  rejected: 5,
  abandoned: 6,
};

const MERGE_STRATEGY_TO_CODE: Record<MergeStrategy, number> = {
  squash_merge: 0,
  merge_commit: 1,
  rebase_merge: 2,
};

// --- Pure-TS fallback ------------------------------------------------------

class InMemoryMergeMasterBackend implements MergeMasterBackend {
  private sessions = new Map<number, MergeMasterSession>();
  private nextId = 1;

  reset(): void {
    this.sessions.clear();
    this.nextId = 1;
  }

  createParent(input: CreateParentInput): number {
    const sessionId = this.nextId++;
    const now = input.nowMs ?? 0;
    this.sessions.set(sessionId, {
      sessionId,
      role: "parent",
      parentSessionId: null,
      status: "running",
      accessMode: "read_write",
      launchDir: input.launchDir,
      sessionCwd: input.sessionCwd,
      git: {
        repoRoot: input.repoRoot,
        worktreePath: input.repoRoot,
        branch: input.branch,
        headCommit: input.headCommit ?? "",
      },
      baseBranch: null,
      baseCommit: null,
      conversationKey:
        input.conversationKey ??
        conversationKeyForSession({ repoRoot: input.repoRoot, role: "parent", branch: input.branch, seed: "" }),
      createdAtMs: now,
      updatedAtMs: now,
    });
    return sessionId;
  }

  createChild(input: CreateChildInput): number {
    const parent = this.sessions.get(input.parentSessionId);
    if (!parent || parent.role !== "parent") return 0;
    if (!input.baseBranch || !input.baseCommit) return 0;
    // Distinctness invariant — same rule the Zig kernel enforces.
    if (childRequiresWorktree(input.accessMode) && input.worktreePath === parent.git.worktreePath) {
      return 0;
    }
    const sessionId = this.nextId++;
    const now = input.nowMs ?? 0;
    this.sessions.set(sessionId, {
      sessionId,
      role: "child",
      parentSessionId: parent.sessionId,
      status: "running",
      accessMode: input.accessMode,
      launchDir: parent.launchDir, // inherited
      sessionCwd: input.sessionCwd,
      git: {
        repoRoot: parent.git.repoRoot, // inherited
        worktreePath: input.worktreePath,
        branch: input.branch,
        headCommit: input.headCommit ?? "",
      },
      baseBranch: input.baseBranch,
      baseCommit: input.baseCommit,
      conversationKey:
        input.conversationKey ??
        conversationKeyForSession({
          repoRoot: parent.git.repoRoot,
          role: "child",
          branch: input.branch,
          seed: String(sessionId),
        }),
      createdAtMs: now,
      updatedAtMs: now,
    });
    return sessionId;
  }

  setStatus(sessionId: number, status: MergeMasterStatus, nowMs: number): number {
    const session = this.sessions.get(sessionId);
    if (!session) return MM_NOT_FOUND;
    if (session.role !== "child") return 4; // STATUS_CONFLICT
    if (session.status === status) return MM_OK;
    if (isTerminalStatus(session.status)) return 5; // STATUS_ILLEGAL_TRANSITION
    if (!canTransition(session.status, status)) return 5;
    session.status = status;
    session.updatedAtMs = nowMs;
    return MM_OK;
  }

  setHeadCommit(sessionId: number, headCommit: string, nowMs: number): number {
    const session = this.sessions.get(sessionId);
    if (!session) return MM_NOT_FOUND;
    session.git.headCommit = headCommit;
    session.updatedAtMs = nowMs;
    return MM_OK;
  }

  snapshotSession(sessionId: number): MergeMasterSession | null {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : null;
  }

  snapshotMergeView(childSessionId: number, mergeStrategy: MergeStrategy): MergeMasterMergeView | null {
    const child = this.sessions.get(childSessionId);
    if (!child || child.role !== "child" || child.parentSessionId === null) return null;
    const parent = this.sessions.get(child.parentSessionId);
    if (!parent) return null;
    return buildMergeView(parent, child, mergeStrategy);
  }

  listSessions(): MergeMasterSession[] {
    return [...this.sessions.values()].map((s) => structuredClone(s));
  }
}

// --- Native (Bun FFI) backend ---------------------------------------------

type MergeMasterNativeSymbols = {
  sift_mm_reset: () => void;
  sift_mm_create_parent: (...args: unknown[]) => number;
  sift_mm_create_child: (...args: unknown[]) => number;
  sift_mm_set_status: (sessionId: number, status: number, nowMs: number) => number;
  sift_mm_set_head_commit: (sessionId: number, head: Uint8Array, headLen: number, nowMs: number) => number;
  sift_mm_snapshot_session: (sessionId: number, out: Uint8Array, cap: number, written: Uint32Array, needed: Uint32Array) => number;
  sift_mm_snapshot_merge_view: (childId: number, strategy: number, out: Uint8Array, cap: number, written: Uint32Array, needed: Uint32Array) => number;
  sift_mm_list_sessions: (out: Uint8Array, cap: number, written: Uint32Array, needed: Uint32Array) => number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(s: string): Uint8Array {
  return encoder.encode(s);
}

let nativeSyms: MergeMasterNativeSymbols | null | undefined;

function nativeSymbols(): MergeMasterNativeSymbols | null {
  if (nativeSyms !== undefined) return nativeSyms;
  if (typeof Bun === "undefined" || process.env.SIFT_NO_NATIVE === "1") {
    nativeSyms = null;
    return nativeSyms;
  }
  const { default: nativeLibraryPath } = require("./native/merge_master") as { default: string };
  if (!existsSync(nativeLibraryPath)) {
    nativeSyms = null;
    return nativeSyms;
  }
  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
  const ptr = FFIType.ptr;
  const u32 = FFIType.u32;
  const u64 = FFIType.u64;
  const lib = dlopen(nativeLibraryPath, {
    sift_mm_reset: {},
    sift_mm_create_parent: {
      args: [ptr, u32, ptr, u32, ptr, u32, ptr, u32, ptr, u32, ptr, u32, u64],
      returns: u32,
    },
    sift_mm_create_child: {
      args: [u32, u32, ptr, u32, ptr, u32, ptr, u32, ptr, u32, ptr, u32, ptr, u32, ptr, u32, u64],
      returns: u32,
    },
    sift_mm_set_status: { args: [u32, u32, u64], returns: u32 },
    sift_mm_set_head_commit: { args: [u32, ptr, u32, u64], returns: u32 },
    sift_mm_snapshot_session: { args: [u32, ptr, u32, ptr, ptr], returns: u32 },
    sift_mm_snapshot_merge_view: { args: [u32, u32, ptr, u32, ptr, ptr], returns: u32 },
    sift_mm_list_sessions: { args: [ptr, u32, ptr, ptr], returns: u32 },
  });
  nativeSyms = lib.symbols as unknown as MergeMasterNativeSymbols;
  return nativeSyms;
}

/** Read a JSON snapshot through one of the native `_snapshot_*` exports, growing the buffer once. */
function readNativeJson(
  call: (out: Uint8Array, cap: number, written: Uint32Array, needed: Uint32Array) => number,
): unknown | null {
  let cap = 4096;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = new Uint8Array(cap);
    const written = new Uint32Array(1);
    const needed = new Uint32Array(1);
    const status = call(out, cap, written, needed);
    if (status === MM_NOT_FOUND) return null;
    if (status === MM_OK) return JSON.parse(decoder.decode(out.subarray(0, written[0])));
    // STATUS_OUTPUT_TOO_SMALL — grow to the reported need and retry once.
    cap = Math.max(needed[0], cap * 2);
  }
  return null;
}

class NativeMergeMasterBackend implements MergeMasterBackend {
  constructor(private readonly s: MergeMasterNativeSymbols) {}

  reset(): void {
    this.s.sift_mm_reset();
  }

  createParent(input: CreateParentInput): number {
    const repo = bytes(input.repoRoot);
    const launch = bytes(input.launchDir);
    const cwd = bytes(input.sessionCwd);
    const branch = bytes(input.branch);
    const head = bytes(input.headCommit ?? "");
    const key = bytes(
      input.conversationKey ??
        conversationKeyForSession({ repoRoot: input.repoRoot, role: "parent", branch: input.branch, seed: "" }),
    );
    return this.s.sift_mm_create_parent(
      repo, repo.length, launch, launch.length, cwd, cwd.length,
      branch, branch.length, head, head.length, key, key.length, input.nowMs ?? 0,
    );
  }

  createChild(input: CreateChildInput): number {
    const branch = bytes(input.branch);
    const worktree = bytes(input.worktreePath);
    const cwd = bytes(input.sessionCwd);
    const baseBranch = bytes(input.baseBranch);
    const baseCommit = bytes(input.baseCommit);
    const head = bytes(input.headCommit ?? "");
    const key = bytes(input.conversationKey ?? "");
    return this.s.sift_mm_create_child(
      input.parentSessionId,
      childRequiresWorktree(input.accessMode) ? 1 : 0,
      branch, branch.length, worktree, worktree.length, cwd, cwd.length,
      baseBranch, baseBranch.length, baseCommit, baseCommit.length,
      head, head.length, key, key.length, input.nowMs ?? 0,
    );
  }

  setStatus(sessionId: number, status: MergeMasterStatus, nowMs: number): number {
    return this.s.sift_mm_set_status(sessionId, STATUS_TO_CODE[status], nowMs);
  }

  setHeadCommit(sessionId: number, headCommit: string, nowMs: number): number {
    const head = bytes(headCommit);
    return this.s.sift_mm_set_head_commit(sessionId, head, head.length, nowMs);
  }

  snapshotSession(sessionId: number): MergeMasterSession | null {
    return readNativeJson((out, cap, written, needed) =>
      this.s.sift_mm_snapshot_session(sessionId, out, cap, written, needed),
    ) as MergeMasterSession | null;
  }

  snapshotMergeView(childSessionId: number, mergeStrategy: MergeStrategy): MergeMasterMergeView | null {
    return readNativeJson((out, cap, written, needed) =>
      this.s.sift_mm_snapshot_merge_view(childSessionId, MERGE_STRATEGY_TO_CODE[mergeStrategy], out, cap, written, needed),
    ) as MergeMasterMergeView | null;
  }

  listSessions(): MergeMasterSession[] {
    return (readNativeJson((out, cap, written, needed) =>
      this.s.sift_mm_list_sessions(out, cap, written, needed),
    ) as MergeMasterSession[] | null) ?? [];
  }
}

let backend: MergeMasterBackend | undefined;

// --- Gate A: write-scope sidecar -------------------------------------------
//
// Scope is a planning attribute, not git state, so it is kept TS-side rather
// than in the native session struct. It records what each gated write-capable
// child intends to write, keyed by the session id the registry assigned, and is
// dropped when the child reaches a terminal status (so finished work stops
// blocking new claims). Children created without a writeScope never appear here
// and so neither block nor are blocked — the gate only reasons about scope it
// actually knows.
const childWriteScopes = new Map<number, { accessMode: MergeMasterAccessMode; scope: Set<string> }>();

function getBackend(): MergeMasterBackend {
  if (backend) return backend;
  const native = nativeSymbols();
  backend = native ? new NativeMergeMasterBackend(native) : new InMemoryMergeMasterBackend();
  return backend;
}

/** True when the registry is running on the native Zig kernel (not the TS fallback). */
export function mergeMasterNativeActive(): boolean {
  return nativeSymbols() != null;
}

export function resetMergeMasterForTests(): void {
  backend?.reset();
  nativeSymbols()?.sift_mm_reset();
  backend = undefined;
  childWriteScopes.clear();
}

export function createParentSession(input: CreateParentInput): number {
  const id = getBackend().createParent(input);
  if (!id) throw new MergeMasterModelError("failed to create parent session");
  return id;
}

export function createChildSession(input: CreateChildInput): number {
  return getBackend().createChild(input); // 0 on rejected invariant — caller decides
}

export function transitionSessionStatus(sessionId: number, status: MergeMasterStatus, nowMs = 0): number {
  const code = getBackend().setStatus(sessionId, status, nowMs);
  // Once a child lands/aborts it no longer holds its scope — free it so coupled
  // work can be admitted. Only drop on a status the backend actually accepted.
  if (code === MM_OK && isTerminalStatus(status)) {
    childWriteScopes.delete(sessionId);
  }
  return code;
}

export function setSessionHeadCommit(sessionId: number, headCommit: string, nowMs = 0): number {
  return getBackend().setHeadCommit(sessionId, headCommit, nowMs);
}

export function getMergeMasterSession(sessionId: number): MergeMasterSession | null {
  return getBackend().snapshotSession(sessionId);
}

export function getMergeView(
  childSessionId: number,
  mergeStrategy: MergeStrategy = DEFAULT_MERGE_STRATEGY,
): MergeMasterMergeView | null {
  return getBackend().snapshotMergeView(childSessionId, mergeStrategy);
}

export function listMergeMasterSessions(): MergeMasterSession[] {
  return getBackend().listSessions();
}

// ---------------------------------------------------------------------------
// Gate A — claim-time scope admission
// ---------------------------------------------------------------------------
//
// Two write-capable children that touch the same files must not run at the same
// time, even in isolated worktrees: their changes would collide at merge and
// the agents would duplicate/clobber each other's edits. Gate A serializes them
// — a read_write candidate is admitted only if no *running* write-capable child
// already holds an overlapping scope. read_only children write nothing, so they
// neither block nor are blocked. This is the runtime consumer of the planner's
// "serialize group" (see planning/agentWork.ts): the planner advises, the gate
// enforces.

export interface ChildAdmissionCandidate {
  accessMode: MergeMasterAccessMode;
  /** Files/resources this child intends to write. */
  writeScope?: string[];
}

export type ChildAdmission =
  | { admit: true }
  | { admit: false; conflictSessionId: number; sharedScope: string[]; reason: string };

/** A child still holds its scope while non-terminal (it could write at any moment). */
function sessionHoldsScope(status: MergeMasterStatus): boolean {
  return !isTerminalStatus(status);
}

/**
 * Decide whether a write-capable child may start now, given the live registry.
 * Pure read of current state — does not mutate anything. Deterministic: when
 * several running children conflict, the lowest session id is reported.
 */
export function evaluateChildAdmission(candidate: ChildAdmissionCandidate): ChildAdmission {
  // read_only children touch no index/HEAD and write nothing → always admitted.
  if (candidate.accessMode !== "read_write") return { admit: true };
  const candidateScope = scopeTokenSet(candidate.writeScope ?? []);
  if (candidateScope.size === 0) return { admit: true };

  const byId = new Map(getBackend().listSessions().map((s) => [s.sessionId, s]));
  const conflicts: Array<{ sessionId: number; shared: string[] }> = [];
  for (const [sessionId, held] of childWriteScopes) {
    if (held.accessMode !== "read_write") continue;
    const session = byId.get(sessionId);
    if (!session || session.role !== "child" || !sessionHoldsScope(session.status)) continue;
    if (scopesConflict(candidateScope, held.scope)) {
      conflicts.push({ sessionId, shared: sharedScopeTokens(candidateScope, held.scope) });
    }
  }
  if (conflicts.length === 0) return { admit: true };

  conflicts.sort((a, b) => a.sessionId - b.sessionId);
  const winner = conflicts[0];
  return {
    admit: false,
    conflictSessionId: winner.sessionId,
    sharedScope: winner.shared,
    reason: `serialized behind running child #${winner.sessionId} (shared scope: ${winner.shared.join(", ")})`,
  };
}

export type GatedChildResult =
  | { sessionId: number; admitted: true }
  | { sessionId: 0; admitted: false; admission: Extract<ChildAdmission, { admit: false }> };

/**
 * The gated spawn entry point. Runs Gate A first; on admission it creates the
 * child and records its scope so subsequent claims serialize behind it; on a
 * block it creates nothing and returns the reason. This is the function the
 * worktree-spawn path (lane B/C) calls instead of {@link createChildSession}
 * whenever a writeScope is known.
 */
export function createGatedChildSession(input: CreateChildInput): GatedChildResult {
  const admission = evaluateChildAdmission({ accessMode: input.accessMode, writeScope: input.writeScope });
  if (admission.admit === false) {
    return { sessionId: 0, admitted: false, admission };
  }
  const sessionId = createChildSession(input);
  if (!sessionId) {
    return {
      sessionId: 0,
      admitted: false,
      admission: {
        admit: false,
        conflictSessionId: 0,
        sharedScope: [],
        reason: "child creation rejected by structural invariant",
      },
    };
  }
  if (input.accessMode === "read_write" && (input.writeScope?.length ?? 0) > 0) {
    childWriteScopes.set(sessionId, { accessMode: input.accessMode, scope: scopeTokenSet(input.writeScope!) });
  }
  return { sessionId, admitted: true };
}

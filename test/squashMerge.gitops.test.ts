/**
 * Lane E E1 — the squash-merge landing action (`squashMergeChild`). Drives real
 * git against temp repos. The two load-bearing properties:
 *  - a clean child lands as EXACTLY ONE single-parent squash commit on the base
 *    (Pro Git §5.3: `--squash` "as if a real merge happened, without actually
 *    making a merge commit … one parent only");
 *  - every refusal path (predicted conflict, conflict-after-base-moved, a commit
 *    rejected by a hook, a dirty/off-base parent) leaves the base tip, the commit
 *    graph, and the parent worktree byte-identical to before — a refused merge is
 *    a perfect no-op.
 */
import {mkdtemp, mkdir, writeFile, chmod, rm, realpath} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {
  createGitRunner,
  resolveRepoRoot,
  resolveCommit,
  worktreeStatus,
  squashMergeChild,
  WorktreeError,
  type GitRunner,
} from "../interactive-tui/worktreeService";

const git: GitRunner = createGitRunner();

async function setupRepo() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sift-squash-")));
  const repoRoot = join(base, "repo");
  await mkdir(repoRoot, {recursive: true});
  const run = (a: string[], cwd = repoRoot): string => {
    const res = git(a, cwd);
    if (res.status !== 0) throw new Error(`git ${a.join(" ")} failed: ${res.stderr || res.spawnError}`);
    return res.stdout;
  };
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@siftable.io"]);
  run(["config", "user.name", "Sift Test"]);
  run(["config", "commit.gpgsign", "false"]);
  await writeFile(join(repoRoot, "shared.txt"), "L1\nL2\n", "utf8");
  await writeFile(join(repoRoot, "untouched.txt"), "stable\n", "utf8");
  run(["add", "."]);
  run(["commit", "-m", "initial"]);
  return {repoRoot: resolveRepoRoot(repoRoot, git), run, base, cleanup: () => rm(base, {recursive: true, force: true})};
}

/** Commit graph + branch refs + reflog — changes if any commit/merge/ref-move happens. */
function graphSignature(repoRoot: string): string {
  const log = git(["log", "--all", "--format=%H %P %s"], repoRoot).stdout;
  const branches = git(["branch", "--all", "--format=%(refname) %(objectname)"], repoRoot).stdout;
  const reflog = git(["reflog", "--all"], repoRoot).stdout;
  return [log, branches, reflog].join("\n--\n");
}

/**
 * Committed history only (no reflog). The safety rollback (`git reset --hard`)
 * legitimately writes a reflog entry, so a *persisted* no-op is proven by the
 * commit graph + branch tips being unchanged, not by the reflog.
 */
function committedSignature(repoRoot: string): string {
  const log = git(["log", "--all", "--format=%H %P %s"], repoRoot).stdout;
  const branches = git(["branch", "--all", "--format=%(refname) %(objectname)"], repoRoot).stdout;
  return [log, branches].join("\n--\n");
}

/** Create a child branch off main with one commit, return to main. Returns the child tip. */
async function makeChild(fx: Awaited<ReturnType<typeof setupRepo>>, branch: string, file: string, body: string): Promise<string> {
  fx.run(["branch", branch]);
  fx.run(["checkout", branch]);
  await writeFile(join(fx.repoRoot, file), body, "utf8");
  fx.run(["add", "."]);
  fx.run(["commit", "-m", `${branch}: ${file}`]);
  const tip = git(["rev-parse", "HEAD"], fx.repoRoot).stdout.trim();
  fx.run(["checkout", "main"]);
  return tip;
}

describe("lane E E1 — squashMergeChild", () => {
  it("lands a clean child as exactly one single-parent squash commit", async () => {
    const fx = await setupRepo();
    try {
      const baseBefore = git(["rev-parse", "main"], fx.repoRoot).stdout.trim();
      const childTip = await makeChild(fx, "sift/feature-a", "a.txt", "hello\n");

      const res = squashMergeChild(
        {repoRoot: fx.repoRoot, parentWorktreePath: fx.repoRoot, baseBranch: "main", childBranch: "sift/feature-a", message: "sift: merge child a"},
        git,
      );

      expect(res.merged).toBe(true);
      expect(res.alreadyUpToDate).toBe(false);
      expect(res.baseCommitBefore).toBe(baseBefore);
      expect(res.baseCommitAfter).not.toBe(baseBefore);

      // Exactly one new commit, single parent == old base tip (squash, not a merge).
      expect(git(["rev-list", "--count", `${baseBefore}..main`], fx.repoRoot).stdout.trim()).toBe("1");
      const parents = git(["rev-list", "--parents", "-n", "1", "main"], fx.repoRoot).stdout.trim().split(/\s+/);
      expect(parents.slice(1)).toEqual([baseBefore]);

      // The child's change is present in base; parent worktree clean.
      expect(git(["show", "main:a.txt"], fx.repoRoot).stdout).toBe("hello\n");
      expect(worktreeStatus(fx.repoRoot, git).clean).toBe(true);
      // Child branch tip is untouched by the landing.
      expect(git(["rev-parse", "sift/feature-a"], fx.repoRoot).stdout.trim()).toBe(childTip);
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses a conflict-after-base-moved child and leaves everything byte-identical", async () => {
    const fx = await setupRepo();
    try {
      await makeChild(fx, "sift/edit-shared", "shared.txt", "L1\nCHILD\n");
      // Base moves with a conflicting edit to the same line.
      await writeFile(join(fx.repoRoot, "shared.txt"), "L1\nMAIN\n", "utf8");
      fx.run(["commit", "-am", "main moves shared"]);

      const sigBefore = graphSignature(fx.repoRoot);
      const cleanBefore = worktreeStatus(fx.repoRoot, git).clean;

      expect(() =>
        squashMergeChild(
          {repoRoot: fx.repoRoot, parentWorktreePath: fx.repoRoot, baseBranch: "main", childBranch: "sift/edit-shared", message: "should not land"},
          git,
        ),
      ).toThrow(WorktreeError);

      expect(graphSignature(fx.repoRoot)).toBe(sigBefore);
      expect(worktreeStatus(fx.repoRoot, git).clean).toBe(cleanBefore);
    } finally {
      await fx.cleanup();
    }
  });

  it("rolls the base back completely when a commit hook rejects the squash", async () => {
    const fx = await setupRepo();
    try {
      await makeChild(fx, "sift/feature-b", "b.txt", "world\n");
      // A pre-commit hook that always fails — the squash stages cleanly, the commit is rejected.
      const hook = join(fx.repoRoot, ".git", "hooks", "pre-commit");
      await writeFile(hook, "#!/bin/sh\nexit 1\n", "utf8");
      await chmod(hook, 0o755);

      const baseBefore = git(["rev-parse", "main"], fx.repoRoot).stdout.trim();
      const sigBefore = committedSignature(fx.repoRoot);

      let err: unknown;
      try {
        squashMergeChild(
          {repoRoot: fx.repoRoot, parentWorktreePath: fx.repoRoot, baseBranch: "main", childBranch: "sift/feature-b", message: "blocked by hook"},
          git,
        );
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(WorktreeError);
      expect((err as WorktreeError).kind).toBe("commit_failed");
      // Rollback is total: no new commit persisted, base tip unchanged, clean tree.
      expect(committedSignature(fx.repoRoot)).toBe(sigBefore);
      expect(git(["rev-parse", "main"], fx.repoRoot).stdout.trim()).toBe(baseBefore);
      expect(worktreeStatus(fx.repoRoot, git).clean).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it("is a no-op when the child is already an ancestor of the base", async () => {
    const fx = await setupRepo();
    try {
      // Child branch with no commits beyond base → its tip == base tip (ancestor).
      fx.run(["branch", "sift/empty"]);
      const baseBefore = git(["rev-parse", "main"], fx.repoRoot).stdout.trim();

      const res = squashMergeChild(
        {repoRoot: fx.repoRoot, parentWorktreePath: fx.repoRoot, baseBranch: "main", childBranch: "sift/empty", message: "nothing"},
        git,
      );
      expect(res).toMatchObject({merged: false, alreadyUpToDate: true, baseCommitAfter: baseBefore});
      expect(git(["rev-parse", "main"], fx.repoRoot).stdout.trim()).toBe(baseBefore);
    } finally {
      await fx.cleanup();
    }
  });

  it("treats an empty squash (net-zero diff) as up-to-date and rolls back", async () => {
    const fx = await setupRepo();
    try {
      // Child changes shared.txt then restores it — net diff vs base is empty.
      fx.run(["branch", "sift/noop"]);
      fx.run(["checkout", "sift/noop"]);
      await writeFile(join(fx.repoRoot, "shared.txt"), "L1\nTEMP\n", "utf8");
      fx.run(["commit", "-am", "noop: temp"]);
      await writeFile(join(fx.repoRoot, "shared.txt"), "L1\nL2\n", "utf8");
      fx.run(["commit", "-am", "noop: restore"]);
      fx.run(["checkout", "main"]);
      const baseBefore = git(["rev-parse", "main"], fx.repoRoot).stdout.trim();

      const res = squashMergeChild(
        {repoRoot: fx.repoRoot, parentWorktreePath: fx.repoRoot, baseBranch: "main", childBranch: "sift/noop", message: "empty"},
        git,
      );
      expect(res).toMatchObject({merged: false, alreadyUpToDate: true, baseCommitAfter: baseBefore});
      expect(git(["rev-parse", "main"], fx.repoRoot).stdout.trim()).toBe(baseBefore);
      expect(worktreeStatus(fx.repoRoot, git).clean).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses when the parent worktree is dirty", async () => {
    const fx = await setupRepo();
    try {
      await makeChild(fx, "sift/feature-c", "c.txt", "c\n");
      await writeFile(join(fx.repoRoot, "untouched.txt"), "now dirty\n", "utf8");
      expect(() =>
        squashMergeChild(
          {repoRoot: fx.repoRoot, parentWorktreePath: fx.repoRoot, baseBranch: "main", childBranch: "sift/feature-c", message: "x"},
          git,
        ),
      ).toThrow(/dirty/i);
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses when the parent is not on the base branch", async () => {
    const fx = await setupRepo();
    try {
      await makeChild(fx, "sift/feature-d", "d.txt", "d\n");
      fx.run(["checkout", "-b", "elsewhere"]);
      let err: unknown;
      try {
        squashMergeChild(
          {repoRoot: fx.repoRoot, parentWorktreePath: fx.repoRoot, baseBranch: "main", childBranch: "sift/feature-d", message: "x"},
          git,
        );
      } catch (e) {
        err = e;
      }
      expect((err as WorktreeError).kind).toBe("wrong_branch");
    } finally {
      await fx.cleanup();
    }
  });
});

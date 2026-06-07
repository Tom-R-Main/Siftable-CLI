/**
 * Lane D D3 — the gate wired to the registry on a real repo: reviewChild runs
 * the read-only evaluation and sets ready_to_merge / merge_blocked, commitChild
 * turns interactive edits into a mergeable commit, and the gate is idempotent +
 * re-runnable so blocked → resolve → ready round-trips (the recovery path the
 * status table promises).
 */
import {mkdtemp, mkdir, writeFile, rm, realpath} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createGitRunner, resolveRepoRoot, resolveCommit, type GitRunner} from "../interactive-tui/worktreeService";
import {createChildSessionController} from "../interactive-tui/childSessionController";
import {getMergeMasterSession, resetMergeMasterForTests} from "../interactive-tui/mergeMaster";

const git: GitRunner = createGitRunner();

async function setupRepo(): Promise<{repoRoot: string; worktreesRoot: string; write: (rel: string, body: string) => Promise<void>; run: (a: string[], cwd?: string) => string; cleanup: () => Promise<void>}> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sift-gatewire-")));
  const repoRoot = join(base, "repo");
  const worktreesRoot = join(base, "worktrees");
  await mkdir(repoRoot, {recursive: true});
  await mkdir(worktreesRoot, {recursive: true});
  const run = (a: string[], cwd = repoRoot): string => {
    const res = git(a, cwd);
    if (res.status !== 0) throw new Error(`git ${a.join(" ")} failed: ${res.stderr || res.spawnError}`);
    return res.stdout;
  };
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@siftable.io"]);
  run(["config", "user.name", "Sift Test"]);
  run(["config", "commit.gpgsign", "false"]);
  await writeFile(join(repoRoot, "shared.txt"), "line1\nline2\n", "utf8");
  run(["add", "."]);
  run(["commit", "-m", "initial"]);
  return {
    repoRoot: resolveRepoRoot(repoRoot, git),
    worktreesRoot,
    write: (rel, body) => writeFile(join(repoRoot, rel), body, "utf8"),
    run,
    cleanup: () => rm(base, {recursive: true, force: true}),
  };
}

beforeEach(() => resetMergeMasterForTests());
afterEach(() => resetMergeMasterForTests());

describe("lane D D3 — gate wired to the registry", () => {
  it("commitChild commits interactive edits; reviewChild then sets ready_to_merge", async () => {
    const fx = await setupRepo();
    try {
      const controller = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});
      const spawn = controller.spawnChild({title: "feature", accessMode: "read_write", writeScope: ["feature.ts"], cwd: fx.repoRoot});
      expect(spawn.ok).toBe(true);
      if (!spawn.ok) return;
      const child = spawn.session;

      // A dirty child cannot merge: reviewChild (no autoCommit) blocks on it.
      await writeFile(join(child.worktreePath, "feature.ts"), "export const x = 1;\n", "utf8");
      const dirtyReview = controller.reviewChild(child.sessionId);
      expect(dirtyReview.ok).toBe(true);
      if (!dirtyReview.ok) return;
      expect(dirtyReview.packet.verdict).toBe("merge_blocked");
      expect(dirtyReview.packet.dirty).toBe(true);
      expect(getMergeMasterSession(child.sessionId)!.status).toBe("merge_blocked");

      // Commit the work, then the SAME child reviews clean → ready_to_merge.
      const commit = controller.commitChild(child.sessionId, "add feature");
      expect(commit.ok).toBe(true);
      expect(commit.committed).toBe(true);

      const okReview = controller.reviewChild(child.sessionId);
      expect(okReview.ok).toBe(true);
      if (!okReview.ok) return;
      expect(okReview.packet.verdict).toBe("ready_to_merge");
      expect(okReview.packet.files.map((f) => f.path)).toEqual(["feature.ts"]);
      expect(okReview.statusApplied).toBe(true);
      expect(getMergeMasterSession(child.sessionId)!.status).toBe("ready_to_merge");

      // The registry's recorded head now matches the child branch's real tip.
      const tip = resolveCommit(fx.repoRoot, child.branch, git);
      expect(getMergeMasterSession(child.sessionId)!.git.headCommit).toBe(tip);
    } finally {
      await fx.cleanup();
    }
  });

  it("autoCommit folds commit + gate into one review", async () => {
    const fx = await setupRepo();
    try {
      const controller = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});
      const spawn = controller.spawnChild({title: "auto", accessMode: "read_write", writeScope: ["auto.ts"], cwd: fx.repoRoot});
      if (!spawn.ok) return;
      const child = spawn.session;
      await writeFile(join(child.worktreePath, "auto.ts"), "export const y = 2;\n", "utf8");

      const review = controller.reviewChild(child.sessionId, {autoCommit: true, message: "auto work"});
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.committed).toBe(true);
      expect(review.packet.verdict).toBe("ready_to_merge");
      expect(getMergeMasterSession(child.sessionId)!.status).toBe("ready_to_merge");
    } finally {
      await fx.cleanup();
    }
  });

  it("is idempotent: re-running a ready child re-affirms ready_to_merge", async () => {
    const fx = await setupRepo();
    try {
      const controller = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});
      const spawn = controller.spawnChild({title: "idem", accessMode: "read_write", writeScope: ["idem.ts"], cwd: fx.repoRoot});
      if (!spawn.ok) return;
      const child = spawn.session;
      await writeFile(join(child.worktreePath, "idem.ts"), "1\n", "utf8");
      controller.commitChild(child.sessionId, "idem");

      const first = controller.reviewChild(child.sessionId);
      const second = controller.reviewChild(child.sessionId);
      expect(first.ok && first.packet.verdict).toBe("ready_to_merge");
      expect(second.ok && second.packet.verdict).toBe("ready_to_merge");
      expect(second.ok && second.statusApplied).toBe(true); // same-status no-op accepted
      expect(getMergeMasterSession(child.sessionId)!.status).toBe("ready_to_merge");
    } finally {
      await fx.cleanup();
    }
  });

  it("blocked → resolve → ready round-trips when the base moves under the child", async () => {
    const fx = await setupRepo();
    try {
      const controller = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});
      const spawn = controller.spawnChild({title: "rt", accessMode: "read_write", writeScope: ["shared.txt"], cwd: fx.repoRoot});
      if (!spawn.ok) return;
      const child = spawn.session;

      // Child edits shared.txt and commits.
      await writeFile(join(child.worktreePath, "shared.txt"), "line1\nCHILD\n", "utf8");
      controller.commitChild(child.sessionId, "child edit");

      // Meanwhile the base (main) moves with a CONFLICTING edit to the same line.
      await fx.write("shared.txt", "line1\nMAIN\n");
      fx.run(["commit", "-am", "main moves"]);

      const blocked = controller.reviewChild(child.sessionId);
      expect(blocked.ok).toBe(true);
      if (!blocked.ok) return;
      expect(blocked.packet.verdict).toBe("merge_blocked");
      expect(blocked.packet.behindBy).toBe(1); // base advanced one commit since fork
      expect(blocked.packet.conflicts).toContain("shared.txt");
      expect(getMergeMasterSession(child.sessionId)!.status).toBe("merge_blocked");

      // Resolve: rebase the child onto the moved base, taking the base's content.
      fx.run(["rebase", "-X", "theirs", "main"], child.worktreePath);

      const ready = controller.reviewChild(child.sessionId);
      expect(ready.ok).toBe(true);
      if (!ready.ok) return;
      expect(ready.packet.conflicts).toEqual([]);
      expect(ready.packet.verdict).toBe("ready_to_merge");
      expect(ready.statusApplied).toBe(true); // merge_blocked → ready_to_merge is legal
      expect(getMergeMasterSession(child.sessionId)!.status).toBe("ready_to_merge");
    } finally {
      await fx.cleanup();
    }
  });
});

/**
 * Lane F — recovery surface: rebase-onto-moved-base, parent send-back, reject.
 *
 * On the real git binary (no mocks), so the self-aborting rebase and the
 * "rejected is terminal but inspectable" guarantee are proven against git's
 * actual behavior, not a model of it.
 *
 *   rebaseChildOntoBase  — clean replay advances the child; a conflict aborts
 *                          and leaves the child byte-identical (throws w/ paths).
 *   controller.rebaseChild — blocked child catches up: clean → ready_to_merge;
 *                          conflict → stays merge_blocked, conflicts surfaced.
 *   controller.sendBackChild — resumes a reviewed child + posts the instruction
 *                          into its thread (postToThread seam).
 *   controller.rejectChild — terminal `rejected`, worktree + branch KEPT.
 */
import {mkdtemp, mkdir, writeFile, rm, realpath} from "node:fs/promises";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {
  createGitRunner,
  resolveRepoRoot,
  rebaseChildOntoBase,
  worktreeStatus,
  WorktreeError,
  type GitRunner,
} from "../interactive-tui/worktreeService";
import {createChildSessionController} from "../interactive-tui/childSessionController";
import {getMergeMasterSession, resetMergeMasterForTests} from "../interactive-tui/mergeMaster";

const git: GitRunner = createGitRunner();

async function setupRepo() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sift-recovery-")));
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
  await writeFile(join(repoRoot, "shared.txt"), "L1\nL2\n", "utf8");
  await writeFile(join(repoRoot, "other.txt"), "O1\n", "utf8");
  run(["add", "."]);
  run(["commit", "-m", "initial"]);
  return {
    repoRoot: resolveRepoRoot(repoRoot, git),
    worktreesRoot,
    run,
    write: (rel: string, body: string) => writeFile(join(repoRoot, rel), body, "utf8"),
    baseTip: () => git(["rev-parse", "main"], repoRoot).stdout.trim(),
    cleanup: () => rm(base, {recursive: true, force: true}),
  };
}

function makeController(fx: Awaited<ReturnType<typeof setupRepo>>) {
  const posts: Array<{key: string; text: string}> = [];
  const controller = createChildSessionController({
    runner: git,
    worktreesRoot: fx.worktreesRoot,
    postToThread: (key, text) => {
      posts.push({key, text});
      return true;
    },
  });
  return {controller, posts};
}

beforeEach(() => resetMergeMasterForTests());
afterEach(() => resetMergeMasterForTests());

describe("lane F — rebaseChildOntoBase (git helper)", () => {
  it("replays cleanly onto a non-conflicting moved base", async () => {
    const fx = await setupRepo();
    try {
      const {controller} = makeController(fx);
      const c = controller.spawnChild({title: "feat", accessMode: "read_write", writeScope: ["feat.ts"], cwd: fx.repoRoot});
      expect(c.ok).toBe(true);
      if (!c.ok) return;
      await writeFile(join(c.session.worktreePath, "feat.ts"), "export const f = 1;\n", "utf8");
      controller.commitChild(c.session.sessionId, "feat");
      const childTipBefore = git(["rev-parse", "HEAD"], c.session.worktreePath).stdout.trim();

      // Base moves on a DIFFERENT file → no conflict, but the child is behind.
      await fx.write("other.txt", "O1\nO2\n");
      fx.run(["commit", "-am", "base moves other"]);
      const baseTip = fx.baseTip();

      const res = rebaseChildOntoBase(
        {worktreePath: c.session.worktreePath, childBranch: c.session.branch, baseBranch: "main"},
        git,
      );
      expect(res.rebased).toBe(true);
      expect(res.baseTip).toBe(baseTip);
      expect(res.headCommitAfter).not.toBe(childTipBefore); // commit was replayed
      // The child now contains the base tip and is clean.
      expect(git(["merge-base", "--is-ancestor", baseTip, "HEAD"], c.session.worktreePath).status).toBe(0);
      expect(worktreeStatus(c.session.worktreePath, git).clean).toBe(true);
      expect(git(["show", "HEAD:other.txt"], c.session.worktreePath).stdout).toBe("O1\nO2\n");
    } finally {
      await fx.cleanup();
    }
  });

  it("aborts on conflict and leaves the child byte-identical (throws with paths)", async () => {
    const fx = await setupRepo();
    try {
      const {controller} = makeController(fx);
      const c = controller.spawnChild({title: "edit", accessMode: "read_write", writeScope: ["shared.txt"], cwd: fx.repoRoot});
      expect(c.ok).toBe(true);
      if (!c.ok) return;
      await writeFile(join(c.session.worktreePath, "shared.txt"), "L1\nCHILD\n", "utf8");
      controller.commitChild(c.session.sessionId, "child edits shared");
      const childTipBefore = git(["rev-parse", "HEAD"], c.session.worktreePath).stdout.trim();

      // Base moves with a CONFLICTING edit to the same line.
      await fx.write("shared.txt", "L1\nMAIN\n");
      fx.run(["commit", "-am", "base moves shared"]);

      let threw: WorktreeError | null = null;
      try {
        rebaseChildOntoBase(
          {worktreePath: c.session.worktreePath, childBranch: c.session.branch, baseBranch: "main"},
          git,
        );
      } catch (err) {
        threw = err as WorktreeError;
      }
      expect(threw).toBeInstanceOf(WorktreeError);
      expect(threw!.kind).toBe("merge_conflict");
      expect(threw!.paths).toContain("shared.txt");

      // ABORTED: the child branch tip + worktree are exactly as before — and no
      // rebase is left in progress.
      expect(git(["rev-parse", "HEAD"], c.session.worktreePath).stdout.trim()).toBe(childTipBefore);
      expect(worktreeStatus(c.session.worktreePath, git).clean).toBe(true);
      expect(existsSync(join(c.session.worktreePath, ".git", "rebase-merge"))).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("lane F — controller recovery", () => {
  it("rebaseChild: a blocked child catches up to the base and becomes ready_to_merge", async () => {
    const fx = await setupRepo();
    try {
      const {controller} = makeController(fx);
      const c = controller.spawnChild({title: "feat", accessMode: "read_write", writeScope: ["feat.ts"], cwd: fx.repoRoot});
      if (!c.ok) return;
      await writeFile(join(c.session.worktreePath, "feat.ts"), "export const f = 1;\n", "utf8");
      controller.commitChild(c.session.sessionId, "feat");

      // Base moves (non-conflicting) and the child falls behind.
      await fx.write("other.txt", "O1\nO2\n");
      fx.run(["commit", "-am", "base moves"]);

      const res = controller.rebaseChild(c.session.sessionId);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.rebased).toBe(true);
      expect(res.verdict).toBe("ready_to_merge");
      expect(res.statusApplied).toBe(true);
      expect(getMergeMasterSession(c.session.sessionId)!.status).toBe("ready_to_merge");

      // And it now actually lands.
      const merged = controller.mergeChild(c.session.sessionId);
      expect(merged.ok).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it("rebaseChild: a conflicting child stays merge_blocked with the conflicts surfaced", async () => {
    const fx = await setupRepo();
    try {
      const {controller} = makeController(fx);
      const c = controller.spawnChild({title: "edit", accessMode: "read_write", writeScope: ["shared.txt"], cwd: fx.repoRoot});
      if (!c.ok) return;
      await writeFile(join(c.session.worktreePath, "shared.txt"), "L1\nCHILD\n", "utf8");
      controller.commitChild(c.session.sessionId, "child edits shared");
      await fx.write("shared.txt", "L1\nMAIN\n");
      fx.run(["commit", "-am", "base moves shared"]);

      // Gate first → merge_blocked.
      controller.reviewChild(c.session.sessionId);
      expect(getMergeMasterSession(c.session.sessionId)!.status).toBe("merge_blocked");

      const res = controller.rebaseChild(c.session.sessionId);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.conflicts).toContain("shared.txt");
      // Still blocked, still inspectable.
      expect(getMergeMasterSession(c.session.sessionId)!.status).toBe("merge_blocked");
      expect(existsSync(c.session.worktreePath)).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });

  it("sendBackChild: resumes a blocked child and posts the instruction into its thread", async () => {
    const fx = await setupRepo();
    try {
      const {controller, posts} = makeController(fx);
      const c = controller.spawnChild({title: "edit", accessMode: "read_write", writeScope: ["shared.txt"], cwd: fx.repoRoot});
      if (!c.ok) return;
      await writeFile(join(c.session.worktreePath, "shared.txt"), "L1\nCHILD\n", "utf8");
      controller.commitChild(c.session.sessionId, "child edits shared");
      await fx.write("shared.txt", "L1\nMAIN\n");
      fx.run(["commit", "-am", "base moves shared"]);
      controller.reviewChild(c.session.sessionId); // → merge_blocked

      const res = controller.sendBackChild(c.session.sessionId, "  rebase onto main and re-resolve shared.txt  ");
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.posted).toBe(true);
      expect(getMergeMasterSession(c.session.sessionId)!.status).toBe("running");
      // The instruction was posted (trimmed) keyed to the child's own thread.
      expect(posts).toHaveLength(1);
      expect(posts[0].key).toBe(c.session.conversationKey);
      expect(posts[0].text).toBe("rebase onto main and re-resolve shared.txt");
    } finally {
      await fx.cleanup();
    }
  });

  it("sendBackChild: refuses a running child (nothing to resume)", async () => {
    const fx = await setupRepo();
    try {
      const {controller, posts} = makeController(fx);
      const c = controller.spawnChild({title: "x", accessMode: "read_write", writeScope: ["x.ts"], cwd: fx.repoRoot});
      if (!c.ok) return;
      const res = controller.sendBackChild(c.session.sessionId, "do the thing");
      expect(res.ok).toBe(false);
      expect(posts).toHaveLength(0); // never posted on a failed transition
      expect(getMergeMasterSession(c.session.sessionId)!.status).toBe("running");
    } finally {
      await fx.cleanup();
    }
  });

  it("rejectChild: a reviewed child becomes terminal but its worktree + branch are kept", async () => {
    const fx = await setupRepo();
    try {
      const {controller} = makeController(fx);
      const c = controller.spawnChild({title: "feat", accessMode: "read_write", writeScope: ["feat.ts"], cwd: fx.repoRoot});
      if (!c.ok) return;
      await writeFile(join(c.session.worktreePath, "feat.ts"), "export const f = 1;\n", "utf8");
      controller.commitChild(c.session.sessionId, "feat");
      controller.reviewChild(c.session.sessionId); // → ready_to_merge

      const res = controller.rejectChild(c.session.sessionId, "out of scope for this cycle");
      expect(res.ok).toBe(true);
      expect(getMergeMasterSession(c.session.sessionId)!.status).toBe("rejected");
      // INSPECTABLE: worktree + branch survive a rejection.
      expect(existsSync(c.session.worktreePath)).toBe(true);
      expect(git(["rev-parse", "--verify", "--quiet", `refs/heads/${c.session.branch}`], fx.repoRoot).status).toBe(0);
      // Still shown (as a terminal row) in the parent's merge view.
      const row = controller.listMergeReadiness().rows.find((r) => r.sessionId === c.session.sessionId);
      expect(row?.status).toBe("rejected");
      expect(row?.verdict).toBeNull();
    } finally {
      await fx.cleanup();
    }
  });

  it("rejectChild: refuses a running child (must be reviewed first)", async () => {
    const fx = await setupRepo();
    try {
      const {controller} = makeController(fx);
      const c = controller.spawnChild({title: "x", accessMode: "read_write", writeScope: ["x.ts"], cwd: fx.repoRoot});
      if (!c.ok) return;
      const res = controller.rejectChild(c.session.sessionId);
      expect(res.ok).toBe(false);
      expect(getMergeMasterSession(c.session.sessionId)!.status).toBe("running");
    } finally {
      await fx.cleanup();
    }
  });
});

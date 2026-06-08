/**
 * Lane E E3 — controller.mergeChild + listMergeReadiness, against real git.
 * Covers: a ready child lands (status merged, base advances by one squash commit,
 * worktree+branch cleaned), idempotency (a second merge is refused), --keep,
 * a scope-blocked child refused with the base untouched, the transition-code
 * guard (a needs_input child with a clean diff is refused before any git
 * mutation), and a conflict that surfaces between commit and merge.
 */
import {mkdtemp, mkdir, writeFile, rm, realpath} from "node:fs/promises";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createGitRunner, resolveRepoRoot, type GitRunner} from "../interactive-tui/worktreeService";
import {createChildSessionController} from "../interactive-tui/childSessionController";
import {
  getMergeMasterSession,
  transitionSessionStatus,
  resetMergeMasterForTests,
} from "../interactive-tui/mergeMaster";

const git: GitRunner = createGitRunner();

async function setupRepo() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sift-mergechild-")));
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
  run(["add", "."]);
  run(["commit", "-m", "initial"]);
  return {
    repoRoot: resolveRepoRoot(repoRoot, git),
    worktreesRoot,
    run,
    baseTip: () => git(["rev-parse", "main"], repoRoot).stdout.trim(),
    cleanup: () => rm(base, {recursive: true, force: true}),
  };
}

beforeEach(() => resetMergeMasterForTests());
afterEach(() => resetMergeMasterForTests());

describe("lane E E3 — mergeChild / listMergeReadiness", () => {
  it("lands a ready child, advancing the base by one squash commit and cleaning up", async () => {
    const fx = await setupRepo();
    try {
      const controller = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});
      const spawn = controller.spawnChild({title: "feat", accessMode: "read_write", writeScope: ["a.ts"], cwd: fx.repoRoot});
      expect(spawn.ok).toBe(true);
      if (!spawn.ok) return;
      const id = spawn.session.sessionId;
      const baseBefore = fx.baseTip();

      await writeFile(join(spawn.session.worktreePath, "a.ts"), "export const a = 1;\n", "utf8");
      controller.commitChild(id, "feat: a.ts");

      const res = controller.mergeChild(id);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.merged).toBe(true);
      expect(res.cleaned).toBe(true);
      expect(getMergeMasterSession(id)!.status).toBe("merged");

      // base advanced by exactly one commit; the child's file is in base.
      expect(git(["rev-list", "--count", `${baseBefore}..main`], fx.repoRoot).stdout.trim()).toBe("1");
      expect(git(["show", "main:a.ts"], fx.repoRoot).stdout).toBe("export const a = 1;\n");

      // worktree gone, branch gone, record dropped.
      expect(existsSync(spawn.session.worktreePath)).toBe(false);
      expect(git(["rev-parse", "--verify", "--quiet", `refs/heads/${spawn.session.branch}`], fx.repoRoot).status).not.toBe(0);
      expect(controller.getChild(id)).toBeUndefined();

      // idempotent: second merge has nothing to act on.
      expect(controller.mergeChild(id)).toEqual({ok: false, reason: "unknown child session"});
    } finally {
      await fx.cleanup();
    }
  });

  it("--keep retains the worktree and branch and reports terminal on re-merge", async () => {
    const fx = await setupRepo();
    try {
      const controller = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});
      const spawn = controller.spawnChild({title: "keep", accessMode: "read_write", writeScope: ["k.ts"], cwd: fx.repoRoot});
      if (!spawn.ok) return;
      const id = spawn.session.sessionId;
      await writeFile(join(spawn.session.worktreePath, "k.ts"), "1\n", "utf8");
      controller.commitChild(id, "keep: k.ts");

      const res = controller.mergeChild(id, {keep: true});
      expect(res.ok && res.merged && !res.cleaned).toBe(true);
      expect(existsSync(spawn.session.worktreePath)).toBe(true);
      expect(git(["rev-parse", "--verify", "--quiet", `refs/heads/${spawn.session.branch}`], fx.repoRoot).status).toBe(0);

      const again = controller.mergeChild(id);
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.reason).toMatch(/terminal/);
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses a scope-violating child and leaves the base untouched", async () => {
    const fx = await setupRepo();
    try {
      const controller = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});
      const spawn = controller.spawnChild({title: "oos", accessMode: "read_write", writeScope: ["allowed.ts"], cwd: fx.repoRoot});
      if (!spawn.ok) return;
      const id = spawn.session.sessionId;
      const baseBefore = fx.baseTip();

      // Writes OUTSIDE the declared scope.
      await writeFile(join(spawn.session.worktreePath, "sneaky.ts"), "nope\n", "utf8");
      controller.commitChild(id, "oos: sneaky");

      const res = controller.mergeChild(id);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.packet?.verdict).toBe("merge_blocked");
      expect(getMergeMasterSession(id)!.status).toBe("merge_blocked");
      expect(fx.baseTip()).toBe(baseBefore);
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses a needs_input child with a clean diff before touching git", async () => {
    const fx = await setupRepo();
    try {
      const controller = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});
      const spawn = controller.spawnChild({title: "ni", accessMode: "read_write", writeScope: ["n.ts"], cwd: fx.repoRoot});
      if (!spawn.ok) return;
      const id = spawn.session.sessionId;
      await writeFile(join(spawn.session.worktreePath, "n.ts"), "ok\n", "utf8");
      controller.commitChild(id, "ni: n.ts");
      const baseBefore = fx.baseTip();

      // Park the child in needs_input — ready_to_merge is illegal from there.
      transitionSessionStatus(id, "needs_input", 0);

      const res = controller.mergeChild(id);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toMatch(/needs_input|resume/);
      expect(getMergeMasterSession(id)!.status).toBe("needs_input");
      expect(fx.baseTip()).toBe(baseBefore);
    } finally {
      await fx.cleanup();
    }
  });

  it("falls back to merge_blocked when a conflict surfaces after the base moves", async () => {
    const fx = await setupRepo();
    try {
      const controller = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});
      const spawn = controller.spawnChild({title: "conf", accessMode: "read_write", writeScope: ["shared.txt"], cwd: fx.repoRoot});
      if (!spawn.ok) return;
      const id = spawn.session.sessionId;
      await writeFile(join(spawn.session.worktreePath, "shared.txt"), "L1\nCHILD\n", "utf8");
      controller.commitChild(id, "conf: edit shared");

      // Base moves with a conflicting edit.
      await writeFile(join(fx.repoRoot, "shared.txt"), "L1\nMAIN\n", "utf8");
      fx.run(["commit", "-am", "main moves shared"]);
      const baseBefore = fx.baseTip();

      const res = controller.mergeChild(id);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(getMergeMasterSession(id)!.status).toBe("merge_blocked");
      expect(fx.baseTip()).toBe(baseBefore);
    } finally {
      await fx.cleanup();
    }
  });

  it("lists readiness across children (ready vs blocked)", async () => {
    const fx = await setupRepo();
    try {
      const controller = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});
      const a = controller.spawnChild({title: "ready", accessMode: "read_write", writeScope: ["x.ts"], cwd: fx.repoRoot});
      const b = controller.spawnChild({title: "blocked", accessMode: "read_write", writeScope: ["only.ts"], cwd: fx.repoRoot});
      if (!a.ok || !b.ok) return;
      await writeFile(join(a.session.worktreePath, "x.ts"), "1\n", "utf8");
      controller.commitChild(a.session.sessionId, "ready: x");
      await writeFile(join(b.session.worktreePath, "outside.ts"), "1\n", "utf8");
      controller.commitChild(b.session.sessionId, "blocked: outside");

      const view = controller.listMergeReadiness();
      expect(view.readyCount).toBe(1);
      expect(view.blockedCount).toBe(1);
      expect(view.rows[0].sessionId).toBe(a.session.sessionId); // ready sorts first
    } finally {
      await fx.cleanup();
    }
  });
});

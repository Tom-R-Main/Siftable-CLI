/**
 * Lane D D5 — load-bearing end-to-end: two real committed children evaluated by
 * the gate. Child A touches its own file and merges clean; child B edits a file
 * the base then changes underneath it, so B is blocked on a real conflict after
 * the base moved. The second, non-negotiable assertion is the read-only
 * guarantee: running the gate on both children leaves every worktree clean and
 * the commit/branch graph byte-identical — the verdict is PREDICTED, never
 * produced by an actual merge.
 */
import {mkdtemp, mkdir, writeFile, rm, realpath} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createGitRunner, resolveRepoRoot, worktreeStatus, type GitRunner} from "../interactive-tui/worktreeService";
import {createChildSessionController} from "../interactive-tui/childSessionController";
import {getMergeMasterSession, resetMergeMasterForTests} from "../interactive-tui/mergeMaster";

const git: GitRunner = createGitRunner();

async function setupRepo() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sift-gatee2e-")));
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
  await writeFile(join(repoRoot, "untouched.txt"), "stable\n", "utf8");
  run(["add", "."]);
  run(["commit", "-m", "initial"]);
  return {
    repoRoot: resolveRepoRoot(repoRoot, git),
    worktreesRoot,
    write: (rel: string, body: string) => writeFile(join(repoRoot, rel), body, "utf8"),
    run,
    cleanup: () => rm(base, {recursive: true, force: true}),
  };
}

/** Commit graph + branch refs across the whole repo — changes if any merge/commit happens. */
function graphSignature(repoRoot: string): string {
  const log = git(["log", "--all", "--format=%H %s"], repoRoot).stdout;
  const branches = git(["branch", "--all", "--format=%(refname) %(objectname)"], repoRoot).stdout;
  const reflog = git(["reflog", "--all"], repoRoot).stdout;
  return [log, branches, reflog].join("\n--\n");
}

beforeEach(() => resetMergeMasterForTests());
afterEach(() => resetMergeMasterForTests());

describe("lane D D5 — two-child gate e2e", () => {
  it("clean child → ready, conflict-after-base-moved child → blocked, and the gate mutates nothing", async () => {
    const fx = await setupRepo();
    try {
      const controller = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});

      // Two writers with DISJOINT scope both admit past Gate A.
      const a = controller.spawnChild({title: "feature-a", accessMode: "read_write", writeScope: ["a.ts"], cwd: fx.repoRoot});
      const b = controller.spawnChild({title: "edit-shared", accessMode: "read_write", writeScope: ["shared.txt"], cwd: fx.repoRoot});
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;

      // Child A: a brand-new file. Child B: edits shared.txt line 2.
      await writeFile(join(a.session.worktreePath, "a.ts"), "export const a = 1;\n", "utf8");
      await writeFile(join(b.session.worktreePath, "shared.txt"), "L1\nB-EDIT\n", "utf8");
      controller.commitChild(a.session.sessionId, "A: add a.ts");
      controller.commitChild(b.session.sessionId, "B: edit shared");

      // The base moves with a CONFLICTING edit to shared.txt line 2.
      await fx.write("shared.txt", "L1\nMAIN-EDIT\n");
      fx.run(["commit", "-am", "main moves shared"]);

      // ── capture the read-only baseline AFTER all real commits ──────────────
      const graphBefore = graphSignature(fx.repoRoot);
      const aCleanBefore = worktreeStatus(a.session.worktreePath, git).clean;
      const bCleanBefore = worktreeStatus(b.session.worktreePath, git).clean;
      const parentCleanBefore = worktreeStatus(fx.repoRoot, git).clean;
      expect([aCleanBefore, bCleanBefore, parentCleanBefore]).toEqual([true, true, true]);

      // ── run the gate on both children ──────────────────────────────────────
      const ra = controller.reviewChild(a.session.sessionId);
      const rb = controller.reviewChild(b.session.sessionId);
      expect(ra.ok && rb.ok).toBe(true);
      if (!ra.ok || !rb.ok) return;

      // A merges clean against the moved base (disjoint file).
      expect(ra.packet.verdict).toBe("ready_to_merge");
      expect(ra.packet.conflicts).toEqual([]);
      expect(ra.packet.files.map((f) => f.path)).toEqual(["a.ts"]);
      expect(getMergeMasterSession(a.session.sessionId)!.status).toBe("ready_to_merge");

      // B conflicts on shared.txt; the packet records the base drift.
      expect(rb.packet.verdict).toBe("merge_blocked");
      expect(rb.packet.conflicts).toContain("shared.txt");
      expect(rb.packet.behindBy).toBe(1);
      expect(getMergeMasterSession(b.session.sessionId)!.status).toBe("merge_blocked");

      // ── READ-ONLY GUARANTEE: nothing the gate did touched git ──────────────
      expect(graphSignature(fx.repoRoot)).toBe(graphBefore);
      expect(worktreeStatus(a.session.worktreePath, git).clean).toBe(true);
      expect(worktreeStatus(b.session.worktreePath, git).clean).toBe(true);
      expect(worktreeStatus(fx.repoRoot, git).clean).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });
});

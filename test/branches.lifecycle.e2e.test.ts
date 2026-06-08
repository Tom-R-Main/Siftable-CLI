/**
 * Lane G — the full /branches lifecycle as ONE deterministic, cited harness.
 *
 * The lanes are each proven in focused suites (mergeEval/mergeGate/mergeChild/
 * squashMerge). This is the integration floor the architecture doc calls for: a
 * single temp repo driven through the whole machine, asserting the git facts at
 * every hop so a regression anywhere in C→E shows up here first.
 *
 *   spawn (worktree on its own branch)
 *     → edit + commit in the worktree
 *     → review → ready_to_merge (clean against the live base)
 *     → squash-merge → exactly one single-parent commit on base, change present,
 *        parent worktree clean + on base, child worktree + branch gone, status merged
 *
 *   second child, base moves underneath with a conflicting edit
 *     → merge refused (merge_blocked), and the refusal is a PERFECT no-op
 *        (base tip + whole commit graph byte-identical)
 *     → the blocked child stays fully inspectable (worktree + branch retained)
 *     → abandon → terminal abandoned, worktree + branch cleaned, scope freed
 *
 * Everything runs on the real git binary (createGitRunner) — no mocks — so this
 * doubles as the proof that the controller's sequencing matches git's reality.
 */
import {mkdtemp, mkdir, writeFile, rm, realpath} from "node:fs/promises";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createGitRunner, resolveRepoRoot, worktreeStatus, type GitRunner} from "../interactive-tui/worktreeService";
import {createChildSessionController} from "../interactive-tui/childSessionController";
import {getMergeMasterSession, resetMergeMasterForTests} from "../interactive-tui/mergeMaster";

const git: GitRunner = createGitRunner();

async function setupRepo() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "sift-lifecycle-")));
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
    write: (rel: string, body: string) => writeFile(join(repoRoot, rel), body, "utf8"),
    baseTip: () => git(["rev-parse", "main"], repoRoot).stdout.trim(),
    cleanup: () => rm(base, {recursive: true, force: true}),
  };
}

function graphSignature(repoRoot: string): string {
  const log = git(["log", "--all", "--format=%H %P %s"], repoRoot).stdout;
  const branches = git(["branch", "--all", "--format=%(refname) %(objectname)"], repoRoot).stdout;
  const reflog = git(["reflog", "--all"], repoRoot).stdout;
  return [log, branches, reflog].join("\n--\n");
}

beforeEach(() => resetMergeMasterForTests());
afterEach(() => resetMergeMasterForTests());

describe("lane G — full /branches lifecycle on a real repo", () => {
  it("drives spawn → commit → ready → squash-merge → cleanup, and blocked → inspectable → abandon", async () => {
    const fx = await setupRepo();
    try {
      const controller = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});

      // ── spawn: a scoped writer gets its own branch + linked worktree ─────────
      const child = controller.spawnChild({
        title: "add greeter",
        accessMode: "read_write",
        writeScope: ["greeter.ts"],
        cwd: fx.repoRoot,
      });
      expect(child.ok).toBe(true);
      if (!child.ok) return;
      const id = child.session.sessionId;
      expect(getMergeMasterSession(id)!.status).toBe("running");
      expect(child.session.worktreePath.startsWith(fx.worktreesRoot)).toBe(true);
      expect(existsSync(child.session.worktreePath)).toBe(true);
      // The child's branch exists and is distinct from base.
      expect(child.session.branch).not.toBe("main");
      expect(git(["rev-parse", "--verify", "--quiet", `refs/heads/${child.session.branch}`], fx.repoRoot).status).toBe(0);

      // ── edit + commit inside the worktree (isolated from the parent tree) ─────
      await writeFile(join(child.session.worktreePath, "greeter.ts"), "export const hi = () => 'hi';\n", "utf8");
      const committed = controller.commitChild(id, "add greeter");
      expect(committed.ok && committed.committed).toBe(true);
      // The new file is NOT in the parent worktree — isolation holds.
      expect(existsSync(join(fx.repoRoot, "greeter.ts"))).toBe(false);

      // ── review: clean against the live base → ready_to_merge ─────────────────
      const review = controller.reviewChild(id);
      expect(review.ok).toBe(true);
      if (!review.ok) return;
      expect(review.packet.verdict).toBe("ready_to_merge");
      expect(review.packet.conflicts).toEqual([]);
      expect(review.packet.outOfScope).toEqual([]);
      expect(review.statusApplied).toBe(true);
      expect(getMergeMasterSession(id)!.status).toBe("ready_to_merge");

      // ── squash-merge: exactly one single-parent commit on base ───────────────
      const baseBeforeMerge = fx.baseTip();
      const merged = controller.mergeChild(id);
      expect(merged.ok).toBe(true);
      if (!merged.ok) return;
      expect(merged.merged).toBe(true);
      expect(merged.cleaned).toBe(true);
      expect(getMergeMasterSession(id)!.status).toBe("merged");

      expect(git(["rev-list", "--count", `${baseBeforeMerge}..main`], fx.repoRoot).stdout.trim()).toBe("1");
      const parents = git(["rev-list", "--parents", "-n", "1", "main"], fx.repoRoot).stdout.trim().split(/\s+/);
      expect(parents.slice(1)).toEqual([baseBeforeMerge]); // single parent == squash, not a merge commit
      expect(git(["show", "main:greeter.ts"], fx.repoRoot).stdout).toBe("export const hi = () => 'hi';\n");
      // parent worktree clean + on base; child worktree + branch gone after cleanup.
      expect(worktreeStatus(fx.repoRoot, git).clean).toBe(true);
      expect(git(["rev-parse", "--abbrev-ref", "HEAD"], fx.repoRoot).stdout.trim()).toBe("main");
      expect(existsSync(child.session.worktreePath)).toBe(false);
      expect(git(["rev-parse", "--verify", "--quiet", `refs/heads/${child.session.branch}`], fx.repoRoot).status).not.toBe(0);

      // ── second child: base moves underneath with a conflicting edit ──────────
      const blocked = controller.spawnChild({
        title: "edit shared",
        accessMode: "read_write",
        writeScope: ["shared.txt"],
        cwd: fx.repoRoot,
      });
      expect(blocked.ok).toBe(true);
      if (!blocked.ok) return;
      const bid = blocked.session.sessionId;

      await writeFile(join(blocked.session.worktreePath, "shared.txt"), "L1\nCHILD\n", "utf8");
      controller.commitChild(bid, "child edits shared");
      // Base advances with a CONFLICTING edit to the same line.
      await fx.write("shared.txt", "L1\nMAIN\n");
      fx.run(["commit", "-am", "main moves shared"]);

      const baseBeforeRefusal = fx.baseTip();
      const sigBefore = graphSignature(fx.repoRoot);

      const refusal = controller.mergeChild(bid);
      expect(refusal.ok).toBe(false);
      if (refusal.ok) return;
      expect(getMergeMasterSession(bid)!.status).toBe("merge_blocked");

      // READ-ONLY GUARANTEE: a refused merge is a perfect no-op.
      expect(fx.baseTip()).toBe(baseBeforeRefusal);
      expect(graphSignature(fx.repoRoot)).toBe(sigBefore);
      expect(worktreeStatus(fx.repoRoot, git).clean).toBe(true);

      // INSPECTABLE: the blocked child keeps its worktree + branch for follow-up.
      expect(existsSync(blocked.session.worktreePath)).toBe(true);
      expect(git(["rev-parse", "--verify", "--quiet", `refs/heads/${blocked.session.branch}`], fx.repoRoot).status).toBe(0);

      // ── abandon: terminal, worktree + branch cleaned, scope freed ────────────
      const abandoned = controller.removeChild(bid, {deleteBranch: true, force: true});
      expect(abandoned.ok).toBe(true);
      expect(getMergeMasterSession(bid)!.status).toBe("abandoned");
      expect(existsSync(blocked.session.worktreePath)).toBe(false);
      expect(git(["rev-parse", "--verify", "--quiet", `refs/heads/${blocked.session.branch}`], fx.repoRoot).status).not.toBe(0);
      // The controller no longer tracks it (gone from the merge view).
      expect(controller.listMergeReadiness().rows.some((r) => r.sessionId === bid)).toBe(false);

      // Re-spawning the same scope is admitted again (the abandoned child freed Gate-A).
      const reclaim = controller.spawnChild({
        title: "edit shared again",
        accessMode: "read_write",
        writeScope: ["shared.txt"],
        cwd: fx.repoRoot,
      });
      expect(reclaim.ok).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });
});

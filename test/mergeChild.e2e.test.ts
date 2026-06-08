/**
 * Lane E E5 — load-bearing end-to-end. Two committed children with disjoint
 * scope; the base then moves with an edit that conflicts with the second child.
 * Child A lands: the base advances by EXACTLY ONE single-parent squash commit,
 * its change is present in base, the parent worktree is clean and on base, and
 * A's worktree+branch are gone. Child B's merge is refused — and the
 * non-negotiable assertion is that the refusal is a perfect no-op: the parent
 * worktree and the whole commit graph are byte-identical to before the attempt.
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
  const base = await realpath(await mkdtemp(join(tmpdir(), "sift-mergee2e-")));
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

describe("lane E E5 — two-child merge e2e", () => {
  it("lands the clean child (one squash commit) and refuses the conflicting one read-only", async () => {
    const fx = await setupRepo();
    try {
      const controller = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});
      const a = controller.spawnChild({title: "feature-a", accessMode: "read_write", writeScope: ["a.ts"], cwd: fx.repoRoot});
      const b = controller.spawnChild({title: "edit-shared", accessMode: "read_write", writeScope: ["shared.txt"], cwd: fx.repoRoot});
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;

      await writeFile(join(a.session.worktreePath, "a.ts"), "export const a = 1;\n", "utf8");
      await writeFile(join(b.session.worktreePath, "shared.txt"), "L1\nB-EDIT\n", "utf8");
      controller.commitChild(a.session.sessionId, "A: add a.ts");
      controller.commitChild(b.session.sessionId, "B: edit shared");

      // Base moves with a CONFLICTING edit to shared.txt.
      await fx.write("shared.txt", "L1\nMAIN-EDIT\n");
      fx.run(["commit", "-am", "main moves shared"]);
      const baseBeforeAnyMerge = fx.baseTip();

      // ── land child A ────────────────────────────────────────────────────────
      const ra = controller.mergeChild(a.session.sessionId);
      expect(ra.ok).toBe(true);
      if (!ra.ok) return;
      expect(ra.merged).toBe(true);
      expect(getMergeMasterSession(a.session.sessionId)!.status).toBe("merged");

      // exactly one new commit, single parent == prior base tip (squash, not merge).
      expect(git(["rev-list", "--count", `${baseBeforeAnyMerge}..main`], fx.repoRoot).stdout.trim()).toBe("1");
      const parents = git(["rev-list", "--parents", "-n", "1", "main"], fx.repoRoot).stdout.trim().split(/\s+/);
      expect(parents.slice(1)).toEqual([baseBeforeAnyMerge]);
      expect(git(["show", "main:a.ts"], fx.repoRoot).stdout).toBe("export const a = 1;\n");
      // parent worktree clean + on base; A's worktree + branch removed.
      expect(worktreeStatus(fx.repoRoot, git).clean).toBe(true);
      expect(git(["rev-parse", "--abbrev-ref", "HEAD"], fx.repoRoot).stdout.trim()).toBe("main");
      expect(existsSync(a.session.worktreePath)).toBe(false);
      expect(git(["rev-parse", "--verify", "--quiet", `refs/heads/${a.session.branch}`], fx.repoRoot).status).not.toBe(0);

      // ── refuse child B (conflicts on shared.txt), read-only ─────────────────
      const baseBeforeB = fx.baseTip();
      const sigBefore = graphSignature(fx.repoRoot);

      const rb = controller.mergeChild(b.session.sessionId);
      expect(rb.ok).toBe(false);
      if (rb.ok) return;
      expect(getMergeMasterSession(b.session.sessionId)!.status).toBe("merge_blocked");

      // READ-ONLY GUARANTEE: the refused merge changed nothing.
      expect(fx.baseTip()).toBe(baseBeforeB);
      expect(graphSignature(fx.repoRoot)).toBe(sigBefore);
      expect(worktreeStatus(fx.repoRoot, git).clean).toBe(true);
      expect(existsSync(b.session.worktreePath)).toBe(true); // B retained for follow-up
    } finally {
      await fx.cleanup();
    }
  });
});

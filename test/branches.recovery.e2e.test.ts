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
  listChildWorktrees,
  resolveRepoRoot,
  rebaseChildOntoBase,
  worktreeStatus,
  WorktreeError,
  type GitRunner,
} from "../interactive-tui/worktreeService";
import {createChildSessionController} from "../interactive-tui/childSessionController";
import {createChildSessionStore} from "../interactive-tui/childSessionStore";
import {getMergeMasterSession, resetMergeMasterForTests} from "../interactive-tui/mergeMaster";
import {
  acknowledgeSessionInstruction,
  enqueueSessionInstruction,
  listPendingSessionInstructions,
  sessionJournalIdForConversation,
} from "../interactive-tui/sessionMailbox";
import {createWorkRunController, type WorkRunClient} from "../interactive-tui/workRunController";

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
      return {status: "durable"};
    },
  });
  return {controller, posts};
}

beforeEach(() => resetMergeMasterForTests());
afterEach(() => resetMergeMasterForTests());

describe("durable session instruction mailbox", () => {
  it("uses the stable journal identity and retains instructions until acknowledged", async () => {
    const rootDir = await realpath(await mkdtemp(join(tmpdir(), "sift-session-mailbox-")));
    try {
      const conversationKey = "/repo child feature/mailbox work-42";
      const first = enqueueSessionInstruction(conversationKey, "  inspect the failed gate  ", {
        rootDir,
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        idFactory: () => "instruction-a",
      });
      const second = enqueueSessionInstruction(conversationKey, "then rerun the focused test", {
        rootDir,
        now: () => new Date("2026-08-25T12:00:01.000Z"),
        idFactory: () => "instruction-b",
      });

      expect(first.sessionId).toBe(sessionJournalIdForConversation(conversationKey));
      expect(first.sessionId).toMatch(/^[0-9a-f]{64}$/);
      expect(first.instruction).toBe("inspect the failed gate");
      expect(listPendingSessionInstructions(conversationKey, {rootDir})).toEqual([first, second]);

      expect(acknowledgeSessionInstruction(conversationKey, first.instructionId, {rootDir})).toBe(true);
      expect(acknowledgeSessionInstruction(conversationKey, first.instructionId, {rootDir})).toBe(false);
      expect(listPendingSessionInstructions(conversationKey, {rootDir})).toEqual([second]);
    } finally {
      await rm(rootDir, {recursive: true, force: true});
    }
  });

  it("never overwrites a published instruction when an id collides", async () => {
    const rootDir = await realpath(await mkdtemp(join(tmpdir(), "sift-session-mailbox-")));
    try {
      const options = {
        rootDir,
        now: () => new Date("2026-08-25T12:00:00.000Z"),
        idFactory: () => "fixed-id",
      };
      const original = enqueueSessionInstruction("conversation", "original", options);

      expect(() => enqueueSessionInstruction("conversation", "replacement", options)).toThrow();
      expect(listPendingSessionInstructions("conversation", {rootDir})).toEqual([original]);
    } finally {
      await rm(rootDir, {recursive: true, force: true});
    }
  });
});

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

      const res = await controller.rebaseChild(c.session.sessionId);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.rebased).toBe(true);
      expect(res.verdict).toBe("ready_to_merge");
      expect(res.statusApplied).toBe(true);
      expect(getMergeMasterSession(c.session.sessionId)!.status).toBe("ready_to_merge");

      // And it now actually lands.
      const merged = await controller.mergeChild(c.session.sessionId);
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
      await controller.reviewChild(c.session.sessionId);
      expect(getMergeMasterSession(c.session.sessionId)!.status).toBe("merge_blocked");

      const res = await controller.rebaseChild(c.session.sessionId);
      expect(res.ok).toBe(false);
      if (res.ok === true) return;
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
      await controller.reviewChild(c.session.sessionId); // → merge_blocked

      const res = controller.sendBackChild(c.session.sessionId, "  rebase onto main and re-resolve shared.txt  ");
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.posted).toBe(true);
      expect(res.durability).toBe("durable");
      expect(getMergeMasterSession(c.session.sessionId)!.status).toBe("running");
      // The instruction was posted (trimmed) keyed to the child's own thread.
      expect(posts).toHaveLength(1);
      expect(posts[0].key).toBe(c.session.conversationKey);
      expect(posts[0].text).toBe("rebase onto main and re-resolve shared.txt");
    } finally {
      await fx.cleanup();
    }
  });

  it("sendBackChild: durably enqueues without legacy rollout or compaction", async () => {
    const fx = await setupRepo();
    const priorMailboxRoot = process.env.SIFT_SESSION_MAILBOX_ROOT;
    const priorCompaction = process.env.SIFT_CONTEXT_COMPACTION;
    const rootDir = join(fx.worktreesRoot, "..", "session-mailbox");
    process.env.SIFT_SESSION_MAILBOX_ROOT = rootDir;
    process.env.SIFT_CONTEXT_COMPACTION = "0";
    try {
      const controller = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});
      const child = controller.spawnChild({
        title: "mailbox",
        accessMode: "read_write",
        writeScope: ["shared.txt"],
        cwd: fx.repoRoot,
      });
      expect(child.ok).toBe(true);
      if (!child.ok) return;
      await writeFile(join(child.session.worktreePath, "shared.txt"), "L1\nCHILD\n", "utf8");
      controller.commitChild(child.session.sessionId, "child edits shared");
      await fx.write("shared.txt", "L1\nMAIN\n");
      fx.run(["commit", "-am", "base moves shared"]);
      controller.reviewChild(child.session.sessionId);
      expect(getMergeMasterSession(child.session.sessionId)?.status).toBe("merge_blocked");

      const result = controller.sendBackChild(
        child.session.sessionId,
        "  rebase and resolve shared.txt  ",
      );

      expect(result).toEqual({
        ok: true,
        posted: true,
        durability: "durable",
        conversationKey: child.session.conversationKey,
      });
      const pending = listPendingSessionInstructions(child.session.conversationKey, {rootDir});
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        sessionId: sessionJournalIdForConversation(child.session.conversationKey),
        instruction: "rebase and resolve shared.txt",
      });
    } finally {
      if (priorMailboxRoot === undefined) delete process.env.SIFT_SESSION_MAILBOX_ROOT;
      else process.env.SIFT_SESSION_MAILBOX_ROOT = priorMailboxRoot;
      if (priorCompaction === undefined) delete process.env.SIFT_CONTEXT_COMPACTION;
      else process.env.SIFT_CONTEXT_COMPACTION = priorCompaction;
      await fx.cleanup();
    }
  });

  it("sendBackChild: restores the reviewed state when durable enqueue fails", async () => {
    const fx = await setupRepo();
    try {
      const controller = createChildSessionController({
        runner: git,
        worktreesRoot: fx.worktreesRoot,
        postToThread: () => ({status: "failed"}),
      });
      const child = controller.spawnChild({
        title: "mailbox-failure",
        accessMode: "read_write",
        writeScope: ["shared.txt"],
        cwd: fx.repoRoot,
      });
      expect(child.ok).toBe(true);
      if (!child.ok) return;
      await writeFile(join(child.session.worktreePath, "shared.txt"), "L1\nCHILD\n", "utf8");
      controller.commitChild(child.session.sessionId, "child edits shared");
      await fx.write("shared.txt", "L1\nMAIN\n");
      fx.run(["commit", "-am", "base moves shared"]);
      controller.reviewChild(child.session.sessionId);
      expect(getMergeMasterSession(child.session.sessionId)?.status).toBe("merge_blocked");

      const result = controller.sendBackChild(child.session.sessionId, "retry safely");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected durable enqueue to fail");
      expect(result.reason).toMatch(/could not durably enqueue.*status restored/i);
      expect(getMergeMasterSession(child.session.sessionId)?.status).toBe("merge_blocked");
    } finally {
      await fx.cleanup();
    }
  });

  it("sendBackChild: keeps running when publication durability is indeterminate", async () => {
    const fx = await setupRepo();
    try {
      const controller = createChildSessionController({
        runner: git,
        worktreesRoot: fx.worktreesRoot,
        postToThread: () => ({status: "indeterminate"}),
      });
      const child = controller.spawnChild({
        title: "mailbox-indeterminate",
        accessMode: "read_write",
        writeScope: ["shared.txt"],
        cwd: fx.repoRoot,
      });
      expect(child.ok).toBe(true);
      if (!child.ok) return;
      await writeFile(join(child.session.worktreePath, "shared.txt"), "L1\nCHILD\n", "utf8");
      controller.commitChild(child.session.sessionId, "child edits shared");
      await fx.write("shared.txt", "L1\nMAIN\n");
      fx.run(["commit", "-am", "base moves shared"]);
      controller.reviewChild(child.session.sessionId);
      expect(getMergeMasterSession(child.session.sessionId)?.status).toBe("merge_blocked");

      const result = controller.sendBackChild(child.session.sessionId, "retry safely");

      expect(result).toEqual({
        ok: true,
        posted: true,
        durability: "indeterminate",
        conversationKey: child.session.conversationKey,
      });
      expect(getMergeMasterSession(child.session.sessionId)?.status).toBe("running");
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
      await controller.reviewChild(c.session.sessionId); // → ready_to_merge

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

describe("contracted work-run restart recovery", () => {
  function clientFor(counts: {
    claims: number;
    starts: Array<{id: string; owner?: string; token?: string}>;
  }): WorkRunClient {
    return {
      async getWorkItem(id) {
        return {
          statusCode: 200,
          data: {workItem: {
            id,
            title: "recover exact work",
            revision: 1,
            orgId: null,
            projectId: null,
            taskId: null,
            contractSummary: {classification: "bounded", profile: "coding", version: 1},
            writeScope: {include: ["shared.txt"], exclude: ["dist/**"]},
          }},
        };
      },
      async getWorkVerificationPlan(id) {
        return {statusCode: 200, data: {plan: {id: "plan-recovery", workItemId: id, version: 4, state: "active"}}};
      },
      async claimWorkItem(input) {
        counts.claims++;
        return {statusCode: 200, data: {workItem: {
          id: input.workItemId,
          title: "recover exact work",
          revision: 1,
          orgId: null,
          projectId: null,
          taskId: null,
          contractSummary: {classification: "bounded", profile: "coding", version: 1},
          writeScope: {include: ["shared.txt"], exclude: ["dist/**"]},
          claimToken: "opaque-recovery-token",
        }}};
      },
      async transitionWorkItem(id, action, input) {
        if (action === "start") counts.starts.push({id, owner: input.claimOwner, token: input.claimToken});
        return {statusCode: 200, data: {workItem: {id, status: action === "release" ? "queued" : "running"}}};
      },
    };
  }

  it("re-associates a started run with the same work identity and no second claim or worktree", async () => {
    const fx = await setupRepo();
    let freshRun: ReturnType<typeof createWorkRunController> | undefined;
    try {
      const counts = {claims: 0, starts: [] as Array<{id: string; owner?: string; token?: string}>};
      const store = createChildSessionStore({root: join(fx.worktreesRoot, "recovery")});
      const firstController = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});
      const firstRun = createWorkRunController({
        client: clientFor(counts),
        childController: firstController,
        store,
        cwd: fx.repoRoot,
        ownerFactory: () => "opaque-recovery-owner",
      });
      const started = await firstRun.startContractedWork("work-recovery");
      expect(started.ok).toBe(true);
      expect(counts.claims).toBe(1);
      expect(counts.starts).toHaveLength(1);
      expect(listChildWorktrees(fx.repoRoot, git)).toHaveLength(1);
      await firstRun.shutdown({preserveRuns: true});

      resetMergeMasterForTests();
      const freshController = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});
      freshRun = createWorkRunController({
        client: clientFor(counts),
        childController: freshController,
        store,
        cwd: fx.repoRoot,
      });
      const recovered = await freshRun.recoverWorkRuns();

      expect(recovered.failed).toEqual([]);
      expect(recovered.recovered).toHaveLength(1);
      expect(recovered.recovered[0].work.workItemId).toBe("work-recovery");
      expect(recovered.recovered[0].work.plan).toEqual({
        planId: "plan-recovery",
        planVersion: 4,
        state: "active",
      });
      expect(counts.claims).toBe(1);
      expect(counts.starts).toHaveLength(1);
      expect(listChildWorktrees(fx.repoRoot, git)).toHaveLength(1);
      expect(getMergeMasterSession(recovered.recovered[0].session.sessionId)?.work).toEqual(
        recovered.recovered[0].work,
      );
    } finally {
      try {
        await freshRun?.shutdown({preserveRuns: true});
      } finally {
        await fx.cleanup();
      }
    }
  });

  it("adopts a spawned run before retrying start with the stored exact lease", async () => {
    const fx = await setupRepo();
    let recoveryRun: ReturnType<typeof createWorkRunController> | undefined;
    try {
      const counts = {claims: 0, starts: [] as Array<{id: string; owner?: string; token?: string}>};
      const store = createChildSessionStore({root: join(fx.worktreesRoot, "recovery")});
      const firstController = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});
      const firstRun = createWorkRunController({
        client: clientFor(counts),
        childController: firstController,
        store,
        cwd: fx.repoRoot,
        ownerFactory: () => "opaque-recovery-owner",
      });
      expect((await firstRun.startContractedWork("work-recovery")).ok).toBe(true);
      const persisted = (await store.loadAll()).records[0];
      counts.starts.length = 0;
      await firstRun.shutdown({preserveRuns: true});
      await store.put({...persisted, phase: "spawned"});

      resetMergeMasterForTests();
      const freshController = createChildSessionController({runner: git, worktreesRoot: fx.worktreesRoot});
      recoveryRun = createWorkRunController({
        client: clientFor(counts),
        childController: freshController,
        store,
        cwd: fx.repoRoot,
      });
      const recovered = await recoveryRun.recoverWorkRuns();

      expect(recovered.failed).toEqual([]);
      expect(recovered.recovered[0].phase).toBe("started");
      expect(counts.claims).toBe(1);
      expect(counts.starts).toEqual([{
        id: "work-recovery",
        owner: "opaque-recovery-owner",
        token: "opaque-recovery-token",
      }]);
      expect(listChildWorktrees(fx.repoRoot, git)).toHaveLength(1);
      expect((await store.loadAll()).records[0].phase).toBe("started");
    } finally {
      try {
        await recoveryRun?.shutdown({preserveRuns: true});
      } finally {
        await fx.cleanup();
      }
    }
  });
});

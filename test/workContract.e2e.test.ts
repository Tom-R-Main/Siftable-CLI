import {existsSync} from "node:fs";
import {mkdir, mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createChildSessionController} from "../interactive-tui/childSessionController";
import {createChildSessionStore} from "../interactive-tui/childSessionStore";
import {
  getMergeMasterSession,
  resetMergeMasterForTests,
  transitionSessionStatus,
  type MergeMasterWorkIdentity,
} from "../interactive-tui/mergeMaster";
import {createWorkRunController, type WorkRunClient} from "../interactive-tui/workRunController";
import type {WorkProofClient} from "../interactive-tui/workProof";
import {
  createGitRunner,
  resolveCommit,
  resolveRepoRoot,
  type GitRunner,
} from "../interactive-tui/worktreeService";

const git: GitRunner = createGitRunner();

const identity: MergeMasterWorkIdentity = {
  workItemId: "work-contract-06",
  title: "Land bounded Work Contract V1",
  revision: 7,
  orgId: null,
  projectId: "project-06",
  taskId: null,
  contract: {classification: "bounded", profile: "coding", version: 1},
  plan: {planId: "plan-06", planVersion: 3, state: "active"},
  writeScope: {include: ["allowed.ts"], exclude: ["dist/**"]},
};

async function setupRepo() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sift-work-contract-")));
  const repoRoot = join(root, "repo");
  const worktreesRoot = join(root, "worktrees");
  const sessionsRoot = join(root, "sessions");
  await mkdir(repoRoot, {recursive: true});
  await mkdir(worktreesRoot, {recursive: true});
  const run = (args: string[], cwd = repoRoot): string => {
    const result = git(args, cwd);
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.spawnError}`);
    return result.stdout.trim();
  };
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@siftable.io"]);
  run(["config", "user.name", "Sift Test"]);
  run(["config", "commit.gpgsign", "false"]);
  await writeFile(join(repoRoot, "README.md"), "base\n", "utf8");
  run(["add", "."]);
  run(["commit", "-m", "initial"]);
  return {
    root,
    repoRoot: resolveRepoRoot(repoRoot, git),
    worktreesRoot,
    sessionsRoot,
    run,
    baseTip: () => run(["rev-parse", "main"]),
    cleanup: () => rm(root, {recursive: true, force: true}),
  };
}

type ProofScenario = {
  work?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  coverage?: Record<string, unknown>;
  attempt?: Record<string, unknown>;
  duplicate?: boolean;
  malformedStep?: boolean;
  failLoad?: boolean;
  onProofLoad?: () => Promise<void> | void;
};

function proofClient(
  work: MergeMasterWorkIdentity,
  head: () => string,
  scenario: ProofScenario = {},
): WorkProofClient {
  const attempt = (stepId: string, ordinal: number) => ({
    workItemId: work.workItemId,
    planId: work.plan.planId,
    planVersion: work.plan.planVersion,
    stepId,
    attemptId: `attempt-${ordinal}`,
    outcome: "passed",
    exitCode: 0,
    environmentLabel: "workspace",
    ranAt: "2026-08-26T00:00:00.000Z",
    output: null,
    artifactRefs: [],
    provenance: {siftReadyProofV1: {headCommit: head()}},
    ...scenario.attempt,
  });
  const entry = (stepId: string, key: string, ordinal: number) => ({
    step: scenario.malformedStep
      ? {required: true, planId: work.plan.planId, workItemId: work.workItemId, planVersion: work.plan.planVersion}
      : {
          id: stepId,
          key,
          title: key,
          kind: "shell",
          ordinal,
          required: true,
          planId: work.plan.planId,
          workItemId: work.workItemId,
          planVersion: work.plan.planVersion,
        },
    latestAttempt: attempt(stepId, ordinal),
  });
  return {
    async getWorkItem() {
      await scenario.onProofLoad?.();
      if (scenario.failLoad) return {statusCode: 503, error: "unavailable"};
      return {statusCode: 200, data: {workItem: {
        id: work.workItemId,
        title: work.title,
        revision: work.revision,
        orgId: work.orgId,
        projectId: work.projectId,
        taskId: work.taskId,
        task: {status: "done"},
        status: "needs_review",
        verificationState: "commands_passed",
        contractSummary: work.contract,
        writeScope: work.writeScope,
        acceptanceCriteria: [{text: "commands pass", met: true}],
        ...scenario.work,
      }}};
    },
    async getWorkVerificationPlan() {
      const steps = scenario.duplicate
        ? [entry("step-1", "test", 1), entry("step-1", "test", 1)]
        : [entry("step-1", "test", 1)];
      return {statusCode: 200, data: {plan: {
        id: work.plan.planId,
        workItemId: work.workItemId,
        version: work.plan.planVersion,
        state: "active",
        coverage: {
          state: "commands_passed",
          required: scenario.duplicate ? 2 : 1,
          covered: scenario.duplicate ? 2 : 1,
          passed: scenario.duplicate ? 2 : 1,
          missingStepIds: [],
          failedStepIds: [],
          steps,
          ...scenario.coverage,
        },
        ...scenario.plan,
      }}};
    },
    async listWorkItemVerifierRuns() {
      return {statusCode: 200, data: {runs: []}};
    },
  };
}

async function spawnCommitted(
  fx: Awaited<ReturnType<typeof setupRepo>>,
  work: MergeMasterWorkIdentity | undefined,
  scenario: ProofScenario = {},
  policy = "enforce",
  runner: GitRunner = git,
  enableProof = true,
) {
  let head = () => fx.baseTip();
  const client = proofClient(work ?? identity, () => head(), scenario);
  const controller = createChildSessionController({
    runner,
    worktreesRoot: fx.worktreesRoot,
    readyProof: enableProof ? {client, env: {SIFT_READY_PROOF_POLICY: policy}} : undefined,
  });
  const spawned = controller.spawnChild({
    title: work?.title ?? "manual session",
    accessMode: "read_write",
    writeScope: work?.writeScope.include ?? ["allowed.ts"],
    cwd: fx.repoRoot,
    work,
  });
  if (!spawned.ok) throw new Error("reason" in spawned ? spawned.reason : "child spawn failed");
  await writeFile(join(spawned.session.worktreePath, "allowed.ts"), "export const allowed = true;\n", "utf8");
  const committed = controller.commitChild(spawned.session.sessionId, "bounded work");
  if (!committed.ok) throw new Error(committed.reason);
  head = () => resolveCommit(fx.repoRoot, spawned.session.branch, runner);
  return {controller, session: spawned.session, client};
}

function countingRunner(): {runner: GitRunner; count: () => number} {
  let calls = 0;
  return {
    runner: (args, cwd) => {
      calls += 1;
      return git(args, cwd);
    },
    count: () => calls,
  };
}

beforeEach(() => resetMergeMasterForTests());
afterEach(() => resetMergeMasterForTests());

describe("Work Contract V1 golden landing", () => {
  it("claims exact V1 identity, proves the current head, reaches needs_review, and lands exactly once", async () => {
    const fx = await setupRepo();
    let workRun: ReturnType<typeof createWorkRunController> | undefined;
    try {
      let childHead = fx.baseTip();
      let proofState = false;
      const claims: Array<Record<string, unknown>> = [];
      const proof = proofClient(identity, () => childHead, {
        work: {status: "needs_review", verificationState: "commands_passed"},
      });
      const client: WorkRunClient & WorkProofClient = {
        ...proof,
        async getWorkItem(id) {
          const response = await proof.getWorkItem(id);
          if (!proofState && response.data && typeof response.data === "object") {
            const item = (response.data as {workItem: Record<string, unknown>}).workItem;
            item.status = "queued";
            item.verificationState = "unverified";
          }
          return response;
        },
        async claimWorkItem(input) {
          claims.push(input);
          return {statusCode: 200, data: {workItem: {
            id: identity.workItemId,
            title: identity.title,
            revision: identity.revision,
            orgId: identity.orgId,
            projectId: identity.projectId,
            taskId: identity.taskId,
            contractSummary: identity.contract,
            writeScope: identity.writeScope,
            claimToken: "opaque-claim",
          }}};
        },
        async transitionWorkItem(id, action) {
          return {statusCode: 200, data: {workItem: {id, status: action === "release" ? "queued" : "running"}}};
        },
      };
      const childController = createChildSessionController({
        runner: git,
        worktreesRoot: fx.worktreesRoot,
        readyProof: {client, env: {SIFT_READY_PROOF_POLICY: "enforce"}},
      });
      workRun = createWorkRunController({
        client,
        childController,
        store: createChildSessionStore({root: fx.sessionsRoot}),
        cwd: fx.repoRoot,
        ownerFactory: () => "work-contract-owner",
        heartbeatIntervalMs: 60_000,
      });
      const started = await workRun.startContractedWork(identity.workItemId);
      if (!started.ok) throw new Error(JSON.stringify(started));
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(claims).toEqual([expect.objectContaining({
        workItemId: identity.workItemId,
        expectedRevision: identity.revision,
      })]);
      expect(started.run.work).toEqual(identity);
      expect(started.run.work.taskId).toBeNull();

      await writeFile(join(started.run.session.worktreePath, "allowed.ts"), "export const allowed = true;\n", "utf8");
      childController.commitChild(started.run.session.sessionId, "bounded work");
      childHead = resolveCommit(fx.repoRoot, started.run.session.branch, git);
      proofState = true;
      expect(childController.listMergeReadiness().rows[0]).toMatchObject({
        mergeEligibility: false,
        proofCode: "proof_receipt_missing",
      });
      const ready = await childController.reviewChild(started.run.session.sessionId);
      expect(ready).toMatchObject({
        ok: true,
        proofDecision: {allowed: true, code: "ready_proof_pass"},
        packet: {verdict: "ready_to_merge", headCommit: childHead},
      });
      expect(getMergeMasterSession(started.run.session.sessionId)?.status).toBe("ready_to_merge");

      const before = fx.baseTip();
      const [first, duplicate] = await Promise.all([
        childController.mergeChild(started.run.session.sessionId),
        childController.mergeChild(started.run.session.sessionId),
      ]);
      expect([first, duplicate].filter((result) => result.ok)).toHaveLength(1);
      expect(fx.run(["rev-list", "--count", `${before}..main`])).toBe("1");
      expect(fx.run(["show", "main:allowed.ts"])).toBe("export const allowed = true;");
      expect(existsSync(started.run.session.worktreePath)).toBe(false);
    } finally {
      await workRun?.shutdown({preserveRuns: true});
      await fx.cleanup();
    }
  });
});

describe("Work Contract V1 enforce negatives", () => {
  it("classifies incomplete enforce identities before dashboard receipt state", async () => {
    const fx = await setupRepo();
    try {
      const incomplete = {...identity, revision: undefined};
      const {controller} = await spawnCommitted(fx, incomplete);
      expect(controller.listMergeReadiness().rows[0]).toMatchObject({
        mergeEligibility: false,
        proofCode: "identity_incomplete",
      });
    } finally {
      await fx.cleanup();
    }
  });

  it("does not retain a proof receipt when the ready transition is refused", async () => {
    const fx = await setupRepo();
    const scenario: ProofScenario = {};
    try {
      const {controller, session} = await spawnCommitted(fx, identity, scenario);
      scenario.onProofLoad = () => {
        expect(transitionSessionStatus(session.sessionId, "needs_input")).toBe(0);
      };
      expect(await controller.reviewChild(session.sessionId)).toMatchObject({
        ok: true,
        statusApplied: false,
        proofDecision: {allowed: true, code: "ready_proof_pass"},
      });
      expect(getMergeMasterSession(session.sessionId)?.status).toBe("needs_input");
      expect(controller.listMergeReadiness().rows[0]).toMatchObject({
        mergeEligibility: false,
        proofCode: "proof_receipt_missing",
      });
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps the synchronous dashboard network-free and distinguishes missing and stale receipts", async () => {
    const fx = await setupRepo();
    let proofLoads = 0;
    try {
      const {controller, session} = await spawnCommitted(fx, identity, {
        onProofLoad: () => { proofLoads += 1; },
      });

      expect(controller.listMergeReadiness().rows[0]).toMatchObject({
        mergeEligibility: false,
        proofCode: "proof_receipt_missing",
      });
      expect(proofLoads).toBe(0);

      expect(await controller.reviewChild(session.sessionId)).toMatchObject({
        ok: true,
        proofDecision: {allowed: true, code: "ready_proof_pass"},
      });
      expect(controller.listMergeReadiness().rows[0]).toMatchObject({
        mergeEligibility: true,
        proofCode: "ready_proof_pass",
      });
      expect(proofLoads).toBe(1);

      await writeFile(join(fx.repoRoot, "README.md"), "base moved\n", "utf8");
      fx.run(["commit", "-am", "move base after receipt"]);
      expect(controller.listMergeReadiness().rows[0]).toMatchObject({
        mergeEligibility: false,
        proofCode: "proof_receipt_stale",
      });
      expect(proofLoads).toBe(1);
    } finally {
      await fx.cleanup();
    }
  });

  it("rechecks the live session status after asynchronous proof loading before landing", async () => {
    const fx = await setupRepo();
    const scenario: ProofScenario = {};
    try {
      const {controller, session} = await spawnCommitted(fx, identity, scenario);
      expect(await controller.reviewChild(session.sessionId)).toMatchObject({
        ok: true,
        proofDecision: {allowed: true, code: "ready_proof_pass"},
      });
      expect(getMergeMasterSession(session.sessionId)?.status).toBe("ready_to_merge");

      scenario.onProofLoad = () => {
        expect(controller.rejectChild(session.sessionId, "review revoked")).toEqual({ok: true});
      };
      const before = fx.baseTip();
      expect(await controller.mergeChild(session.sessionId)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("is rejected"),
      });
      expect(getMergeMasterSession(session.sessionId)?.status).toBe("rejected");
      expect(fx.baseTip()).toBe(before);
    } finally {
      await fx.cleanup();
    }
  });

  it.each([
    ["task status cannot rescue invalid work", {work: {status: "running", task: {status: "done"}}}, "work_status_invalid"],
    ["zero evidence", {coverage: {required: 0, covered: 0, passed: 0, steps: []}}, "coverage_invalid"],
    ["malformed evidence", {malformedStep: true}, "proof_load_failed"],
    ["duplicate evidence", {duplicate: true}, "coverage_duplicate"],
    ["stale evidence", {attempt: {provenance: {siftReadyProofV1: {headCommit: "d".repeat(40)}}}}, "attempt_stale"],
    ["failed evidence", {attempt: {outcome: "failed", exitCode: 1}}, "attempt_invalid"],
    ["revision mismatch", {work: {revision: identity.revision + 1}}, "identity_mismatch"],
    ["namespace mismatch", {work: {projectId: "other-project"}}, "identity_mismatch"],
    ["plan mismatch", {plan: {version: identity.plan.planVersion + 1}}, "identity_mismatch"],
    ["proof load failure", {failLoad: true}, "proof_load_failed"],
  ] as const)("blocks %s without mutating the base", async (_name, scenario, code) => {
    const fx = await setupRepo();
    try {
      const {controller, session} = await spawnCommitted(fx, identity, scenario);
      const before = fx.baseTip();
      const ready = await controller.reviewChild(session.sessionId);
      expect(ready).toMatchObject({ok: true, proofDecision: {allowed: false, code}});
      expect(await controller.mergeChild(session.sessionId)).toMatchObject({ok: false});
      expect(fx.baseTip()).toBe(before);
      expect(fx.run(["rev-list", "--count", `${before}..main`])).toBe("0");
    } finally {
      await fx.cleanup();
    }
  });

  it("blocks unlinked manual write sessions and all incomplete legacy-contract escape shapes", async () => {
    const cases: Array<MergeMasterWorkIdentity | undefined> = [
      undefined,
      {...identity, contract: {...identity.contract, version: undefined}},
      {...identity, contract: {...identity.contract, version: 2}},
      {...identity, contract: {...identity.contract, classification: "legacy" as "bounded"}},
      {...identity, revision: undefined},
      {...identity, orgId: undefined},
    ];
    for (const work of cases) {
      resetMergeMasterForTests();
      const fx = await setupRepo();
      try {
        const {controller, session} = await spawnCommitted(fx, work);
        const before = fx.baseTip();
        const ready = await controller.reviewChild(session.sessionId);
        expect(ready).toMatchObject({ok: true, proofDecision: {allowed: false}});
        expect(await controller.mergeChild(session.sessionId)).toMatchObject({ok: false});
        expect(fx.baseTip()).toBe(before);
      } finally {
        await fx.cleanup();
      }
    }
  });

  it("blocks Git out-of-scope, behind-base, unknown-policy, head-drift, and moved-base paths", async () => {
    const fx = await setupRepo();
    try {
      const out = await spawnCommitted(fx, {...identity, writeScope: {include: ["other.ts"], exclude: []}});
      const beforeOut = fx.baseTip();
      expect(await out.controller.reviewChild(out.session.sessionId)).toMatchObject({
        ok: true,
        packet: {verdict: "merge_blocked"},
      });
      expect(fx.baseTip()).toBe(beforeOut);
    } finally {
      await fx.cleanup();
    }

    for (const mode of ["behind", "unknown", "head-drift", "base-drift"] as const) {
      resetMergeMasterForTests();
      const local = await setupRepo();
      try {
        let loaded = false;
        const scenario: ProofScenario = {};
        if (mode === "head-drift") scenario.onProofLoad = async () => {
          if (loaded) return;
          loaded = true;
        };
        const policy = mode === "unknown" ? "future" : "enforce";
        const spawned = await spawnCommitted(local, identity, scenario, policy);
        if (mode === "behind") {
          await writeFile(join(local.repoRoot, "README.md"), "base moved\n", "utf8");
          local.run(["commit", "-am", "move base"]);
        }
        if (mode === "head-drift") {
          scenario.onProofLoad = async () => {
            if (loaded) return;
            loaded = true;
            await writeFile(join(spawned.session.worktreePath, "allowed.ts"), "export const allowed = 2;\n", "utf8");
            spawned.controller.commitChild(spawned.session.sessionId, "move head");
          };
        }
        if (mode === "base-drift") {
          scenario.onProofLoad = async () => {
            if (loaded) return;
            loaded = true;
            await writeFile(join(local.repoRoot, "README.md"), "base moved during proof\n", "utf8");
            local.run(["commit", "-am", "move base during proof"]);
          };
        }
        const baseBeforeReview = local.baseTip();
        const ready = await spawned.controller.reviewChild(spawned.session.sessionId);
        const expected = mode === "unknown"
          ? "ready_proof_config_invalid"
          : mode === "behind" ? "base_not_contained" : mode === "head-drift" ? "head_drift" : "base_drift";
        expect(ready).toMatchObject({ok: true, proofDecision: {allowed: false, code: expected}});
        const baseBeforeLandingAttempt = local.baseTip();
        expect(await spawned.controller.mergeChild(spawned.session.sessionId)).toMatchObject({ok: false});
        expect(local.baseTip()).toBe(baseBeforeLandingAttempt);
        if (mode !== "base-drift") expect(local.baseTip()).toBe(baseBeforeReview);
        const mergeCommitCount = local.run(["log", "--format=%s", "main"])
          .split("\n")
          .filter((subject) => /^sift: merge child/.test(subject))
          .length;
        expect(mergeCommitCount).toBe(0);
      } finally {
        await local.cleanup();
      }
    }
  });
});

describe("Work Contract V1 warn observations", () => {
  it("keeps off exactly on the legacy single-snapshot path with zero proof calls", async () => {
    const offRepo = await setupRepo();
    const legacyRepo = await setupRepo();
    try {
      let proofLoads = 0;
      const offGit = countingRunner();
      const off = await spawnCommitted(offRepo, identity, {
        onProofLoad: () => { proofLoads += 1; },
      }, "off", offGit.runner);
      const offBefore = offGit.count();
      const offReady = await off.controller.reviewChild(off.session.sessionId);
      const offCalls = offGit.count() - offBefore;

      resetMergeMasterForTests();
      const legacyGit = countingRunner();
      const legacy = await spawnCommitted(legacyRepo, identity, {}, "off", legacyGit.runner, false);
      const legacyBefore = legacyGit.count();
      const legacyReady = await legacy.controller.reviewChild(legacy.session.sessionId);
      const legacyCalls = legacyGit.count() - legacyBefore;

      expect(proofLoads).toBe(0);
      expect(offCalls).toBe(legacyCalls);
      expect(offReady).toMatchObject({
        ok: true,
        packet: {verdict: "ready_to_merge"},
      });
      expect(offReady).not.toHaveProperty("proofDecision");
      expect(legacyReady).toMatchObject({ok: true, packet: {verdict: "ready_to_merge"}});
    } finally {
      await offRepo.cleanup();
      await legacyRepo.cleanup();
    }
  });

  it("keeps off rebase exactly on the synchronous legacy path with zero proof calls", async () => {
    const offRepo = await setupRepo();
    const legacyRepo = await setupRepo();
    try {
      let proofLoads = 0;
      const offGit = countingRunner();
      const off = await spawnCommitted(offRepo, identity, {
        onProofLoad: () => { proofLoads += 1; },
      }, "off", offGit.runner);
      await writeFile(join(offRepo.repoRoot, "README.md"), "base moved\n", "utf8");
      offRepo.run(["commit", "-am", "move base"]);
      const offBefore = offGit.count();
      const offResult = off.controller.rebaseChild(off.session.sessionId);
      expect(offResult).not.toBeInstanceOf(Promise);
      const offCalls = offGit.count() - offBefore;
      const offStatus = getMergeMasterSession(off.session.sessionId)?.status;

      resetMergeMasterForTests();
      const legacyGit = countingRunner();
      const legacy = await spawnCommitted(legacyRepo, identity, {}, "off", legacyGit.runner, false);
      await writeFile(join(legacyRepo.repoRoot, "README.md"), "base moved\n", "utf8");
      legacyRepo.run(["commit", "-am", "move base"]);
      const legacyBefore = legacyGit.count();
      const legacyResult = legacy.controller.rebaseChild(legacy.session.sessionId);
      expect(legacyResult).not.toBeInstanceOf(Promise);
      const legacyCalls = legacyGit.count() - legacyBefore;

      expect(proofLoads).toBe(0);
      expect(offCalls).toBe(legacyCalls);
      expect(offResult).toMatchObject({ok: true, rebased: true, verdict: "ready_to_merge"});
      expect(legacyResult).toMatchObject({ok: true, rebased: true, verdict: "ready_to_merge"});
      expect(offStatus).toBe("ready_to_merge");
      expect(getMergeMasterSession(legacy.session.sessionId)?.status).toBe("ready_to_merge");
    } finally {
      await offRepo.cleanup();
      await legacyRepo.cleanup();
    }
  });

  it("reports the actionable Git blocker when warn-mode proof allows landing", async () => {
    const fx = await setupRepo();
    try {
      const work = {...identity, writeScope: {include: ["other.ts"], exclude: []}};
      const spawned = await spawnCommitted(fx, work, {}, "warn");

      expect(await spawned.controller.reviewChild(spawned.session.sessionId)).toMatchObject({
        ok: true,
        packet: {
          verdict: "merge_blocked",
          blockers: [expect.stringContaining("wrote outside declared scope")],
        },
        proofDecision: {policy: "warn", allowed: true, code: "proof_warn"},
      });
      const landed = await spawned.controller.mergeChild(spawned.session.sessionId);
      expect(landed).toMatchObject({
        ok: false,
        reason: expect.stringContaining("wrote outside declared scope"),
      });
      if (landed.ok === false) expect(landed.reason).not.toContain("proof_warn");
    } finally {
      await fx.cleanup();
    }
  });

  it.each(["head-drift", "base-drift"] as const)("preserves the Git outcome and reports %s", async (mode) => {
    const fx = await setupRepo();
    const scenario: ProofScenario = {};
    let loaded = false;
    try {
      const spawned = await spawnCommitted(fx, identity, scenario, "warn");
      const proofHead = resolveCommit(fx.repoRoot, spawned.session.branch, git);
      const proofBase = fx.baseTip();
      scenario.onProofLoad = async () => {
        if (loaded) return;
        loaded = true;
        if (mode === "head-drift") {
          await writeFile(join(spawned.session.worktreePath, "allowed.ts"), "export const allowed = 2;\n", "utf8");
          spawned.controller.commitChild(spawned.session.sessionId, "move head during warn proof");
        } else {
          await writeFile(join(fx.repoRoot, "README.md"), "base moved during warn proof\n", "utf8");
          fx.run(["commit", "-am", "move base during warn proof"]);
        }
      };

      const ready = await spawned.controller.reviewChild(spawned.session.sessionId);
      expect(ready).toMatchObject({
        ok: true,
        proofDecision: {
          policy: "warn",
          allowed: true,
          code: "proof_warn",
          advisoryCode: mode === "head-drift" ? "head_drift" : "base_drift",
        },
        proofPacket: {version: 1},
      });
      if (!ready.ok) return;
      expect(ready.packet.verdict).toBe("ready_to_merge");
      expect(ready.proofPacket?.merge).toMatchObject({headCommit: proofHead, baseTip: proofBase});
      if (mode === "head-drift") expect(ready.packet.headCommit).not.toBe(proofHead);
      else expect(ready.packet.baseTip).not.toBe(proofBase);
      expect(getMergeMasterSession(spawned.session.sessionId)?.status).toBe(ready.packet.verdict);
      const baseBeforeLanding = fx.baseTip();
      expect(await spawned.controller.mergeChild(spawned.session.sessionId, {keep: true})).toMatchObject({ok: true});
      expect(fx.baseTip()).not.toBe(baseBeforeLanding);
    } finally {
      await fx.cleanup();
    }
  });
});

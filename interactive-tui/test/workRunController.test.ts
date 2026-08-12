process.env.SIFT_NO_NATIVE = "1";

import {afterEach, beforeEach, describe, expect, it} from "bun:test";
import {mkdtemp, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {
  ChildSessionController,
  ChildSessionRecord,
  SpawnChildInput,
} from "../childSessionController";
import {
  createChildSessionStore,
  type ChildSessionRecoveryRecord,
  type ChildSessionStore,
} from "../childSessionStore";
import type {MergeMasterWorkIdentity} from "../mergeMaster";
import {
  createWorkRunController,
  type WorkRunClient,
} from "../workRunController";

const workItemId = "work-123";
const owner = "private-owner";
const token = "private-token";

function workResponse(overrides: Record<string, unknown> = {}) {
  return {
    statusCode: 200,
    data: {
      workItem: {
        id: workItemId,
        title: "authoritative title",
        contractSummary: {classification: "bounded", profile: "coding", version: 1},
        writeScope: {include: ["src/a.ts"], exclude: ["dist/**"]},
        ...overrides,
      },
    },
  };
}

function planResponse(overrides: Record<string, unknown> = {}) {
  return {
    statusCode: 200,
    data: {
      plan: {
        id: "plan-1",
        workItemId,
        version: 3,
        state: "active",
        ...overrides,
      },
    },
  };
}

function identity(): MergeMasterWorkIdentity {
  return {
    workItemId,
    title: "authoritative title",
    contract: {classification: "bounded", profile: "coding", version: 1},
    plan: {planId: "plan-1", planVersion: 3, state: "active"},
    writeScope: {include: ["src/a.ts"], exclude: ["dist/**"]},
  };
}

function launch(work = identity()) {
  return {
    repoRoot: "/repo",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    seed: work.workItemId,
    branch: "sift/work",
    worktreePath: "/worktrees/work",
    conversationKey: "child-key",
    accessMode: work.contract.profile === "coding" ? "read_write" as const : "read_only" as const,
    writeScope: [...work.writeScope.include],
  };
}

function session(work = identity()): ChildSessionRecord {
  return {
    sessionId: 2,
    parentSessionId: 1,
    title: work.title,
    repoRoot: "/repo",
    branch: "sift/work",
    baseBranch: "main",
    worktreePath: "/worktrees/work",
    sessionCwd: "/worktrees/work",
    baseCommit: "a".repeat(40),
    headCommit: "a".repeat(40),
    accessMode: work.contract.profile === "coding" ? "read_write" : "read_only",
    writeScope: [...work.writeScope.include],
    conversationKey: "child-key",
    work,
  };
}

function fakeClient(log: string[], options: {
  work?: ReturnType<typeof workResponse>;
  plan?: ReturnType<typeof planResponse>;
  claimFailure?: boolean;
  claimMalformed?: boolean;
  startMalformedOnce?: boolean;
  startFailure?: boolean;
  heartbeatFailure?: boolean;
  heartbeatHang?: boolean;
  heartbeatStatus?: string;
  releaseFailure?: boolean;
  releaseStatus?: string;
} = {}): WorkRunClient {
  let startCalls = 0;
  return {
    async getWorkItem(id) {
      log.push(`load:${id}`);
      return options.work ?? workResponse();
    },
    async getWorkVerificationPlan(id) {
      log.push(`plan:${id}`);
      return options.plan ?? planResponse();
    },
    async claimWorkItem(input) {
      log.push(`claim:${input.workItemId}`);
      if (options.claimFailure) return {statusCode: 409, error: "unavailable"};
      if (options.claimMalformed) {
        return {statusCode: 200, data: {workItem: {id: input.workItemId}}};
      }
      return {
        statusCode: 200,
        data: {workItem: {id: input.workItemId, claimToken: token}},
      };
    },
    async transitionWorkItem(id, action, input) {
      log.push(`${action}:${id}`);
      expect(input.claimOwner).toBe(owner);
      expect(input.claimToken).toBe(token);
      if (action === "start") startCalls++;
      if (action === "start" && options.startMalformedOnce && startCalls === 1) {
        return {statusCode: 200, data: {workItem: {id: "different-work-item"}}};
      }
      if (action === "start" && options.startFailure) {
        return {statusCode: 409, error: "start rejected"};
      }
      if (action === "heartbeat" && options.heartbeatFailure) {
        return {statusCode: 409, error: "heartbeat rejected"};
      }
      if (action === "heartbeat" && options.heartbeatHang) {
        return await new Promise<never>(() => {});
      }
      if (action === "release" && options.releaseFailure) {
        return {statusCode: 500, error: "release rejected"};
      }
      const status = action === "release"
        ? options.releaseStatus ?? "queued"
        : action === "heartbeat"
          ? options.heartbeatStatus ?? "running"
          : "running";
      return {statusCode: 200, data: {workItem: {id, status}}};
    },
  };
}

function fakeChildren(log: string[], options: {
  spawnFailure?: boolean;
  spawnCleanupFailure?: boolean;
  adoptFailure?: boolean;
  removeFailure?: boolean;
} = {}) {
  let current: ChildSessionRecord | undefined;
  const controller: Pick<
    ChildSessionController,
    "resolveLaunch" | "spawnOrAdoptChild" | "adoptChild" | "abandonChild" | "teardownChild"
  > = {
    resolveLaunch() {
      log.push("resolve-launch");
      return launch();
    },
    spawnOrAdoptChild(input: SpawnChildInput) {
      log.push("spawn");
      if (options.spawnCleanupFailure) {
        return {
          ok: false,
          reason: "registry failed",
          worktreeCleanupAttempted: true,
          cleanupFailure: "worktree removal failed",
        };
      }
      if (options.spawnFailure) return {ok: false, reason: "worktree failed"};
      current = session(input.work);
      return {ok: true, session: current};
    },
    adoptChild(record) {
      log.push("adopt");
      if (options.adoptFailure) return {ok: false, reason: "recorded worktree missing"};
      current = {...record, sessionId: record.sessionId + 100};
      return {ok: true, session: current};
    },
    abandonChild() {
      log.push("abandon");
      current = undefined;
      return {ok: true};
    },
    teardownChild() {
      log.push("remove");
      if (options.removeFailure) return {ok: false, reason: "remove failed"};
      current = undefined;
      return {ok: true};
    },
  };
  return {controller, current: () => current};
}

function loggingStore(store: ChildSessionStore, log: string[]): ChildSessionStore {
  return {
    ...store,
    async put(record) {
      log.push(`put:${record.phase}`);
      await store.put(record);
    },
    async remove(runId) {
      log.push("remove-metadata");
      await store.remove(runId);
    },
  };
}

let tempRoots: string[] = [];

beforeEach(() => {
  tempRoots = [];
});

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, {recursive: true, force: true})));
});

async function store(log?: string[]) {
  const root = await mkdtemp(join(tmpdir(), "sift-work-run-"));
  tempRoots.push(root);
  const actual = createChildSessionStore({root, now: () => 123});
  return {root, store: log ? loggingStore(actual, log) : actual};
}

describe("workRunController contracted orchestration", () => {
  it("admits, claims, persists, then starts the exact work item", async () => {
    const log: string[] = [];
    const stored = await store(log);
    const children = fakeChildren(log);
    let admitted: unknown;
    const controller = createWorkRunController({
      client: fakeClient(log),
      childController: children.controller,
      store: stored.store,
      cwd: "/repo",
      ownerFactory: () => owner,
      evaluateAdmission: (candidate) => {
        admitted = candidate;
        log.push("admit");
        return {admit: true};
      },
    });

    const result = await controller.startContractedWork(workItemId);

    expect(result.ok).toBe(true);
    expect(admitted).toEqual({accessMode: "read_write", writeScope: ["src/a.ts"]});
    expect(log).toEqual([
      `load:${workItemId}`,
      `plan:${workItemId}`,
      "admit",
      "resolve-launch",
      `claim:${workItemId}`,
      "spawn",
      "put:spawned",
      `start:${workItemId}`,
      "put:started",
    ]);
    expect(children.current()?.title).toBe("authoritative title");
    expect(children.current()?.work).toEqual(identity());
    expect(JSON.stringify(result)).not.toMatch(/private-owner|private-token|claimOwner|claimToken/);
    expect(JSON.stringify(await stored.store.listSafe())).not.toMatch(/private-owner|private-token|claimOwner|claimToken/);

    const runId = stored.store.runIdFor("/repo", workItemId);
    expect((await stat(stored.root)).mode & 0o077).toBe(0);
    expect((await stat(join(stored.root, `${runId}.json`))).mode & 0o177).toBe(0);
  });

  it("derives read_only and preserves exclude scope without feeding it to Gate A", async () => {
    const log: string[] = [];
    const stored = await store();
    const children = fakeChildren(log);
    let admitted: unknown;
    const controller = createWorkRunController({
      client: fakeClient(log, {
        work: workResponse({
          contractSummary: {classification: "bounded", profile: "read_only", version: 1},
          writeScope: {include: [], exclude: ["**"]},
        }),
      }),
      childController: children.controller,
      store: stored.store,
      ownerFactory: () => owner,
      evaluateAdmission: (candidate) => {
        admitted = candidate;
        return {admit: true};
      },
    });

    const result = await controller.startContractedWork(workItemId);
    expect(result.ok).toBe(true);
    expect(admitted).toEqual({accessMode: "read_only", writeScope: []});
    if (result.ok) expect(result.run.work.writeScope.exclude).toEqual(["**"]);
  });

  it("rejects legacy work and Gate-A conflicts before claim or spawn", async () => {
    const legacyLog: string[] = [];
    const stored = await store();
    const legacyChildren = fakeChildren(legacyLog);
    const legacy = createWorkRunController({
      client: fakeClient(legacyLog, {
        work: workResponse({contractSummary: {classification: "legacy"}}),
      }),
      childController: legacyChildren.controller,
      store: stored.store,
      ownerFactory: () => owner,
    });
    const legacyResult = await legacy.startContractedWork(workItemId);
    expect(legacyResult.ok).toBe(false);
    expect(legacyLog).toEqual([`load:${workItemId}`]);

    const gateLog: string[] = [];
    const gateChildren = fakeChildren(gateLog);
    const gate = createWorkRunController({
      client: fakeClient(gateLog),
      childController: gateChildren.controller,
      store: stored.store,
      ownerFactory: () => owner,
      evaluateAdmission: () => ({
        admit: false,
        conflictSessionId: 91,
        sharedScope: ["src/a.ts"],
        reason: "serialized",
      }),
    });
    const gateResult = await gate.startContractedWork(workItemId);
    expect(gateResult.ok).toBe(false);
    if (!gateResult.ok) {
      expect(gateResult.stage).toBe("admission");
      expect(gateResult.blockedBy).toBe(91);
      expect(gateResult.sharedScope).toEqual(["src/a.ts"]);
    }
    expect(gateLog).toEqual([`load:${workItemId}`, `plan:${workItemId}`]);
  });

  it("rejects an invalid contract version before plan, claim, or spawn", async () => {
    const log: string[] = [];
    const stored = await store();
    const controller = createWorkRunController({
      client: fakeClient(log, {
        work: workResponse({
          contractSummary: {classification: "bounded", profile: "coding", version: 0},
        }),
      }),
      childController: fakeChildren(log).controller,
      store: stored.store,
      ownerFactory: () => owner,
    });

    const result = await controller.startContractedWork(workItemId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("load_work_item");
    expect(log).toEqual([`load:${workItemId}`]);
  });

  it("does not stage a session when claim or worktree creation fails", async () => {
    const claimLog: string[] = [];
    const stored = await store();
    const claimChildren = fakeChildren(claimLog);
    const claim = createWorkRunController({
      client: fakeClient(claimLog, {claimFailure: true}),
      childController: claimChildren.controller,
      store: stored.store,
      ownerFactory: () => owner,
    });
    const claimResult = await claim.startContractedWork(workItemId);
    expect(claimResult.ok).toBe(false);
    expect(claimLog).not.toContain("spawn");

    const spawnLog: string[] = [];
    const spawnChildren = fakeChildren(spawnLog, {spawnFailure: true});
    const spawn = createWorkRunController({
      client: fakeClient(spawnLog),
      childController: spawnChildren.controller,
      store: stored.store,
      ownerFactory: () => owner,
    });
    const spawnResult = await spawn.startContractedWork(workItemId);
    expect(spawnResult.ok).toBe(false);
    if (!spawnResult.ok) expect(spawnResult.compensation.attempted).toEqual(["metadata", "lease"]);
    expect(spawnLog).toContain(`release:${workItemId}`);
  });

  it("fails closed on an unknown claim outcome without reissuing the claim", async () => {
    const log: string[] = [];
    const stored = await store();
    const children = fakeChildren(log);
    const controller = createWorkRunController({
      client: fakeClient(log, {claimMalformed: true}),
      childController: children.controller,
      store: stored.store,
      ownerFactory: () => owner,
    });

    const result = await controller.startContractedWork(workItemId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("claim");
    expect(log.filter((entry) => entry === `claim:${workItemId}`)).toHaveLength(1);
    expect(log).not.toContain("spawn");
  });

  it("confirms an ambiguous start with the exact lease before persisting started", async () => {
    const log: string[] = [];
    const stored = await store(log);
    const children = fakeChildren(log);
    const controller = createWorkRunController({
      client: fakeClient(log, {startMalformedOnce: true}),
      childController: children.controller,
      store: stored.store,
      ownerFactory: () => owner,
    });

    const result = await controller.startContractedWork(workItemId);

    expect(result.ok).toBe(true);
    expect(log).toContain(`start:${workItemId}`);
    expect(log).toContain(`heartbeat:${workItemId}`);
    expect(log.indexOf("put:started")).toBeGreaterThan(log.indexOf(`heartbeat:${workItemId}`));
  });

  it("does not treat a heartbeat without running state as start confirmation", async () => {
    const log: string[] = [];
    const stored = await store(log);
    const children = fakeChildren(log);
    const controller = createWorkRunController({
      client: fakeClient(log, {
        startMalformedOnce: true,
        heartbeatStatus: "claimed",
      }),
      childController: children.controller,
      store: stored.store,
      ownerFactory: () => owner,
    });

    const result = await controller.startContractedWork(workItemId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("start");
    expect(result.compensation.attempted).toEqual([]);
    expect(log).toContain(`heartbeat:${workItemId}`);
    expect(log).toContain("abandon");
    expect(log).not.toContain("put:started");
    expect((await stored.store.listSafe())[0].phase).toBe("quarantined");
  });

  it("retains the lease and recovery journal when post-register worktree cleanup fails", async () => {
    const log: string[] = [];
    const stored = await store();
    const children = fakeChildren(log, {spawnCleanupFailure: true});
    const controller = createWorkRunController({
      client: fakeClient(log),
      childController: children.controller,
      store: stored.store,
      ownerFactory: () => owner,
    });

    const result = await controller.startContractedWork(workItemId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("registry failed");
    expect(result.compensation.attempted).toEqual(["metadata", "worktree"]);
    expect(result.compensation.failures).toEqual([
      {step: "worktree", reason: "worktree removal failed"},
    ]);
    expect(log).not.toContain(`release:${workItemId}`);
    expect((await stored.store.listSafe())[0].phase).toBe("cleanup_pending");
  });

  it("compensates a start failure in reverse order with exact credentials", async () => {
    const log: string[] = [];
    const stored = await store(log);
    const children = fakeChildren(log);
    const controller = createWorkRunController({
      client: fakeClient(log, {startFailure: true, heartbeatFailure: true}),
      childController: children.controller,
      store: stored.store,
      ownerFactory: () => owner,
    });

    const result = await controller.startContractedWork(workItemId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("start");
    expect(result.reason).toContain("start work item failed");
    expect(result.compensation).toEqual({
      attempted: ["metadata", "worktree", "lease"],
      failures: [],
    });
    expect(log).toContain(`heartbeat:${workItemId}`);
    expect(log.indexOf("remove")).toBeLessThan(log.indexOf(`release:${workItemId}`));
    expect(log.indexOf(`release:${workItemId}`)).toBeLessThan(log.indexOf("remove-metadata"));
    expect(await stored.store.listSafe()).toEqual([]);
    expect(children.current()).toBeUndefined();
  });

  it("removes possibly staged metadata, the worktree, and the lease when persistence fails", async () => {
    const log: string[] = [];
    const stored = await store();
    let putCalls = 0;
    const failingStore: ChildSessionStore = {
      ...stored.store,
      async put(record) {
        putCalls++;
        await stored.store.put(record);
        if (putCalls === 1) throw new Error("persist failed");
      },
      async remove(runId) {
        log.push("remove-metadata");
        await stored.store.remove(runId);
      },
    };
    const children = fakeChildren(log);
    const controller = createWorkRunController({
      client: fakeClient(log),
      childController: children.controller,
      store: failingStore,
      ownerFactory: () => owner,
    });

    const result = await controller.startContractedWork(workItemId);

    expect(putCalls).toBeGreaterThanOrEqual(4);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("persist");
    expect(result.compensation.attempted).toEqual(["metadata", "worktree", "lease"]);
    expect(log.indexOf("remove")).toBeLessThan(log.indexOf(`release:${workItemId}`));
    expect(log.indexOf(`release:${workItemId}`)).toBeLessThan(log.indexOf("remove-metadata"));
    expect(await stored.store.listSafe()).toEqual([]);
  });

  it("surfaces compensation failures without replacing the primary failure", async () => {
    const log: string[] = [];
    const stored = await store(log);
    const children = fakeChildren(log, {removeFailure: true});
    const controller = createWorkRunController({
      client: fakeClient(log, {
        startFailure: true,
        heartbeatFailure: true,
        releaseFailure: true,
      }),
      childController: children.controller,
      store: stored.store,
      ownerFactory: () => owner,
    });

    const result = await controller.startContractedWork(workItemId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("start work item failed");
    expect(result.compensation.failures.map((failure) => failure.step)).toEqual(["worktree"]);
    expect(log).not.toContain(`release:${workItemId}`);
    expect(JSON.stringify(result)).not.toMatch(/private-owner|private-token/);
  });

  it("does not discard a failed cleanup when release does not confirm queued", async () => {
    const log: string[] = [];
    const stored = await store(log);
    const controller = createWorkRunController({
      client: fakeClient(log, {
        startFailure: true,
        heartbeatFailure: true,
        releaseStatus: "running",
      }),
      childController: fakeChildren(log).controller,
      store: stored.store,
      ownerFactory: () => owner,
    });

    const result = await controller.startContractedWork(workItemId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.compensation.failures).toEqual([
      {step: "lease", reason: "release work item did not confirm queued"},
    ]);
  });

  it("refuses a second deterministic run before issuing another claim", async () => {
    const log: string[] = [];
    const stored = await store();
    const first = createWorkRunController({
      client: fakeClient(log),
      childController: fakeChildren(log).controller,
      store: stored.store,
      ownerFactory: () => owner,
    });
    expect((await first.startContractedWork(workItemId)).ok).toBe(true);
    await first.shutdown({preserveRuns: true});

    const second = createWorkRunController({
      client: fakeClient(log),
      childController: fakeChildren(log).controller,
      store: stored.store,
      ownerFactory: () => owner,
    });
    const result = await second.startContractedWork(workItemId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("already exists");
    expect(log.filter((entry) => entry === `claim:${workItemId}`)).toHaveLength(1);
    expect(log.filter((entry) => entry === "spawn")).toHaveLength(1);
  });

  it("heartbeats a started child for the lifetime of the controller", async () => {
    const log: string[] = [];
    const stored = await store();
    const controller = createWorkRunController({
      client: fakeClient(log),
      childController: fakeChildren(log).controller,
      store: stored.store,
      ownerFactory: () => owner,
      leaseSeconds: 2,
      heartbeatIntervalMs: 5,
      heartbeatTimeoutMs: 20,
    });
    expect((await controller.startContractedWork(workItemId)).ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(log.filter((entry) => entry === `heartbeat:${workItemId}`).length).toBeGreaterThan(0);
    await controller.shutdown({preserveRuns: true});
  });

  it("quarantines the child when a bounded heartbeat stalls past the remaining lease", async () => {
    const log: string[] = [];
    const stored = await store(log);
    let clock = 0;
    const controller = createWorkRunController({
      client: fakeClient(log, {heartbeatHang: true}),
      childController: fakeChildren(log).controller,
      store: stored.store,
      ownerFactory: () => owner,
      leaseSeconds: 2,
      heartbeatIntervalMs: 5,
      heartbeatTimeoutMs: 10,
      now: () => clock,
    });
    expect((await controller.startContractedWork(workItemId)).ok).toBe(true);
    clock = 1_500;

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(log).toContain("abandon");
    expect((await stored.store.listSafe())[0].phase).toBe("quarantined");
  });
});

describe("workRunController recovery", () => {
  it("resumes a claimed journal through the exact prepared child", async () => {
    const log: string[] = [];
    const stored = await store(log);
    await stored.store.put({
      runId: stored.store.runIdFor("/repo", workItemId),
      phase: "claimed",
      updatedAtMs: 0,
      work: identity(),
      launch: launch(),
      credentials: {claimOwner: owner, claimToken: token},
    });
    log.length = 0;
    const controller = createWorkRunController({
      client: fakeClient(log),
      childController: fakeChildren(log).controller,
      store: stored.store,
      ownerFactory: () => owner,
    });

    const result = await controller.recoverWorkRuns();

    expect(result.failed).toEqual([]);
    expect(result.recovered[0].phase).toBe("started");
    expect(log).toEqual(["spawn", "put:spawned", "put:spawned", `start:${workItemId}`, "put:started"]);
    await controller.shutdown({preserveRuns: true});
  });

  it("fences concurrent recovery while the active controller owns the run lock", async () => {
    const log: string[] = [];
    const stored = await store();
    const first = createWorkRunController({
      client: fakeClient(log),
      childController: fakeChildren(log).controller,
      store: stored.store,
      ownerFactory: () => owner,
    });
    expect((await first.startContractedWork(workItemId)).ok).toBe(true);
    const second = createWorkRunController({
      client: fakeClient(log),
      childController: fakeChildren(log).controller,
      store: stored.store,
      ownerFactory: () => owner,
    });

    const result = await second.recoverWorkRuns();

    expect(result.recovered).toEqual([]);
    expect(result.failed[0].reason).toContain("already owned");
    await first.shutdown({preserveRuns: true});
  });

  it("keeps cleanup pending until worktree teardown succeeds, then releases last", async () => {
    const log: string[] = [];
    const stored = await store(log);
    await stored.store.put({
      runId: stored.store.runIdFor("/repo", workItemId),
      phase: "cleanup_pending",
      updatedAtMs: 0,
      work: identity(),
      launch: launch(),
      session: session(),
      cleanup: {worktree: true, lease: true},
      credentials: {claimOwner: owner, claimToken: token},
    });
    log.length = 0;
    const blocked = createWorkRunController({
      client: fakeClient(log),
      childController: fakeChildren(log, {removeFailure: true}).controller,
      store: stored.store,
    });
    expect((await blocked.recoverWorkRuns()).failed).toHaveLength(1);
    expect(log).not.toContain(`release:${workItemId}`);
    expect((await stored.store.listSafe())[0].phase).toBe("cleanup_pending");

    log.length = 0;
    const resumed = createWorkRunController({
      client: fakeClient(log),
      childController: fakeChildren(log).controller,
      store: stored.store,
    });
    expect((await resumed.recoverWorkRuns()).failed).toEqual([]);
    expect(log.indexOf("remove")).toBeLessThan(log.indexOf(`release:${workItemId}`));
    expect(log.indexOf(`release:${workItemId}`)).toBeLessThan(log.indexOf("remove-metadata"));
    expect(await stored.store.listSafe()).toEqual([]);
  });

  it("adopts a started record only after renewing its exact lease", async () => {
    const log: string[] = [];
    const stored = await store(log);
    const firstChildren = fakeChildren(log);
    const first = createWorkRunController({
      client: fakeClient(log),
      childController: firstChildren.controller,
      store: stored.store,
      ownerFactory: () => owner,
    });
    expect((await first.startContractedWork(workItemId)).ok).toBe(true);
    await first.shutdown({preserveRuns: true});
    log.length = 0;

    const recoveredChildren = fakeChildren(log);
    const recovered = createWorkRunController({
      client: fakeClient(log),
      childController: recoveredChildren.controller,
      store: stored.store,
      ownerFactory: () => "different-owner",
    });
    const result = await recovered.recoverWorkRuns();

    expect(result.failed).toEqual([]);
    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0].work).toEqual(identity());
    expect(log).toEqual(["adopt", `heartbeat:${workItemId}`, "put:started"]);
  });

  it("adopts a spawned record, retries exact start, and advances it", async () => {
    const log: string[] = [];
    const stored = await store(log);
    const recoveryRecord: ChildSessionRecoveryRecord = {
      runId: stored.store.runIdFor("/repo", workItemId),
      phase: "spawned",
      updatedAtMs: 0,
      work: identity(),
      launch: launch(),
      session: session(),
      credentials: {claimOwner: owner, claimToken: token},
    };
    await stored.store.put(recoveryRecord);
    log.length = 0;

    const children = fakeChildren(log);
    const controller = createWorkRunController({
      client: fakeClient(log),
      childController: children.controller,
      store: stored.store,
      ownerFactory: () => "different-owner",
    });
    const result = await controller.recoverWorkRuns();

    expect(result.failed).toEqual([]);
    expect(result.recovered[0].phase).toBe("started");
    expect(log).toEqual(["adopt", "put:spawned", `start:${workItemId}`, "put:started"]);
    expect(JSON.stringify(result)).not.toMatch(/private-owner|private-token|claimOwner|claimToken/);
    expect((await stored.store.loadAll()).records[0].credentials).toEqual({
      claimOwner: owner,
      claimToken: token,
    });
  });

  it("confirms an ambiguous recovery start with the exact lease", async () => {
    const log: string[] = [];
    const stored = await store(log);
    await stored.store.put({
      runId: stored.store.runIdFor("/repo", workItemId),
      phase: "spawned",
      updatedAtMs: 0,
      work: identity(),
      launch: launch(),
      session: session(),
      credentials: {claimOwner: owner, claimToken: token},
    });
    log.length = 0;

    const controller = createWorkRunController({
      client: fakeClient(log, {startMalformedOnce: true}),
      childController: fakeChildren(log).controller,
      store: stored.store,
    });
    const result = await controller.recoverWorkRuns();

    expect(result.failed).toEqual([]);
    expect(result.recovered).toHaveLength(1);
    expect(log).toEqual([
      "adopt",
      "put:spawned",
      `start:${workItemId}`,
      `heartbeat:${workItemId}`,
      "put:started",
    ]);
  });

  it("quarantines a failed recovery start without deleting the worktree", async () => {
    const log: string[] = [];
    const stored = await store(log);
    await stored.store.put({
      runId: stored.store.runIdFor("/repo", workItemId),
      phase: "spawned",
      updatedAtMs: 0,
      work: identity(),
      launch: launch(),
      session: session(),
      credentials: {claimOwner: owner, claimToken: token},
    });
    log.length = 0;

    const children = fakeChildren(log);
    const controller = createWorkRunController({
      client: fakeClient(log, {startFailure: true, heartbeatFailure: true}),
      childController: children.controller,
      store: stored.store,
      ownerFactory: () => "different-owner",
    });
    const result = await controller.recoverWorkRuns();

    expect(result.recovered).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toContain("recover start work item failed");
    expect(log).toEqual([
      "adopt",
      "put:spawned",
      `start:${workItemId}`,
      `heartbeat:${workItemId}`,
      "put:quarantined",
      "abandon",
    ]);
    expect((await stored.store.listSafe())[0].phase).toBe("quarantined");
    expect(children.current()).toBeUndefined();
  });

  it("quarantines a started record whose exact lease can no longer be renewed", async () => {
    const log: string[] = [];
    const stored = await store(log);
    await stored.store.put({
      runId: stored.store.runIdFor("/repo", workItemId),
      phase: "started",
      updatedAtMs: 0,
      work: identity(),
      launch: launch(),
      session: session(),
      credentials: {claimOwner: owner, claimToken: token},
    });
    log.length = 0;

    const children = fakeChildren(log);
    const controller = createWorkRunController({
      client: fakeClient(log, {heartbeatFailure: true}),
      childController: children.controller,
      store: stored.store,
    });
    const result = await controller.recoverWorkRuns();

    expect(result.recovered).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toContain("recover heartbeat failed");
    expect(log).toEqual([
      "adopt",
      `heartbeat:${workItemId}`,
      "put:quarantined",
      "abandon",
    ]);
    expect((await stored.store.listSafe())[0].phase).toBe("quarantined");
    expect(children.current()).toBeUndefined();
  });

  it("reports a malformed sibling record while recovering the valid record", async () => {
    const log: string[] = [];
    const stored = await store(log);
    const validRunId = stored.store.runIdFor("/repo", workItemId);
    await stored.store.put({
      runId: validRunId,
      phase: "started",
      updatedAtMs: 0,
      work: identity(),
      launch: launch(),
      session: session(),
      credentials: {claimOwner: owner, claimToken: token},
    });
    const malformedRunId = "f".repeat(64);
    await writeFile(join(stored.root, `${malformedRunId}.json`), JSON.stringify({
      runId: malformedRunId,
      phase: "started",
      updatedAtMs: 123,
      work: {workItemId},
      session: {
        ...session(),
        work: {workItemId},
      },
      credentials: {claimOwner: owner, claimToken: token},
    }), "utf8");
    log.length = 0;

    const children = fakeChildren(log);
    const controller = createWorkRunController({
      client: fakeClient(log),
      childController: children.controller,
      store: stored.store,
    });
    const result = await controller.recoverWorkRuns();

    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0].runId).toBe(validRunId);
    expect(result.failed).toEqual([{
      runId: malformedRunId,
      reason: "invalid work-session recovery record",
    }]);
    expect(log).toEqual(["adopt", `heartbeat:${workItemId}`, "put:started"]);
  });

  it("rejects recovery metadata whose session boundary disagrees with the contract", async () => {
    const log: string[] = [];
    const stored = await store();
    await stored.store.put({
      runId: stored.store.runIdFor("/repo", workItemId),
      phase: "started",
      updatedAtMs: 0,
      work: identity(),
      launch: launch(),
      session: {...session(), accessMode: "read_only", writeScope: []},
      credentials: {claimOwner: owner, claimToken: token},
    });
    const controller = createWorkRunController({
      client: fakeClient(log),
      childController: fakeChildren(log).controller,
      store: stored.store,
    });

    const result = await controller.recoverWorkRuns();

    expect(result.recovered).toEqual([]);
    expect(result.failed[0].reason).toBe("stored work identity does not match the child session");
    expect(log).toEqual([]);
  });

  it("reports a missing recorded worktree without claiming, starting, or spawning", async () => {
    const log: string[] = [];
    const stored = await store();
    await stored.store.put({
      runId: stored.store.runIdFor("/repo", workItemId),
      phase: "started",
      updatedAtMs: 0,
      work: identity(),
      launch: launch(),
      session: session(),
      credentials: {claimOwner: owner, claimToken: token},
    });
    const children = fakeChildren(log, {adoptFailure: true});
    const controller = createWorkRunController({
      client: fakeClient(log),
      childController: children.controller,
      store: stored.store,
      ownerFactory: () => "different-owner",
    });

    const result = await controller.recoverWorkRuns();

    expect(result.recovered).toEqual([]);
    expect(result.failed[0].reason).toContain("recorded worktree missing");
    expect(log).toEqual(["adopt"]);
  });
});

import {describe, expect, test} from "bun:test";
import type {MergePacket} from "../mergeGate";
import type {MergeMasterWorkIdentity} from "../mergeMaster";
import {
  evaluateReadyProof,
  formatReadyPacket,
  formatReadyProofDecision,
  loadReadyProof,
  loadReadyPacket,
  parseReadyProofPolicy,
  redactWorkProofText,
  type ReadyPacket,
  type WorkProofClient,
} from "../workProof";

const identity: MergeMasterWorkIdentity = {
  workItemId: "work-123",
  title: "Bounded change",
  revision: 4,
  orgId: null,
  projectId: "project-1",
  taskId: null,
  contract: {classification: "bounded", profile: "coding", version: 1},
  plan: {planId: "plan-456", planVersion: 3, state: "active"},
  writeScope: {include: ["src/**"], exclude: ["src/secrets/**"]},
};

function merge(overrides: Partial<MergePacket> = {}): MergePacket {
  return {
    childSessionId: 2,
    parentSessionId: 1,
    baseBranch: "main",
    childBranch: "codex/bounded-change",
    baseCommit: "a".repeat(40),
    baseTip: "b".repeat(40),
    behindBy: 0,
    headCommit: "c".repeat(40),
    files: [{path: "src/change.ts", additions: 2, deletions: 1, binary: false}],
    totalAdditions: 2,
    totalDeletions: 1,
    conflicts: [],
    outOfScope: [],
    dirty: false,
    verdict: "ready_to_merge",
    blockers: [],
    work: identity,
    ...overrides,
  };
}

function step(): Record<string, unknown> {
  const value: Record<string, unknown> = {
    id: "step-1",
    planId: identity.plan.planId,
    workItemId: identity.workItemId,
    planVersion: identity.plan.planVersion,
    key: "typecheck",
    title: "Typecheck",
    kind: "shell",
    ordinal: 1,
    required: true,
  };
  Object.defineProperty(value, "spec", {
    enumerable: true,
    get: () => { throw new Error("verification specification was executed"); },
  });
  return value;
}

function client(overrides: Partial<WorkProofClient> = {}): WorkProofClient {
  return {
    async getWorkItem() {
      return {
        statusCode: 200,
        data: {
          workItem: {
            id: identity.workItemId,
            title: identity.title,
            revision: identity.revision,
            orgId: identity.orgId,
            projectId: identity.projectId,
            taskId: identity.taskId,
            status: "needs_review",
            verificationState: "commands_passed",
            contractSummary: identity.contract,
            acceptanceCriteria: [
              {text: "Typecheck passes", met: true},
              {text: "Human review completed", met: false},
            ],
          },
        },
      };
    },
    async getWorkVerificationPlan() {
      return {
        statusCode: 200,
        data: {
          plan: {
            id: identity.plan.planId,
            workItemId: identity.workItemId,
            version: identity.plan.planVersion,
            state: "active",
            coverage: {
              state: "commands_passed",
              required: 1,
              covered: 1,
              passed: 1,
              missingStepIds: [],
              failedStepIds: [],
              steps: [{
                step: step(),
                latestAttempt: {
                  workItemId: identity.workItemId,
                  planId: identity.plan.planId,
                  planVersion: identity.plan.planVersion,
                  stepId: "step-1",
                  attemptId: "attempt-1",
                  outcome: "passed",
                  exitCode: 0,
                  environmentLabel: "workspace",
                  ranAt: "2026-08-13T00:00:00.000Z",
                  output: `Authorization: Bearer do-not-render ${"x".repeat(2_000)}`,
                  artifactRefs: ["https://example.test/proof?token=do-not-render"],
                  provenance: {
                    runner: "codex",
                    accessToken: "do-not-render",
                    siftReadyProofV1: {headCommit: "c".repeat(40)},
                  },
                },
              }],
            },
          },
        },
      };
    },
    async listWorkItemVerifierRuns() {
      return {
        statusCode: 200,
        data: {
          runs: [{
            id: "run-789",
            verdict: "needs_review",
            verificationPlanId: identity.plan.planId,
            verificationPlanVersion: identity.plan.planVersion,
            createdAt: "2026-08-13T00:01:00.000Z",
          }],
        },
      };
    },
    ...overrides,
  };
}

describe("work proof packets", () => {
  test("labels an unlinked session without making API calls", async () => {
    let calls = 0;
    const unavailableClient = client({
      async getWorkItem() { calls += 1; throw new Error("unexpected"); },
      async getWorkVerificationPlan() { calls += 1; throw new Error("unexpected"); },
      async listWorkItemVerifierRuns() { calls += 1; throw new Error("unexpected"); },
    });
    const packet = await loadReadyPacket(merge({work: undefined}), unavailableClient);
    expect(calls).toBe(0);
    expect(packet.proof).toEqual({
      availability: "unavailable",
      reason: "session_not_linked",
      detail: "contract evidence unavailable for an unlinked session",
    });
    expect(packet.merge.verdict).toBe("ready_to_merge");
  });

  test("labels a non-V1 session without making API calls", async () => {
    let calls = 0;
    const unavailableClient = client({
      async getWorkItem() { calls += 1; throw new Error("unexpected"); },
      async getWorkVerificationPlan() { calls += 1; throw new Error("unexpected"); },
      async listWorkItemVerifierRuns() { calls += 1; throw new Error("unexpected"); },
    });
    const packet = await loadReadyPacket(merge({
      work: {...identity, contract: {...identity.contract, version: 2}},
    }), unavailableClient);

    expect(calls).toBe(0);
    expect(packet.proof).toMatchObject({availability: "unavailable", reason: "contract_v1_unavailable"});
    expect(packet.merge.verdict).toBe("ready_to_merge");
  });

  test("projects exact current identities, bounded attempts, acceptance, and verifier verdict", async () => {
    const packet = await loadReadyPacket(merge(), client());
    expect(packet.proof.availability).toBe("available");
    if (packet.proof.availability !== "available") return;
    expect(packet.proof.identity).toEqual({
      workItemId: identity.workItemId,
      title: identity.title,
      revision: identity.revision,
      orgId: identity.orgId,
      projectId: identity.projectId,
      taskId: identity.taskId,
      contract: identity.contract,
      activePlan: identity.plan,
      status: "needs_review",
      verificationState: "commands_passed",
    });
    expect(packet.proof.commands).toMatchObject({
      state: "commands_passed",
      required: 1,
      covered: 1,
      passed: 1,
    });
    expect(packet.proof.commands.requiredSteps[0]?.latestAttempt?.attemptId).toBe("attempt-1");
    expect(packet.proof.commands.requiredSteps[0]?.latestAttempt?.output).not.toContain("do-not-render");
    expect(packet.proof.commands.requiredSteps[0]?.latestAttempt?.output?.length).toBeLessThanOrEqual(1_200);
    expect(JSON.stringify(packet.proof.commands.requiredSteps[0]?.latestAttempt?.artifactRefs)).not.toContain("do-not-render");
    expect(JSON.stringify(packet.proof.commands.requiredSteps[0]?.latestAttempt?.provenance)).not.toContain("do-not-render");
    expect(packet.proof.acceptance).toMatchObject({total: 2, met: 1, unmet: 1});
    expect(packet.proof.verifier).toMatchObject({status: "recorded", verdict: "needs_review", runId: "run-789"});

    const rendered = formatReadyPacket(packet);
    expect(rendered).toContain("commands: commands_passed");
    expect(rendered).toContain("verifier: needs_review");
    expect(rendered).toContain(`base ${"b".repeat(40)}`);
    expect(rendered).toContain(`head ${"c".repeat(40)}`);
    expect(rendered).toContain("step step-1");
    expect(rendered).toContain("latest: passed · exit 0 · attempt-1");
    expect(rendered).toContain("acceptance 1: Typecheck passes");
    expect(rendered).not.toContain("do-not-render");
  });

  test("does not inspect or execute verification specifications", async () => {
    const packet = await loadReadyPacket(merge(), client());
    expect(packet.proof.availability).toBe("available");
  });

  test("keeps absent acceptance criteria informational for an authoritative packet", async () => {
    const packet = await loadReadyPacket(merge(), client({
      async getWorkItem() {
        const response = await client().getWorkItem(identity.workItemId);
        delete (response.data as {workItem: Record<string, unknown>}).workItem.acceptanceCriteria;
        return response;
      },
    }));

    expect(packet.proof).toMatchObject({
      availability: "available",
      acceptance: {status: "unavailable", total: 0, criteria: []},
    });
    expect(evaluateReadyProof({policy: "enforce", merge: merge(), packet})).toMatchObject({
      allowed: true,
      code: "ready_proof_pass",
    });
  });

  test("keeps malformed acceptance criteria informational for an authoritative packet", async () => {
    const packet = await loadReadyPacket(merge(), client({
      async getWorkItem() {
        const response = await client().getWorkItem(identity.workItemId);
        (response.data as {workItem: Record<string, unknown>}).workItem.acceptanceCriteria = [{}];
        return response;
      },
    }));

    expect(packet.proof).toMatchObject({
      availability: "available",
      acceptance: {status: "unavailable", total: 0, criteria: []},
    });
    expect(evaluateReadyProof({policy: "enforce", merge: merge(), packet})).toMatchObject({
      allowed: true,
      code: "ready_proof_pass",
    });
  });

  test("keeps a rejected verifier-runs call informational for an authoritative packet", async () => {
    const packet = await loadReadyPacket(merge(), client({
      async listWorkItemVerifierRuns() {
        throw new Error("verifier transport rejected");
      },
    }));

    expect(packet.proof).toMatchObject({
      availability: "available",
      verifier: {status: "unavailable", verdict: null},
    });
    expect(evaluateReadyProof({policy: "enforce", merge: merge(), packet})).toMatchObject({
      allowed: true,
      code: "ready_proof_pass",
    });
  });

  test("fails proof identity closed without changing the merge verdict", async () => {
    const packet = await loadReadyPacket(merge(), client({
      async getWorkVerificationPlan() {
        return {statusCode: 200, data: {plan: {id: "replacement", workItemId: identity.workItemId, version: 4, state: "active"}}};
      },
    }));
    expect(packet.proof).toMatchObject({availability: "unavailable", reason: "identity_mismatch"});
    expect(packet.merge.verdict).toBe("ready_to_merge");
  });

  test("redacts credential-shaped strings deterministically", () => {
    const value = redactWorkProofText("password=hunter2 https://user:pass@example.test/x?token=abc");
    expect(value).not.toContain("hunter2");
    expect(value).not.toContain("pass@");
    expect(value).not.toContain("token=abc");
    expect(value).toContain("[REDACTED]");
  });

  test("bounds merge evidence and rendered output without changing the verdict", async () => {
    const files = Array.from({length: 150}, (_, index) => ({
      path: `src/generated/${String(index).padStart(3, "0")}-${"x".repeat(500)}.ts`,
      additions: 1,
      deletions: 0,
      binary: false,
    }));
    const packet = await loadReadyPacket(merge({files, totalAdditions: files.length}), client());

    expect(packet.merge.changedFiles).toMatchObject({total: 150, truncated: true});
    expect(packet.merge.changedFiles.items).toHaveLength(100);
    expect(packet.merge.verdict).toBe("ready_to_merge");
    const rendered = formatReadyPacket(packet);
    expect(rendered.length).toBeLessThanOrEqual(16_000);
    expect(rendered).toContain("commands: commands_passed");
    expect(rendered).toContain("verifier: needs_review");
  });

  test("keeps unavailable proof visible ahead of truncated merge detail", async () => {
    const files = Array.from({length: 100}, (_, index) => ({
      path: `src/generated/${String(index).padStart(3, "0")}-${"x".repeat(500)}.ts`,
      additions: 1,
      deletions: 0,
      binary: false,
    }));
    const packet = await loadReadyPacket(merge({work: undefined, files}), client());
    const rendered = formatReadyPacket(packet);

    expect(rendered.length).toBeLessThanOrEqual(16_000);
    expect(rendered).toContain("proof: unavailable (session_not_linked)");
  });

  test("enforces exact current command proof bound to the inspected head", async () => {
    const mergePacket = merge();
    const readyPacket = await loadReadyPacket(mergePacket, client());
    expect(evaluateReadyProof({policy: "enforce", merge: mergePacket, packet: readyPacket})).toMatchObject({
      allowed: true,
      code: "ready_proof_pass",
      receipt: {
        childHead: mergePacket.headCommit,
        baseTip: mergePacket.baseTip,
        workRevision: identity.revision,
        planId: identity.plan.planId,
        planVersion: identity.plan.planVersion,
      },
    });
  });

  test("uses a closed independent policy and makes no calls in off", async () => {
    expect(parseReadyProofPolicy(undefined)).toBe("warn");
    expect(() => parseReadyProofPolicy("ENFORCE")).toThrow("ready_proof_config_invalid");
    let calls = 0;
    const result = loadReadyProof({
      policy: "off",
      merge: merge(),
      client: {
        async getWorkItem() { calls++; return {}; },
        async getWorkVerificationPlan() { calls++; return {}; },
        async listWorkItemVerifierRuns() { calls++; return {}; },
      },
    });
    expect(result).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("keeps warn non-enforcing while reporting the enforce advisory", async () => {
    const mergePacket = merge();
    const packet = await loadReadyPacket(mergePacket, client());
    const passing = evaluateReadyProof({policy: "warn", merge: mergePacket, packet});
    expect(passing).toEqual({
      policy: "warn",
      allowed: true,
      code: "proof_warn",
      advisoryCode: "ready_proof_pass",
    });
    expect(formatReadyProofDecision(passing)).toBe("proof: proof_warn · advisory: ready_proof_pass");

    if (packet.proof.availability !== "available") throw new Error("proof unavailable");
    const stale = structuredClone(packet);
    if (stale.proof.availability !== "available") throw new Error("proof unavailable");
    const attempt = stale.proof.commands.requiredSteps[0]?.latestAttempt;
    if (!attempt) throw new Error("attempt unavailable");
    attempt.provenance = {siftReadyProofV1: {headCommit: "d".repeat(40)}};
    expect(evaluateReadyProof({policy: "warn", merge: mergePacket, packet: stale})).toEqual({
      policy: "warn",
      allowed: true,
      code: "proof_warn",
      advisoryCode: "attempt_stale",
    });
  });

  test("maps every enforced evidence failure to one non-enforcing warn advisory without a receipt", async () => {
    const mergePacket = merge();
    const packet = await loadReadyPacket(mergePacket, client());
    if (packet.proof.availability !== "available") throw new Error("proof unavailable");

    type Case = {
      code: string;
      merge?: Partial<MergePacket>;
      omitPacket?: boolean;
      mutate?: (candidate: ReadyPacket) => void;
    };
    const cases: Case[] = [
      {code: "work_link_required", merge: {work: undefined}},
      {code: "identity_incomplete", merge: {work: {...identity, revision: undefined}}},
      {code: "base_not_contained", merge: {behindBy: 1}},
      {code: "proof_load_failed", omitPacket: true},
      {code: "identity_mismatch", mutate: (candidate) => {
        if (candidate.proof.availability === "available") candidate.proof.identity.revision += 1;
      }},
      {code: "scope_mismatch", mutate: (candidate) => {
        if (candidate.proof.availability === "available") candidate.proof.identity.projectId = "other-project";
      }},
      {code: "work_status_invalid", mutate: (candidate) => {
        if (candidate.proof.availability === "available") candidate.proof.identity.status = "running";
      }},
      {code: "work_verification_state_invalid", mutate: (candidate) => {
        if (candidate.proof.availability === "available") candidate.proof.identity.verificationState = "unverified";
      }},
      {code: "plan_stale", mutate: (candidate) => {
        if (candidate.proof.availability === "available") candidate.proof.identity.activePlan.planVersion += 1;
      }},
      {code: "coverage_invalid", mutate: (candidate) => {
        if (candidate.proof.availability === "available") candidate.proof.commands.required = 0;
      }},
      {code: "coverage_incomplete", mutate: (candidate) => {
        if (candidate.proof.availability === "available") candidate.proof.commands.passed = 0;
      }},
      {code: "coverage_duplicate", mutate: (candidate) => {
        if (candidate.proof.availability !== "available") return;
        const step = candidate.proof.commands.requiredSteps[0];
        if (!step) throw new Error("step unavailable");
        candidate.proof.commands.required = 2;
        candidate.proof.commands.covered = 2;
        candidate.proof.commands.passed = 2;
        candidate.proof.commands.requiredSteps.push(structuredClone(step));
      }},
      {code: "attempt_invalid", mutate: (candidate) => {
        if (candidate.proof.availability !== "available") return;
        const attempt = candidate.proof.commands.requiredSteps[0]?.latestAttempt;
        if (!attempt) throw new Error("attempt unavailable");
        attempt.outcome = "failed";
      }},
      {code: "attempt_stale", mutate: (candidate) => {
        if (candidate.proof.availability !== "available") return;
        const attempt = candidate.proof.commands.requiredSteps[0]?.latestAttempt;
        if (!attempt) throw new Error("attempt unavailable");
        attempt.provenance = {siftReadyProofV1: {headCommit: "d".repeat(40)}};
      }},
    ];

    for (const scenario of cases) {
      const candidate = structuredClone(packet);
      scenario.mutate?.(candidate);
      const decision = evaluateReadyProof({
        policy: "warn",
        merge: {...mergePacket, ...scenario.merge},
        packet: scenario.omitPacket ? undefined : candidate,
      });
      expect(decision).toEqual({
        policy: "warn",
        allowed: true,
        code: "proof_warn",
        advisoryCode: scenario.code,
      });
      expect("receipt" in decision).toBe(false);
    }
  });

  test("fails stale, malformed, incomplete, and behind proof closed", async () => {
    const mergePacket = merge();
    const packet = await loadReadyPacket(mergePacket, client());
    expect(evaluateReadyProof({policy: "enforce", merge: {...mergePacket, behindBy: 1}, packet}).code)
      .toBe("base_not_contained");
    expect(evaluateReadyProof({policy: "enforce", merge: {...mergePacket, work: undefined}, packet}).code)
      .toBe("work_link_required");
    expect(evaluateReadyProof({
      policy: "enforce",
      merge: {...mergePacket, work: {...identity, revision: undefined}},
      packet,
    }).code).toBe("identity_incomplete");
    if (packet.proof.availability !== "available") throw new Error("proof unavailable");
    const incomplete = structuredClone(packet);
    if (incomplete.proof.availability !== "available") throw new Error("proof unavailable");
    incomplete.proof.commands.required = 0;
    expect(evaluateReadyProof({policy: "enforce", merge: mergePacket, packet: incomplete}).code)
      .toBe("coverage_invalid");
    const stale = structuredClone(packet);
    if (stale.proof.availability !== "available") throw new Error("proof unavailable");
    const attempt = stale.proof.commands.requiredSteps[0]?.latestAttempt;
    if (!attempt) throw new Error("attempt unavailable");
    attempt.provenance = {siftReadyProofV1: {headCommit: "d".repeat(40)}};
    expect(evaluateReadyProof({policy: "enforce", merge: mergePacket, packet: stale}).code)
      .toBe("attempt_stale");
  });
});

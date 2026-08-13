import {describe, expect, test} from "bun:test";
import type {MergePacket} from "../mergeGate";
import type {MergeMasterWorkIdentity} from "../mergeMaster";
import {
  formatReadyPacket,
  loadReadyPacket,
  redactWorkProofText,
  type WorkProofClient,
} from "../workProof";

const identity: MergeMasterWorkIdentity = {
  workItemId: "work-123",
  title: "Bounded change",
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
                  provenance: {runner: "codex", accessToken: "do-not-render"},
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
      contract: identity.contract,
      activePlan: identity.plan,
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
});

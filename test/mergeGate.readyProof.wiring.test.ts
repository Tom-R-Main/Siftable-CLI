import {interactiveCommands, type ChildSessionActions} from "../interactive-tui/commands";
import type {MergePacket} from "../interactive-tui/mergeGate";
import {buildCommandContext, response} from "./helpers/interactive-command-context";

const work = {
  workItemId: "work-123",
  title: "Proof-aware ready packet",
  contract: {classification: "bounded" as const, profile: "coding" as const, version: 1},
  plan: {planId: "plan-123", planVersion: 1, state: "active" as const},
  writeScope: {include: ["packages/exf-cli/**"], exclude: []},
};

function packet(): MergePacket {
  return {
    childSessionId: 2,
    parentSessionId: 1,
    baseBranch: "main",
    childBranch: "codex/work-proof",
    baseCommit: "base",
    baseTip: "tip",
    behindBy: 0,
    headCommit: "head",
    files: [{path: "packages/exf-cli/interactive-tui/workProof.ts", additions: 1, deletions: 0, binary: false}],
    totalAdditions: 1,
    totalDeletions: 0,
    conflicts: [],
    outOfScope: [],
    dirty: false,
    verdict: "ready_to_merge",
    blockers: [],
    work,
  };
}

describe("/ready contracted proof wiring", () => {
  it("renders current plan coverage and verifier evidence without changing the git verdict", async () => {
    const command = interactiveCommands.find((candidate) => candidate.name === "ready");
    if (!command) throw new Error("ready command not found");
    const base = buildCommandContext();
    const sessions: ChildSessionActions = {
      ...base.ctx.sessions,
      activeChildId: jest.fn(() => 2),
      review: jest.fn(() => ({ok: true, packet: packet(), statusApplied: true, committed: false})),
    };
    const {ctx, apiClient, messages} = buildCommandContext({sessions});
    apiClient.getWorkItem = jest.fn(() => response({
      workItem: {
        id: work.workItemId,
        title: work.title,
        contractSummary: work.contract,
        acceptanceCriteria: [{text: "Focused verification passes", met: true}],
      },
    }));
    apiClient.getWorkVerificationPlan = jest.fn(() => response({
      plan: {
        id: work.plan.planId,
        workItemId: work.workItemId,
        version: work.plan.planVersion,
        state: work.plan.state,
        coverage: {
          state: "commands_passed",
          required: 1,
          covered: 1,
          passed: 1,
          missingStepIds: [],
          failedStepIds: [],
          steps: [{
            step: {
              id: "step-1",
              planId: work.plan.planId,
              workItemId: work.workItemId,
              planVersion: work.plan.planVersion,
              key: "typecheck",
              title: "Typecheck",
              kind: "shell",
              ordinal: 1,
              required: true,
              spec: {command: "must-not-run"},
            },
            latestAttempt: {
              workItemId: work.workItemId,
              planId: work.plan.planId,
              planVersion: work.plan.planVersion,
              stepId: "step-1",
              attemptId: "attempt-1",
              outcome: "passed",
              exitCode: 0,
              environmentLabel: "workspace",
              ranAt: "2026-08-13T00:00:00.000Z",
              output: "passed",
              artifactRefs: [],
              provenance: {},
            },
          }],
        },
      },
    }));
    apiClient.listWorkItemVerifierRuns = jest.fn(() => response({runs: [{
      id: "run-1",
      verdict: "needs_review",
      verificationPlanId: work.plan.planId,
      verificationPlanVersion: work.plan.planVersion,
      createdAt: "2026-08-13T00:01:00.000Z",
    }]}));

    await command.run(ctx, []);

    expect(messages.at(-1)?.text).toContain("✓ ready to merge");
    expect(messages.at(-1)?.text).toContain("commands: commands_passed");
    expect(messages.at(-1)?.text).toContain("verifier: needs_review");
    expect(messages.at(-1)?.text).toContain("acceptance: 1/1 met");
  });
});

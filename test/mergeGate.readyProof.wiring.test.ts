import {interactiveCommands, type ChildSessionActions} from "../interactive-tui/commands";
import type {MergePacket} from "../interactive-tui/mergeGate";
import {buildCommandContext} from "./helpers/interactive-command-context";

const work = {
  workItemId: "work-123",
  title: "Proof-aware ready packet",
  revision: 2,
  orgId: null,
  projectId: null,
  taskId: null,
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
  it("renders the coordinator decision and never loads proof directly in the slash route", async () => {
    const command = interactiveCommands.find((candidate) => candidate.name === "ready");
    if (!command) throw new Error("ready command not found");
    const base = buildCommandContext();
    const sessions: ChildSessionActions = {
      ...base.ctx.sessions,
      activeChildId: jest.fn(() => 2),
      review: jest.fn(() => ({
        ok: true,
        packet: packet(),
        statusApplied: true,
        committed: false,
        proofDecision: {policy: "enforce", allowed: true, code: "ready_proof_pass"},
      })),
    };
    const {ctx, apiClient, messages} = buildCommandContext({sessions});
    apiClient.getWorkItem = jest.fn(() => { throw new Error("direct proof load"); });
    apiClient.getWorkVerificationPlan = jest.fn(() => { throw new Error("direct proof load"); });
    apiClient.listWorkItemVerifierRuns = jest.fn(() => { throw new Error("direct proof load"); });

    await command.run(ctx, []);

    expect(messages.at(-1)?.text).toContain("✓ ready to merge");
    expect(messages.at(-1)?.text).toContain("proof: ready_proof_pass");
    expect(apiClient.getWorkItem).not.toHaveBeenCalled();
    expect(apiClient.getWorkVerificationPlan).not.toHaveBeenCalled();
    expect(apiClient.listWorkItemVerifierRuns).not.toHaveBeenCalled();
  });
});

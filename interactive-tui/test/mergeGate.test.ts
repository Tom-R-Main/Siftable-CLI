import {describe, expect, test} from "bun:test";
import {assembleMergePacket} from "../mergeGate";

describe("merge gate packet", () => {
  test("keeps contracted work identity as report-only packet metadata", () => {
    const work = {
      workItemId: "work-123",
      title: "Proof-aware ready packet",
      contract: {classification: "bounded" as const, profile: "coding" as const, version: 1},
      plan: {planId: "plan-123", planVersion: 1, state: "active" as const},
      writeScope: {include: ["packages/exf-cli/**"], exclude: []},
    };
    const packet = assembleMergePacket({
      child: {
        sessionId: 2,
        parentSessionId: 1,
        repoRoot: "/repo",
        branch: "codex/work-proof",
        baseBranch: "main",
        baseCommit: "base",
        worktreePath: "/repo/.worktrees/work-proof",
        accessMode: "read_write",
        writeScope: ["packages/exf-cli/**"],
        work,
      },
      baseTip: "tip",
      headCommit: "head",
      behindBy: 0,
      changedFiles: [{path: "packages/exf-cli/interactive-tui/workProof.ts", additions: 1, deletions: 0, binary: false}],
      conflicts: [],
      dirty: false,
    });

    expect(packet.verdict).toBe("ready_to_merge");
    expect(packet.work).toEqual(work);
    expect(packet.work).not.toBe(work);
  });
});

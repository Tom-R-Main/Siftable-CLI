import {describe, expect, it, mock} from "bun:test";
import {createWorkItemTools} from "../agent-harness/providers/siftable/tools";
import type {ExfClient} from "../agent-harness/providers/siftable/client";

function toolsFor(sift: Record<string, unknown>) {
  const client = {raw: () => sift} as unknown as ExfClient;
  return new Map(createWorkItemTools(client).map((tool) => [tool.name, tool]));
}

describe("Siftable agent-harness work-item tools", () => {
  it("uses the exact backend work status vocabulary", () => {
    const list = toolsFor({}).get("exf_work_items_list")!;
    expect((list.inputSchema.properties.status as {enum: string[]}).enum).toEqual([
      "queued", "claimed", "running", "blocked", "needs_review", "done", "failed", "cancelled",
    ]);
  });

  it("emits an explicit bounded contract from the Siftable work-create provider", async () => {
    const createWorkItem = mock(async () => ({
      statusCode: 201,
      data: {workItem: {id: "work-1"}},
    }));
    const input = {
      title: "Bounded",
      profile: "coding" as const,
      acceptanceCriteria: ["Feature works"],
      scope: ["src/**"],
      verificationCommands: ["npm test"],
    };
    const siftable = await toolsFor({createWorkItem}).get("exf_work_item_create")!.handler(input);
    expect(siftable.success).toBe(true);
    expect(createWorkItem).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "Bounded",
      contract: expect.objectContaining({version: 1, profile: "coding"}),
    }));

  });

  it("rejects incomplete coding contracts before calling the API", async () => {
    const createWorkItem = mock(async () => ({statusCode: 201, data: {workItem: {id: "work-1"}}}));
    const result = await toolsFor({createWorkItem}).get("exf_work_item_create")!.handler({
      title: "Unbounded",
      profile: "coding",
      scope: ["src/**"],
    });
    expect(result.success).toBe(false);
    expect(String(result.message ?? result.error)).toContain("coding_verification_required");
    expect(createWorkItem).not.toHaveBeenCalled();
  });

  it("preserves dependency warnings on bounded creation", async () => {
    const createWorkItem = mock(async () => ({
      statusCode: 201,
      warnings: ['299 - "inputContext.dependsOn is deprecated"'],
      data: {workItem: {id: "work-1"}},
    }));
    const result = await toolsFor({createWorkItem}).get("exf_work_item_create")!.handler({
      title: "Bounded dependency",
      profile: "coding",
      acceptanceCriteria: ["Dependency is honored"],
      scope: ["src/**"],
      verificationCommands: ["npm test"],
      dependsOn: [{workItemId: "11111111-1111-4111-8111-111111111111"}],
    });
    expect(result.message).toContain("Warning: 299");
  });

  it("rejects model-supplied elevated actions", async () => {
    const createWorkItem = mock(async () => ({statusCode: 201, data: {workItem: {id: "work-1"}}}));
    const input = {
      title: "Elevated",
      profile: "coding" as const,
      acceptanceCriteria: ["Deploy succeeds"],
      scope: ["src/**"],
      verificationCommands: ["npm test"],
      allowVault: true,
      allowDeploy: true,
    };
    const siftable = await toolsFor({createWorkItem}).get("exf_work_item_create")!.handler(input);

    expect(siftable.success).toBe(false);
    expect(String(siftable.error)).toContain("operator approval: vault, deploy");
    expect(createWorkItem).not.toHaveBeenCalled();
  });

  it("maps a claim alias to assignedAlias and carries the owner identity", async () => {
    const claimWorkItem = mock(async () => ({
      statusCode: 200,
      data: {workItem: {id: "work-1", claimToken: "secret"}},
    }));
    const tools = toolsFor({claimWorkItem});
    const result = await tools.get("exf_work_item_claim")!.handler({
      alias: "codex",
      claimOwner: "codex@tty1",
      leaseSeconds: 60,
    });
    expect(result.success).toBe(true);
    expect(claimWorkItem).toHaveBeenCalledWith(
      {
        assignedAlias: "codex",
        claimOwner: "codex@tty1",
        leaseSeconds: 60,
      },
      expect.stringMatching(/^interactive-work-claim-/),
    );
  });

  it("rejects owner-bound transitions without claim credentials", async () => {
    const transitionWorkItem = mock(async () => ({statusCode: 200, data: {workItem: {id: "work-1"}}}));
    const tools = toolsFor({transitionWorkItem});
    const result = await tools.get("exf_work_item_transition")!.handler({
      workItemId: "work-1",
      action: "start",
    });
    expect(result.success).toBe(false);
    expect(transitionWorkItem).not.toHaveBeenCalled();
  });

  it("keeps needs-review completion available without lease credentials", async () => {
    const transitionWorkItem = mock(async () => ({statusCode: 200, data: {workItem: {id: "work-1"}}}));
    const tools = toolsFor({transitionWorkItem});
    const result = await tools.get("exf_work_item_transition")!.handler({
      workItemId: "work-1",
      action: "complete",
      resultSummary: "Reviewed",
    });
    expect(result.success).toBe(true);
    expect(transitionWorkItem).toHaveBeenCalledWith("work-1", "complete", {resultSummary: "Reviewed"});
  });

  it("lets the server validate a tokenless review-gate park request", async () => {
    const transitionWorkItem = mock(async () => ({statusCode: 200, data: {workItem: {id: "gate-1"}}}));
    const tools = toolsFor({transitionWorkItem});
    const result = await tools.get("exf_work_item_transition")!.handler({
      workItemId: "gate-1",
      action: "review",
      resultSummary: "Awaiting operator approval",
    });
    expect(result.success).toBe(true);
    expect(transitionWorkItem).toHaveBeenCalledWith("gate-1", "review", {
      resultSummary: "Awaiting operator approval",
    });
  });

  it("supports tokenless requeue and paired active-cancel credentials", async () => {
    const transitionWorkItem = mock(async () => ({statusCode: 200, data: {workItem: {id: "work-1"}}}));
    const transition = toolsFor({transitionWorkItem}).get("exf_work_item_transition")!;

    expect((await transition.handler({workItemId: "work-1", action: "requeue"})).success).toBe(true);
    expect((await transition.handler({workItemId: "work-1", action: "cancel", claimToken: "token"})).success).toBe(false);
    expect((await transition.handler({workItemId: "work-1", action: "release", claimToken: "token"})).success).toBe(false);
  });

  it("redacts claim tokens from lifecycle results", async () => {
    const transitionWorkItem = mock(async () => ({
      statusCode: 200,
      data: {workItem: {id: "work-1", status: "running", claimToken: "secret"}},
    }));
    const result = await toolsFor({transitionWorkItem}).get("exf_work_item_transition")!.handler({
      workItemId: "work-1",
      action: "heartbeat",
      claimOwner: "codex:test",
      claimToken: "secret",
    });
    expect((result.data as any).workItem.claimToken).toBeUndefined();
  });

  it("redacts claim tokens from get while preserving dependency state", async () => {
    const getWorkItem = mock(async () => ({
      statusCode: 200,
      data: {
        workItem: {
          id: "work-1",
          claimToken: "secret",
          dependencies: [{predecessorId: "work-0", requiredGate: "commands_passed", satisfied: false}],
          claimability: {state: "waiting", blockedBy: []},
        },
      },
    }));
    const tools = toolsFor({getWorkItem});
    const result = await tools.get("exf_work_item_get")!.handler({workItemId: "work-1"});
    expect(result.success).toBe(true);
    expect((result.data as any).workItem.claimToken).toBeUndefined();
    expect((result.data as any).workItem.claimability.state).toBe("waiting");
    expect((result.data as any).workItem.dependencies[0].requiredGate).toBe("commands_passed");
  });
});

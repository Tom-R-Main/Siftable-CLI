import {describe, expect, it, mock} from "bun:test";
import {createWorkItemTools} from "../openfunction/providers/siftable/tools";
import type {ExfClient} from "../openfunction/providers/siftable/client";

function toolsFor(sift: Record<string, unknown>) {
  const client = {raw: () => sift} as unknown as ExfClient;
  return new Map(createWorkItemTools(client).map((tool) => [tool.name, tool]));
}

describe("OpenFunction work-item tools", () => {
  it("uses the exact backend work status vocabulary", () => {
    const list = toolsFor({}).get("exf_work_items_list")!;
    expect((list.inputSchema.properties.status as {enum: string[]}).enum).toEqual([
      "queued", "claimed", "running", "blocked", "needs_review", "done", "failed", "cancelled",
    ]);
  });

  it("surfaces legacy dependency warnings from creation", async () => {
    const createWorkItem = mock(async () => ({
      statusCode: 201,
      warnings: ['299 - "inputContext.dependsOn is deprecated"'],
      data: {workItem: {id: "work-1"}},
    }));
    const result = await toolsFor({createWorkItem}).get("exf_work_item_create")!.handler({title: "Legacy"});
    expect(result.message).toContain("Warning: 299");
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
    expect(claimWorkItem).toHaveBeenCalledWith({
      assignedAlias: "codex",
      claimOwner: "codex@tty1",
      leaseSeconds: 60,
    });
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
          dependencies: [{predecessorId: "work-0", requiredGate: "verified", satisfied: false}],
          claimability: {state: "waiting", blockedBy: []},
        },
      },
    }));
    const tools = toolsFor({getWorkItem});
    const result = await tools.get("exf_work_item_get")!.handler({workItemId: "work-1"});
    expect(result.success).toBe(true);
    expect((result.data as any).workItem.claimToken).toBeUndefined();
    expect((result.data as any).workItem.claimability.state).toBe("waiting");
    expect((result.data as any).workItem.dependencies[0].requiredGate).toBe("verified");
  });
});

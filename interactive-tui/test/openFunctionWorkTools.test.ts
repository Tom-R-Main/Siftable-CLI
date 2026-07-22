import {describe, expect, it, mock} from "bun:test";
import {createWorkItemTools} from "../openfunction/providers/siftable/tools";
import type {ExfClient} from "../openfunction/providers/siftable/client";

function toolsFor(sift: Record<string, unknown>) {
  const client = {raw: () => sift} as unknown as ExfClient;
  return new Map(createWorkItemTools(client).map((tool) => [tool.name, tool]));
}

describe("OpenFunction work-item tools", () => {
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

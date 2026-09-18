/**
 * Tool authorization: approval-gated tools are hidden from the model and
 * refused at execution under a denying policy, and tools declared
 * `approval: "always"` keep prompting through a session-wide bypass — pinned by
 * the registry, not by whatever spec the handler passes.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  isBypassing,
  requestApproval,
  requestConfirm,
  resetBypass,
  resolveApproval,
  setConfirmListener,
  type ConfirmRequest,
} from "../confirmGate";
import { ToolRegistry } from "../agent-harness/framework/registry";
import { createChatAgent } from "../agent-harness/framework/chat-agent";
import { InMemorySessionEventStore } from "../agent-harness/framework/session";
import { withExecutionContext, type ToolExecutionContext } from "../agent-harness/framework/execution-context";
import type { AIAdapter } from "../agent-harness/framework/adapters/types";
import type { ToolDefinition } from "../agent-harness/framework/types";

const baseContext: ToolExecutionContext = { sessionId: "sess", turnId: "t", callId: "c", workspaceRoot: "/", sessionCwd: "/" };
const spec = { kind: "command" as const, path: "x", detail: "" };

afterEach(() => {
  resetBypass();
  setConfirmListener(null);
});

/** Listener that records requests and answers with a fixed decision. */
function answering(decision: "allow" | "deny" | "bypass") {
  const requests: ConfirmRequest[] = [];
  setConfirmListener((request) => { requests.push(request); resolveApproval(request.id, decision); });
  return requests;
}

describe.serial("approval bypass boundaries", () => {
  it("never lets a session bypass satisfy a request with allowBypass: false", async () => {
    let requests = answering("bypass");
    expect(await requestApproval(spec)).toBe("bypass");
    expect(isBypassing()).toBe(true);
    expect(await requestApproval(spec)).toBe("allow"); // shortcut, no prompt
    expect(requests).toHaveLength(1);

    requests = answering("allow");
    expect(await requestApproval({ ...spec, allowBypass: false })).toBe("allow");
    expect(requests).toHaveLength(1); // prompted despite bypass mode

    // Scoped variant.
    requests = answering("bypass");
    expect(await requestApproval({ ...spec, authorityScope: "s1" })).toBe("bypass");
    expect(await requestApproval({ ...spec, authorityScope: "s1" })).toBe("allow");
    expect(requests).toHaveLength(1);
    requests = answering("allow");
    expect(await requestApproval({ ...spec, authorityScope: "s1", allowBypass: false })).toBe("allow");
    expect(requests).toHaveLength(1);
  });

  it("lets an explicit spec scope override the session scope", async () => {
    answering("bypass");
    expect(await requestApproval({ ...spec, authorityScope: "sess" })).toBe("bypass");

    // Session-scoped bypass applies when the spec has no scope of its own.
    let requests = answering("deny");
    expect(await withExecutionContext(baseContext, () => requestConfirm(spec))).toBe(true);
    expect(requests).toHaveLength(0);

    // A vault-scoped request is not covered by the session bypass.
    requests = answering("deny");
    expect(await withExecutionContext(baseContext, () => requestConfirm({ ...spec, path: "vault", authorityScope: "vault" }))).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.authorityScope).toBe("vault");
  });
});

describe.serial("registry approval enforcement", () => {
  const registryWith = (...tools: ToolDefinition<any, any>[]) => { const r = new ToolRegistry(); r.registerAll(tools); return r; };
  const gated = (name: string, approval: "required" | "always", onRun: () => void): ToolDefinition<any, any> => ({
    name, approval, description: `${name} fixture`, inputSchema: { type: "object", properties: {} },
    // The handler's spec deliberately omits allowBypass — the registry must pin it.
    handler: async () => { onRun(); return { success: await requestConfirm({ kind: "command", path: name, detail: "" }) }; },
  });

  it("pins approval: always tools non-bypassable from the declaration", async () => {
    answering("bypass");
    expect(await requestApproval(spec)).toBe("bypass");

    let ran = 0;
    const registry = registryWith(gated("land", "always", () => { ran++; }));
    const ctx = { ...baseContext, approval: { policy: "ask" as const, scopeId: "s" } };

    let requests = answering("allow");
    expect(await registry.execute("land", {}, ctx)).toMatchObject({ success: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ allowBypass: false, allowAlways: false });

    // Trying to bypass an always-tool is a denial, not a grant.
    requests = answering("bypass");
    expect(await registry.execute("land", {}, ctx)).toMatchObject({ success: false });
    expect(requests).toHaveLength(1);
    expect(ran).toBe(2);
  });

  it("refuses approval-gated tools under a denying policy without dispatching them", async () => {
    let writes = 0, reads = 0;
    const registry = registryWith(
      gated("write", "required", () => { writes++; }),
      { name: "read", description: "read fixture", inputSchema: { type: "object", properties: {} }, handler: async () => { reads++; return { success: true }; } },
    );
    const ctx = { ...baseContext, approval: { policy: "deny" as const, scopeId: "s" } };
    const refused = await registry.execute("write", {}, ctx);
    expect(refused).toMatchObject({ success: false, executionOutcome: "failed" });
    expect(String(refused.error)).toContain("requires user approval");
    expect(writes).toBe(0);
    expect(await registry.execute("read", {}, ctx)).toMatchObject({ success: true });
    expect(reads).toBe(1);
  });

  it("never lets a headless allow policy satisfy an approval-always tool", async () => {
    const ctx = { ...baseContext, approval: { policy: "allow" as const, scopeId: "s" }, toolApproval: "always" as const };
    const requests = answering("allow");
    expect(await withExecutionContext(ctx, () => requestConfirm(spec))).toBe(true);
    expect(requests).toHaveLength(1); // prompted, not shortcut
    // Without a listener the required prompt fails closed instead of allowing.
    setConfirmListener(null);
    expect(await withExecutionContext(ctx, () => requestConfirm(spec))).toBe(false);
  });
});

describe.serial("model-visible tool set", () => {
  const tools: ToolDefinition<any, any>[] = [
    { name: "read", description: "read fixture", inputSchema: { type: "object", properties: {} }, handler: async () => ({ success: true }) },
    { name: "write", approval: "required", description: "write fixture", inputSchema: { type: "object", properties: {} }, handler: async () => ({ success: true }) },
    { name: "land", approval: "always", description: "land fixture", inputSchema: { type: "object", properties: {} }, handler: async () => ({ success: true }) },
  ];

  for (const [policy, expected] of [["deny", ["read"]], ["ask", ["read", "write", "land"]], ["allow", ["read", "write", "land"]]] as const) {
    it(`offers ${expected.length} of 3 tools under policy ${policy}, in the request and the journal`, async () => {
      const offered: string[][] = [];
      const adapter: AIAdapter = { name: "recording", model: "test", async chat(_messages, registry) { offered.push(registry.listNames()); return { text: "ok" }; } };
      const store = new InMemorySessionEventStore();
      const agent = await createChatAgent({
        adapter, memory: false, tools,
        executionContext: () => ({ workspaceRoot: "/", sessionCwd: "/", approval: { policy, scopeId: "s" } }),
        session: { id: `authz-${policy}`, store },
      });
      try {
        await agent.chat("hi");
        expect(offered).toEqual([[...expected]]);
        const requests = store.read(`authz-${policy}`).filter(event => event.type === "model/request-prepared");
        expect(requests.length).toBeGreaterThan(0);
        for (const request of requests) {
          expect((request.data as any).envelope.tools.map((tool: { name: string }) => tool.name)).toEqual([...expected]);
        }
      } finally { await agent.close(); }
    });
  }
});

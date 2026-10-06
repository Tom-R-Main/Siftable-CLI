/**
 * Owned tool registration: an owner's contribution is all-or-nothing under
 * "reject", dispose() removes only entries the owner still holds, and a
 * request snapshot refuses dispatch once its source definition is withdrawn
 * or replaced — it never routes the call to a different handler.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { describe, expect, it } from "bun:test";
import { ToolRegistry } from "../agent-harness/framework/registry";
import { connectProviderOwned, type ContextProvider } from "../agent-harness/framework/context";
import { createChatAgent, snapshotToolRegistry } from "../agent-harness/framework/chat-agent";
import { InMemorySessionEventStore } from "../agent-harness/framework/session";
import type { AIAdapter } from "../agent-harness/framework/adapters/types";
import type { ToolDefinition } from "../agent-harness/framework/types";

function tool(name: string, calls: string[] = [], label = name): ToolDefinition<any, any> {
  return {
    name,
    description: `${label} fixture`,
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      calls.push(label);
      return { success: true, data: label };
    },
  };
}

describe("registerOwned", () => {
  it("installs nothing when any name collides under reject", () => {
    const registry = new ToolRegistry();
    registry.register(tool("search"));
    expect(() => registry.registerOwned("ext", [tool("fresh"), tool("search")])).toThrow(/search/);
    expect(registry.listNames()).toEqual(["search"]);
  });

  it("rejects a contribution that repeats a name, installing nothing", () => {
    const registry = new ToolRegistry();
    expect(() => registry.registerOwned("ext", [tool("a"), tool("a")], { onCollision: "replace" })).toThrow(/more than once/);
    expect(registry.listNames()).toEqual([]);
  });

  it("keeps the existing tool under keep-existing and never removes it on dispose", () => {
    const registry = new ToolRegistry();
    const user = tool("search");
    registry.register(user);
    const owned = registry.registerOwned("ext", [tool("search"), tool("extra")], { onCollision: "keep-existing" });
    expect(owned.names).toEqual(["extra"]);
    owned.dispose();
    expect(registry.get("search")).toBe(user);
    expect(registry.get("extra")).toBeUndefined();
  });

  it("does not let a displaced owner's dispose remove the replacement", () => {
    const registry = new ToolRegistry();
    const first = registry.registerOwned("first", [tool("search", [], "first")]);
    const second = registry.registerOwned("second", [tool("search", [], "second")], { onCollision: "replace" });
    first.dispose();
    expect(registry.get("search")?.description).toBe("second fixture");
    second.dispose();
    expect(registry.get("search")).toBeUndefined();
  });

  it("is idempotent and reports inactive after dispose", () => {
    const registry = new ToolRegistry();
    const owned = registry.registerOwned("ext", [tool("a")]);
    expect(owned.active).toBe(true);
    owned.dispose();
    owned.dispose();
    expect(owned.active).toBe(false);
    // A later owner can claim the name without the old handle interfering.
    const next = registry.registerOwned("next", [tool("a")]);
    owned.dispose();
    expect(registry.get("a")).toBeDefined();
    next.dispose();
  });
});

describe("snapshot liveness", () => {
  // The per-request snapshot ChatAgent hands to the adapter and dispatches from.
  const snapshotOf = (source: ToolRegistry) => snapshotToolRegistry(source);

  it("omits approval-gated tools under deny while binding the rest", async () => {
    const source = new ToolRegistry();
    const owned = source.registerOwned("ext", [tool("read"), { ...tool("write"), approval: "required" }]);
    const snapshot = snapshotToolRegistry(source, "deny");
    expect(snapshot.listNames()).toEqual(["read"]);
    owned.dispose();
    expect(await snapshot.execute("read", {})).toMatchObject({ success: false, executionOutcome: "failed" });
  });

  it("dispatches while the source definition is live", async () => {
    const calls: string[] = [];
    const source = new ToolRegistry();
    source.registerOwned("ext", [tool("a", calls)]);
    expect(await snapshotOf(source).execute("a", {})).toMatchObject({ success: true });
    expect(calls).toEqual(["a"]);
  });

  it("refuses dispatch after withdrawal without calling the handler", async () => {
    const calls: string[] = [];
    const source = new ToolRegistry();
    const owned = source.registerOwned("ext", [tool("a", calls)]);
    const snapshot = snapshotOf(source);
    owned.dispose();
    expect(await snapshot.execute("a", {})).toEqual({
      success: false,
      error: 'Tool "a" was withdrawn before dispatch',
      executionOutcome: "failed",
    });
    expect(calls).toEqual([]);
  });

  it("refuses rather than substituting a replacement handler", async () => {
    const calls: string[] = [];
    const source = new ToolRegistry();
    source.registerOwned("first", [tool("a", calls, "first")]);
    const snapshot = snapshotOf(source);
    source.registerOwned("second", [tool("a", calls, "second")], { onCollision: "replace" });
    expect(await snapshot.execute("a", {})).toMatchObject({ success: false, executionOutcome: "failed" });
    expect(calls).toEqual([]);
    // A fresh snapshot sees the replacement.
    expect(await snapshotOf(source).execute("a", {})).toMatchObject({ success: true, data: "second" });
  });

  it("follows liveness through a snapshot of a snapshot", async () => {
    const source = new ToolRegistry();
    const owned = source.registerOwned("ext", [tool("a")]);
    const nested = snapshotOf(snapshotOf(source));
    owned.dispose();
    expect(await nested.execute("a", {})).toMatchObject({ success: false, executionOutcome: "failed" });
  });
});

function provider(names: string[], disconnects: string[] = []): ContextProvider {
    return {
      metadata: { id: "p", name: "Provider", description: "fixture" },
      async connect() {
        return {
          metadata: { id: "p", name: "Provider", description: "fixture" },
          createTools: () => names.map((n) => tool(n, [], `provider-${n}`)),
          async contextPrompt() { return ""; },
          async disconnect() { disconnects.push("p"); },
        } as any;
      },
    } as ContextProvider;
}

describe("connectProviderOwned", () => {
  it("leaves a user tool that won the collision in place after dispose", async () => {
    const registry = new ToolRegistry();
    const user = tool("search");
    registry.register(user);
    const { registration } = await connectProviderOwned(provider(["search", "p_only"]), registry);
    expect(registration.names).toEqual(["p_only"]);
    expect(registry.get("p_only")?.tags).toEqual(["context", "context:p"]);
    registration.dispose();
    expect(registry.listNames()).toEqual(["search"]);
    expect(registry.get("search")).toBe(user);
  });

  it("disconnects and installs nothing when the provider's tools are malformed", async () => {
    const disconnects: string[] = [];
    const registry = new ToolRegistry();
    await expect(connectProviderOwned(provider(["dup", "dup"], disconnects), registry)).rejects.toThrow(/more than once/);
    expect(registry.listNames()).toEqual([]);
    expect(disconnects).toEqual(["p"]);
  });
});

describe("ChatAgent provider teardown", () => {
  it("withdraws only the provider's own tools on close", async () => {
    const offered: string[][] = [];
    const adapter: AIAdapter = {
      name: "recording",
      model: "test",
      async chat(_messages, registry) {
        offered.push(registry.getAll().map((t) => t.description));
        return { text: "ok" };
      },
    };
    const disconnects: string[] = [];
    const agent = await createChatAgent({
      adapter,
      memory: false,
      tools: [tool("search", [], "user-search")],
      providers: [provider(["search", "p_only"], disconnects)],
      session: { id: "teardown", store: new InMemorySessionEventStore() },
    });
    await agent.chat("before");
    await agent.close();
    expect(disconnects).toEqual(["p"]);
    await agent.chat("after");
    expect(offered).toEqual([
      ["user-search fixture", "provider-p_only fixture"],
      ["user-search fixture"],
    ]);
  });
});

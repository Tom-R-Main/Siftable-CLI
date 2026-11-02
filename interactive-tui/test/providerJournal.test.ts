import { afterEach, describe, expect, it } from "bun:test";
import { createChatAgent } from "../agent-harness/framework/chat-agent";
import { createAnthropicAdapter } from "../agent-harness/framework/adapters/anthropic";
import { createChatCompletionsAdapter } from "../agent-harness/framework/adapters/openai";
import type { AdapterEvent, AIAdapter } from "../agent-harness/framework/adapters/types";
import type { ToolExecutionContext } from "../agent-harness/framework/execution-context";
import { digestJson, InMemorySessionEventStore, SessionKernel, type SessionEvent } from "../agent-harness/framework/session";

const originalCompaction = process.env.SIFT_CONTEXT_COMPACTION;
const originalWindow = process.env.SIFT_CONTEXT_WINDOW;
afterEach(() => {
  if (originalCompaction === undefined) delete process.env.SIFT_CONTEXT_COMPACTION;
  else process.env.SIFT_CONTEXT_COMPACTION = originalCompaction;
  if (originalWindow === undefined) delete process.env.SIFT_CONTEXT_WINDOW;
  else process.env.SIFT_CONTEXT_WINDOW = originalWindow;
});
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "x-request-id": "upstream-journal" } });
const answer = (text = "done") => ({ id: "response-1", model: "actual-model", usage: { prompt_tokens: 9, completion_tokens: 2 }, choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }] });
const longPrompt = (index: number) => `question ${index} ${"context detail ".repeat(900)}`;

class FailingProviderStore extends InMemorySessionEventStore {
  failAt?: "provider.attempt" | "provider.response";
  failAuxiliary = false;
  rejected = 0;
  override append(event: SessionEvent): void {
    if (this.failAuxiliary && event.type === "model/auxiliary-request-prepared") throw new Error("auxiliary envelope write failed");
    if (event.type === "model/provider-event" && event.data.event.type === this.failAt) {
      this.rejected++;
      throw new Error("required provider journal write failed");
    }
    super.append(event);
  }
}

describe.serial("provider journal integration", () => {
  it("records reconstructable compaction inputs before dispatch and correlates their provider receipts independently", async () => {
    process.env.SIFT_CONTEXT_COMPACTION = "0";
    const store = new InMemorySessionEventStore();
    const sessionId = "auxiliary-input-inspection";
    let summaryRequests = 0;
    const agent = await createChatAgent({ provider: "meta", model: "requested-model", reasoningEffort: "medium", adapterConfig: { apiKey: "never-persist-this", baseUrl: "https://api.meta.ai/v1", maxOutputTokens: 8192, fetchImpl: (async (_url, init) => {
      const current = store.read(sessionId);
      const attempt = current.at(-1);
      if (attempt?.type === "model/provider-event" && attempt.data.event.type === "provider.attempt" && attempt.data.event.oneShot) {
        summaryRequests++;
        const auxiliary = current.find(event => event.type === "model/auxiliary-request-prepared" && event.correlationId === attempt.correlationId);
        expect(auxiliary?.type).toBe("model/auxiliary-request-prepared");
        if (auxiliary?.type !== "model/auxiliary-request-prepared") throw new Error("summary request was not recorded before provider dispatch");
        expect(auxiliary.seq).toBeLessThan(attempt.seq);
        expect(JSON.parse(String(init?.body)).messages).toEqual([{ role: "system", content: auxiliary.data.envelope!.systemPrompt }, ...auxiliary.data.input]);
      }
      return json(answer("retained evidence"));
    }) as typeof fetch }, memory: false, tools: [], session: { id: sessionId, store } });
    try {
      for (let index = 0; index < 5; index++) await agent.chat(longPrompt(index));
      process.env.SIFT_CONTEXT_COMPACTION = "1";
      process.env.SIFT_CONTEXT_WINDOW = "3000";
      const result = await agent.chat("continue after summary");
      expect(summaryRequests).toBe(1);
      expect(result.providerReceipts).toHaveLength(2);
      const journal = store.read(sessionId);
      const auxiliary = journal.find(event => event.type === "model/auxiliary-request-prepared");
      if (auxiliary?.type !== "model/auxiliary-request-prepared") throw new Error("missing auxiliary request");
      expect(auxiliary.correlationId).toBeTruthy();
      expect(auxiliary.turnId).toBeUndefined();
      expect(auxiliary.stepId).toBeUndefined();
      expect(auxiliary.runId).toBeUndefined();
      expect(auxiliary.data.purpose).toBe("compaction");
      expect(auxiliary.data.inputSha256).toBe(digestJson(auxiliary.data.input));
      expect(auxiliary.data.systemPromptSha256).toBe(digestJson(auxiliary.data.envelope!.systemPrompt));
      expect(auxiliary.data.tools.sha256).toBe(digestJson(auxiliary.data.envelope!.tools));
      expect(auxiliary.data.options).toMatchObject({ oneShot: true, stream: false, reasoningEffort: "medium", maxOutputTokens: 8192 });
      expect(JSON.stringify(auxiliary)).not.toContain("never-persist-this");
      expect(journal.filter(event => event.type === "model/provider-event" && event.correlationId === auxiliary.correlationId)).toHaveLength(2);
      const reopened = new SessionKernel({ sessionId, store: new InMemorySessionEventStore(journal) });
      expect(reopened.getEvents()).toEqual(journal);
      const tampered = structuredClone(journal);
      const badInput = tampered.find(event => event.type === "model/auxiliary-request-prepared")!;
      if (badInput.type !== "model/auxiliary-request-prepared") throw new Error("missing input");
      badInput.data.input[0]!.content = "forged summary input";
      expect(() => new SessionKernel({ sessionId, store: new InMemorySessionEventStore(tampered) })).toThrow();
    } finally { await agent.close(); }
  });

  it("halts before provider I/O when the auxiliary request envelope cannot be recorded", async () => {
    process.env.SIFT_CONTEXT_COMPACTION = "0";
    const store = new FailingProviderStore();
    let calls = 0;
    const adapter = createChatCompletionsAdapter({ name: "Meta", model: "test", apiKey: "test", baseUrl: "https://api.meta.ai/v1", fetchImpl: (async () => { calls++; return json(answer()); }) as typeof fetch });
    const agent = await createChatAgent({ adapter, memory: false, tools: [], session: { id: "auxiliary-write-failure", store } });
    try {
      for (let index = 0; index < 5; index++) await agent.chat(longPrompt(index));
      const history = structuredClone(agent.getHistory());
      process.env.SIFT_CONTEXT_COMPACTION = "1";
      process.env.SIFT_CONTEXT_WINDOW = "3000";
      store.failAuxiliary = true;
      await expect(agent.chat("must not dispatch")).rejects.toThrow("auxiliary envelope write failed");
      expect(calls).toBe(5);
      expect(agent.getHistory()).toEqual(history);
    } finally { store.failAuxiliary = false; await agent.close(); }
  });
  it("journals actual adapter attempts and receipts across a tool turn without duplicating text or usage", async () => {
    process.env.SIFT_CONTEXT_COMPACTION = "0";
    const store = new InMemorySessionEventStore();
    const events: AdapterEvent[] = [];
    let calls = 0;
    let effects = 0;
    const adapter = createChatCompletionsAdapter({ name: "Meta", model: "requested-model", apiKey: "test", baseUrl: "https://api.meta.ai/v1", fetchImpl: (async () => {
      calls++;
      if (calls === 1) return json({ ...answer(), choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "probe", arguments: "{}" } }] } }] });
      return new Response([
        { id: "response-2", model: "actual-model", choices: [{ index: 0, delta: { content: "done" } }] },
        { usage: { prompt_tokens: 7, completion_tokens: 1 }, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch });
    const agent = await createChatAgent({ name: "provider-journal", adapter, memory: false, session: { id: "provider-journal-turn", store }, tools: [{ name: "probe", description: "Read fixture", inputSchema: { type: "object", properties: {} }, handler: async () => { effects++; return { success: true, data: "fixture" }; } }] });
    try {
      const chunks = [];
      for await (const chunk of agent.chat("check", { stream: true, onProviderEvent: event => events.push(event) })) chunks.push(chunk);
      const result = chunks.find(chunk => chunk.type === "done")?.result;
      expect(result?.run.status).toBe("completed");
      expect(calls).toBe(2);
      expect(effects).toBe(1);
      expect(result?.providerReceipts).toHaveLength(2);
      expect(new Set(result?.providerReceipts?.map(receipt => receipt.requestId)).size).toBe(2);
      expect(events.filter(event => event.type === "provider.text.delta")).toEqual([{ type: "provider.text.delta", requestId: result!.providerReceipts![1]!.requestId, delta: "done" }]);
      expect(chunks.filter(chunk => chunk.type === "text")).toMatchObject([{ type: "text", text: "done", streamed: true }]);
      const journal = store.read("provider-journal-turn");
      const providerEvents = journal.filter(event => event.type === "model/provider-event");
      expect(providerEvents).toHaveLength(4);
      expect(providerEvents.every(event => event.runId === result?.run.manifest.runId && Boolean(event.stepId))).toBe(true);
      expect(journal.at(-1)?.type).toBe("turn/completed");
      for (const request of journal.filter(event => event.type === "model/request-prepared")) expect(request.data.envelope).toMatchObject({ tools: [{ name: "probe" }] });
    } finally { await agent.close(); }
  });

  for (const provider of ["Meta", "Claude"]) for (const failure of ["provider.attempt", "provider.response"] as const) {
    it(`does not proceed or rewrite history after ${provider} automatic compaction ${failure} journal failure`, async () => {
      process.env.SIFT_CONTEXT_COMPACTION = "0";
      const store = new FailingProviderStore();
      let calls = 0;
      const fetchImpl = (async () => { calls++; return json(provider === "Meta" ? answer() : {
        id: "claude-1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 9, output_tokens: 2 },
      }); }) as typeof fetch;
      const adapter = provider === "Meta"
        ? createChatCompletionsAdapter({ name: "Meta", model: "requested-model", apiKey: "test", baseUrl: "https://api.meta.ai/v1", fetchImpl })
        : createAnthropicAdapter({ apiKey: "test", fetchImpl });
      const agent = await createChatAgent({ name: "compaction-failure", adapter, memory: false, tools: [], session: { id: `compaction-${failure}`, store } });
      try {
        for (let index = 0; index < 5; index++) await agent.chat(longPrompt(index));
        const before = structuredClone(agent.getHistory());
        const callsBefore = calls;
        process.env.SIFT_CONTEXT_COMPACTION = "1";
        process.env.SIFT_CONTEXT_WINDOW = "3000";
        store.failAt = failure;
        await expect(agent.chat("do not run after failed journal")).rejects.toMatchObject({
          message: "Provider event could not be recorded or delivered",
          cause: { message: "required provider journal write failed" },
        });
        expect(store.rejected).toBe(1);
        expect(calls).toBe(callsBefore + (failure === "provider.response" ? 1 : 0));
        expect(agent.getHistory()).toEqual(before);
      } finally { store.failAt = undefined; await agent.close(); }
    });
  }

  it("filters auxiliary summary deltas even when an adapter ignores stream:false", async () => {
    process.env.SIFT_CONTEXT_COMPACTION = "0";
    let summaries = 0;
    const events: AdapterEvent[] = [];
    const adapter: AIAdapter = { name: "deliberately-chatty", model: "test", async chat(_messages, _registry, options) {
      if (options?.oneShot) {
        summaries++;
        expect(options.stream).toBe(false);
        options.onEvent?.({ type: "provider.text.delta", requestId: "summary", delta: "PRIVATE SUMMARY MUST NOT ENTER ANSWER" });
        return { text: "Retain earlier constraints." };
      }
      options?.onEvent?.({ type: "provider.text.delta", requestId: "main", delta: "visible answer" });
      return { text: "visible answer" };
    } };
    const agent = await createChatAgent({ adapter, memory: false, tools: [], session: { id: "summary-isolation", store: new InMemorySessionEventStore() } });
    try {
      for (let index = 0; index < 5; index++) await agent.chat(longPrompt(index));
      process.env.SIFT_CONTEXT_COMPACTION = "1";
      process.env.SIFT_CONTEXT_WINDOW = "3000";
      const result = await agent.chat("continue", { onProviderEvent: event => events.push(event) });
      expect(summaries).toBe(1);
      expect(result.text).toBe("visible answer");
      expect(events).toEqual([{ type: "provider.text.delta", requestId: "main", delta: "visible answer" }]);
      expect(JSON.stringify(agent.getHistory())).not.toContain("PRIVATE SUMMARY");
    } finally { await agent.close(); }
  });

  it("binds tool definitions and execution context before awaiting the model", async () => {
    process.env.SIFT_CONTEXT_COMPACTION = "0";
    const execution = { workspaceRoot: "/before", sessionCwd: "/before", approval: { policy: "allow" as const, scopeId: "before" } };
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const effects: unknown[] = [];
    const tool = { name: "bound", description: "Original binding", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, handler: async (_params: Record<string, unknown>, context?: ToolExecutionContext) => { effects.push({ handler: "original", workspace: context?.workspaceRoot, approval: context?.approval?.scopeId }); return { success: true }; } };
    let requests = 0;
    const adapter: AIAdapter = { name: "deferred", model: "test", async chat() { if (requests++ === 0) { notifyStarted(); await pending; return { toolCall: { id: "bound-1", name: "bound", args: { path: "a.ts" } } }; } return { text: "done" }; } };
    const agent = await createChatAgent({ adapter, memory: false, tools: [tool], executionContext: () => execution, session: { id: "snapshot-bindings", store: new InMemorySessionEventStore() } });
    try {
      const result = agent.chat("use original tool");
      await started;
      execution.workspaceRoot = "/after";
      execution.sessionCwd = "/after";
      execution.approval.scopeId = "after";
      tool.handler = async () => { effects.push({ handler: "replacement" }); return { success: true }; };
      tool.inputSchema.properties.path.type = "number";
      release();
      await result;
      expect(effects).toEqual([{ handler: "original", workspace: "/before", approval: "before" }]);
    } finally { release(); await agent.close(); }
  });
});

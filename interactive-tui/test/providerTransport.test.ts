import { describe, expect, it } from "bun:test";
import { createChatCompletionsAdapter, createOpenAIAdapter, createOpenRouterAdapter } from "../agent-harness/framework/adapters/openai";
import { createGeminiAdapter } from "../agent-harness/framework/adapters/gemini";
import { createAnthropicAdapter } from "../agent-harness/framework/adapters/anthropic";
import { createXAIAdapter } from "../agent-harness/framework/adapters/xai";
import { compatibleBaseUrl, ProviderHttpError, ProviderIncompleteError, ProviderRequestError, ProviderStallError, retryAfterMs } from "../agent-harness/framework/adapters/transport";
import type { AdapterEvent, ChatMessage } from "../agent-harness/framework/adapters/types";
import { ToolRegistry } from "../agent-harness/framework/registry";

const registry = new ToolRegistry();
const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
const completion = (content = "hello") => ({ id: "response-1", model: "served-model", usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } }, choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const sse = (events: unknown[], done = true) => new Response(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + (done ? "data: [DONE]\r\n\r\n" : ""), { headers: { "content-type": "text/event-stream", "x-request-id": "upstream-id" } });
const adapter = (fetchImpl: typeof fetch, events: AdapterEvent[], extra = {}) => createChatCompletionsAdapter({ name: "Meta", model: "muse-wonder-1.0", apiKey: "secret-never-log", baseUrl: "https://api.meta.ai/v1/", fetchImpl, onEvent: event => events.push(event), retry: { baseDelayMs: 0, maxDelayMs: 20 }, ...extra });

describe("provider transport reliability", () => {
  it.each(['muse-spark-1.3-contributor', 'meta:muse-spark-1.3-contributor', 'meta/muse-spark-1.2-contributor', 'muse-spark-1-2-contributor'])('normalizes retired Contributor %s when the generic Meta adapter is called directly', async retiredModel => {
    const events: AdapterEvent[] = [];
    let sentModel: string | undefined;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      sentModel = JSON.parse(String(init?.body)).model;
      return new Response(JSON.stringify({choices: [{finish_reason: 'stop', message: {role: 'assistant', content: 'ok'}}]}), {headers: {'content-type': 'application/json'}});
    };
    const client = adapter(fetchImpl as typeof fetch, events, {model: retiredModel});
    const result = await client.chat([{role: 'user', content: 'hello'}], new ToolRegistry(), {stream: false});
    expect(client.model).toBe('muse-spark-1.3');
    expect(sentModel).toBe('muse-spark-1.3');
    expect(events.filter(event => event.type === 'provider.attempt')).toEqual([
      expect.objectContaining({requestedModel: sentModel}),
    ]);
    expect(events.filter(event => event.type === 'provider.response')).toEqual([
      expect.objectContaining({receipt: expect.objectContaining({requestedModel: sentModel, outcome: 'completed'})}),
    ]);
    expect(result.providerReceipts).toEqual([
      expect.objectContaining({requestedModel: sentModel, outcome: 'completed'}),
    ]);
  });
  it.each([
    {name: 'OpenRouter', model: 'muse-spark-1.3-contributor'},
    {name: 'Meta', model: 'future-muse-model'},
  ])('preserves $name model $model in requests and transport evidence', async selection => {
    const events: AdapterEvent[] = [];
    let sentModel: string | undefined;
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      sentModel = JSON.parse(String(init?.body)).model;
      return json(completion());
    };
    const client = adapter(fetchImpl as typeof fetch, events, selection);
    const result = await client.chat(messages, registry, {stream: false});
    expect(client.model).toBe(selection.model);
    expect(sentModel).toBe(selection.model);
    expect(events.filter(event => event.type === 'provider.attempt')).toEqual([
      expect.objectContaining({requestedModel: selection.model}),
    ]);
    expect(result.providerReceipts).toEqual([
      expect.objectContaining({requestedModel: selection.model, outcome: 'completed'}),
    ]);
  });

  it("defaults GPT-6.1 Sol to medium reasoning through Responses", async () => {
    const client = createOpenAIAdapter({ apiKey: "test", fetchImpl: (async (url, init) => {
      expect(String(url)).toBe("https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("gpt-6.1-sol");
      expect(body.reasoning).toEqual({ effort: "medium" });
      expect(body.temperature).toBeUndefined();
      return json({id: "sol-response", output: [{type: "message", content: [{type: "output_text", text: "done"}]}]});
    }) as typeof fetch });
    expect((await client.chat(messages, registry, {stream: false})).text).toBe("done");
  });

  it("rejects unsupported GPT-6.1 Sol efforts before dispatch", () => {
    for (const reasoningEffort of ["none", "minimal"] as const) {
      expect(() => createOpenAIAdapter({apiKey: "test", reasoningEffort})).toThrow("GPT-6.1 Sol supports reasoning efforts");
    }
  });

  for (const model of ["gpt-6-astra", "gpt-6-luna", "gpt-6-astra-2026-09-29"]) {
    it(`defaults ${model} to medium reasoning without temperature`, async () => {
      const client = createOpenAIAdapter({apiKey: "test", model, fetchImpl: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe(model);
        expect(body.reasoning).toEqual({effort: "medium"});
        expect(body.temperature).toBeUndefined();
        return json({id: "gpt6-response", output: [{type: "message", content: [{type: "output_text", text: "done"}]}]});
      }) as typeof fetch});
      expect((await client.chat(messages, registry, {stream: false})).text).toBe("done");
    });
  }

  it("forwards explicit GPT-6 Luna none reasoning without temperature", async () => {
    const client = createOpenAIAdapter({apiKey: "test", model: "gpt-6-luna", reasoningEffort: "none", fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.reasoning).toEqual({effort: "none"});
      expect(body.temperature).toBeUndefined();
      return json({id: "luna-response", output: [{type: "message", content: [{type: "output_text", text: "done"}]}]});
    }) as typeof fetch});
    expect((await client.chat(messages, registry, {stream: false})).text).toBe("done");
  });

  it("rejects unsupported Astra and Luna efforts before dispatch", () => {
    for (const reasoningEffort of ["none", "minimal"] as const) {
      expect(() => createOpenAIAdapter({apiKey: "test", model: "gpt-6-astra", reasoningEffort})).toThrow("GPT-6 Astra supports reasoning efforts");
    }
    expect(() => createOpenAIAdapter({apiKey: "test", model: "gpt-6-luna", reasoningEffort: "minimal"})).toThrow("GPT-6 Luna supports reasoning efforts");
  });

  for (const count of [1, 2]) it(`preserves buffered text accompanying ${count} tool call(s) without synthesizing streaming deltas`, async () => {
    const events: AdapterEvent[] = [];
    const client = adapter((async () => json({id: "buffered-tools", choices: [{finish_reason: "tool_calls", message: {
      role: "assistant", content: "Checking the candidate.", tool_calls: Array.from({length: count}, (_, i) => ({
        id: `call-${i}`, type: "function", function: {name: "read_file", arguments: JSON.stringify({path: "candidate.txt"})},
      })),
    }}]})) as typeof fetch, events);
    const result = await client.chat(messages, registry, {stream: true});
    expect(result.text).toBe("Checking the candidate.");
    expect(count === 1 ? result.toolCall?.name : result.toolCalls?.length).toBe(count === 1 ? "read_file" : 2);
    expect(events.filter(event => event.type === "provider.text.delta")).toHaveLength(0);
  });

  it("does not retry typed local limits and retains safe machine-readable failure evidence", async () => {
    for (const [code, status] of [
      ["gateway_attempt_limit", 429], ["gateway_spend_limit", 429], ["gateway_ledger_limit", 429],
      ["gateway_deadline", 408], ["gateway_revoked", 503], ["gateway_ledger_unavailable", 503],
    ] as const) {
      const events: AdapterEvent[] = [];
      let calls = 0;
      const client = adapter((async () => {
        calls++;
        return json({ error: { message: "secret-never-log" } }, status, {
          "x-sift-error-code": code, "x-sift-error-retryable": "false", "retry-after": "0",
        });
      }) as typeof fetch, events);
      let error: unknown;
      try { await client.chat(messages, registry); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(ProviderRequestError);
      expect(error).toMatchObject({ code, status, retryable: false });
      expect(calls).toBe(1);
      expect(events.filter(event => event.type === "provider.retry")).toHaveLength(0);
      expect(events.filter(event => event.type === "provider.response")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: "provider.response", receipt: { attempts: 1, outcome: "failed", status, error: { code, retryable: false } } });
      expect(JSON.stringify(events)).not.toContain("secret-never-log");
      expect(String(error)).not.toContain("secret-never-log");
    }
  });

  it("recovers transient 429 then stops at a local limit without replaying that denial", async () => {
    const events: AdapterEvent[] = [];
    let calls = 0;
    const client = adapter((async () => ++calls === 1 ? json({}, 429, { "retry-after": "0" }) :
      json({}, 429, { "x-sift-error-code": "gateway_attempt_limit", "x-sift-error-retryable": "false" })) as typeof fetch, events);
    await expect(client.chat(messages, registry)).rejects.toMatchObject({ code: "gateway_attempt_limit" });
    expect(calls).toBe(2);
    expect(events.filter(event => event.type === "provider.retry")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "provider.response", receipt: { attempts: 2, error: { code: "gateway_attempt_limit", retryable: false } } });
  });

  it("does not mistake prose or unknown header codes for terminal admission", async () => {
    for (const headers of [{}, { "x-sift-error-code": "unknown", "x-sift-error-retryable": "false" }, { "x-sift-error-code": "gateway_attempt_limit" }]) {
      let calls = 0;
      const events: AdapterEvent[] = [];
      const client = adapter((async () => ++calls === 1 ? json({ error: { message: "Gateway attempt budget exhausted" } }, 429, headers) : json(completion())) as typeof fetch, events);
      await client.chat(messages, registry, { stream: false });
      expect(calls).toBe(2);
      expect(events.at(-1)).toMatchObject({ type: "provider.response", receipt: { outcome: "completed", attempts: 2 } });
    }
  });
  it("preserves required observer failures across Anthropic SDK error wrapping", async () => {
    const requiredFailure = new Error("required journal failed");
    let calls = 0;
    const client = createAnthropicAdapter({ apiKey: "test", onEvent: () => { throw requiredFailure; }, fetchImpl: (async () => { calls++; return json({}); }) as typeof fetch });
    await expect(client.chat(messages, registry, { stream: false })).rejects.toBe(requiredFailure);
    expect(calls).toBe(0);
  });
  it("preserves terminal admission errors across Anthropic SDK error wrapping", async () => {
    const events: AdapterEvent[] = [];
    let calls = 0;
    const client = createAnthropicAdapter({ apiKey: "test", onEvent: event => events.push(event), fetchImpl: (async () => {
      calls++;
      return json({ error: { message: "secret-never-log" } }, 429, {
        "x-sift-error-code": "gateway_spend_limit", "x-sift-error-retryable": "false",
      });
    }) as typeof fetch });
    await expect(client.chat(messages, registry, { stream: false })).rejects.toMatchObject({
      name: "ProviderRequestError", code: "gateway_spend_limit", status: 429, retryable: false,
    });
    expect(calls).toBe(1);
    expect(events.filter(event => event.type === "provider.retry")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "provider.response", receipt: {
      attempts: 1, outcome: "failed", error: { code: "gateway_spend_limit", retryable: false },
    } });
  });
  it("uses direct Meta reasoning_effort and retains OpenRouter's nested control", async () => {
    const direct = adapter((async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.reasoning_effort).toBe("medium");
      expect(body.reasoning).toBeUndefined();
      return json(completion());
    }) as typeof fetch, [], { reasoningEffort: "medium" });
    await direct.chat(messages, registry, { stream: false });
    const openrouter = createOpenRouterAdapter({ apiKey: "test", reasoningEffort: "medium", fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.reasoning).toEqual({ effort: "medium" });
      expect(body.reasoning_effort).toBeUndefined();
      return json(completion());
    }) as typeof fetch });
    await openrouter.chat(messages, registry);
  });
  it("validates explicit output budgets and forwards each provider's field", async () => {
    const cases = [
      { factory: createOpenAIAdapter, body: { id: "r1", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] }, capField: "max_output_tokens" },
      { factory: createXAIAdapter, body: { id: "r1", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] }, capField: "max_output_tokens" },
      { factory: createGeminiAdapter, body: { candidates: [{ content: { parts: [{ text: "done" }] } }] }, capField: "generationConfig" },
      { factory: createAnthropicAdapter, body: { id: "a1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }, capField: "max_tokens" },
    ];
    for (const { factory, body, capField } of cases) {
      for (const maxOutputTokens of [0, -1, 1.2, NaN, Infinity, 131073]) expect(() => factory({ apiKey: "test", maxOutputTokens })).toThrow("maxOutputTokens");
      const client = factory({ apiKey: "test", maxOutputTokens: 8192, fetchImpl: (async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        expect(capField === "generationConfig" ? request.generationConfig.maxOutputTokens : request[capField]).toBe(8192);
        return json(body);
      }) as typeof fetch });
      await client.chat(messages, registry);
    }
    const client = adapter((async (_url, init) => { expect(JSON.parse(String(init?.body)).max_tokens).toBe(8192); return json(completion()); }) as typeof fetch, [], { maxOutputTokens: 8192 });
    await client.chat(messages, registry, { stream: false });
    expect(() => adapter(fetch, [], { maxOutputTokens: 0 })).toThrow("maxOutputTokens");
  });

  it("retains known usage when an incomplete generation cannot be executed", async () => {
    const events: AdapterEvent[] = [];
    const client = adapter((async () => sse([{ id: "partial", model: "served", usage: { prompt_tokens: 10, completion_tokens: 7 }, choices: [{ index: 0, delta: {}, finish_reason: "length" }] }])) as typeof fetch, events);
    await expect(client.chat(messages, registry)).rejects.toThrow("incomplete");
    expect(events.at(-1)).toMatchObject({ type: "provider.response", receipt: { outcome: "failed", responseId: "partial", usage: { inputTokens: 10, outputTokens: 7 } } });
  });
  it("fails closed on observer errors before dispatch and never retries a failed receipt write", async () => {
    for (const failAt of ["provider.attempt", "provider.response"]) {
      let calls = 0;
      const client = adapter((async () => { calls++; return json(completion()); }) as typeof fetch, [], {
        onEvent: (event: AdapterEvent) => { if (event.type === failAt) throw new Error("journal write failed"); },
      });
      await expect(client.chat(messages, registry, { stream: false })).rejects.toThrow("journal write failed");
      expect(calls).toBe(failAt === "provider.attempt" ? 0 : 1);
    }
  });
  it("counts rejected HTTP attempts, retry and served identity including auxiliary calls", async () => {
    const events: AdapterEvent[] = [];
    let calls = 0;
    const client = adapter((async (url, init) => {
      expect(String(url)).toBe("https://api.meta.ai/v1/chat/completions");
      expect(init?.redirect).toBe("error");
      calls += 1;
      return calls < 3 ? json({ error: "secret-never-log" }, calls === 1 ? 429 : 503, { "retry-after": "0" }) : json(completion(), 200, { "x-request-id": "upstream-123" });
    }) as typeof fetch, events);
    const result = await client.chat(messages, registry, { oneShot: true, stream: false });
    expect(calls).toBe(3);
    expect(events.filter(event => event.type === "provider.attempt")).toHaveLength(3);
    expect(events.filter(event => event.type === "provider.retry")).toHaveLength(2);
    expect(events.filter(event => event.type === "provider.attempt").every(event => event.oneShot)).toBe(true);
    expect(result.providerReceipts?.[0]).toMatchObject({ provider: "Meta", requestedModel: "muse-wonder-1.0", servedModel: "served-model", providerRequestId: "upstream-123", responseId: "response-1", attempts: 3, mode: "buffered", outcome: "completed", usage: { inputTokens: 12, outputTokens: 5, cachedInputTokens: 4 } });
    expect(JSON.stringify(events)).not.toContain("secret-never-log");
  });

  it("does not retry auth errors or unknown network failures, and reports failure", async () => {
    for (const mode of ["auth", "network"]) {
      const events: AdapterEvent[] = [];
      let calls = 0;
      const client = adapter((async () => { calls++; if (mode === "network") throw new Error("connection closed"); return json({ error: "secret-never-log" }, 401); }) as typeof fetch, events);
      await expect(client.chat(messages, registry)).rejects.toThrow(mode === "auth" ? "Meta API error (401)" : "connection closed");
      expect(calls).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: "provider.response", receipt: { outcome: "failed", attempts: 1 } });
      expect(JSON.stringify(events)).not.toContain("secret-never-log");
    }
  });

  it("honors Retry-After dates and declines excessive waits rather than retrying early", async () => {
    expect(retryAfterMs("Wed, 09 Sep 2026 00:00:03 GMT", Date.parse("2026-09-09T00:00:00Z"))).toBe(3000);
    expect(retryAfterMs("0.5")).toBe(500);
    for (const value of ["-1", "2026-09-09", "tomorrow", "1e9", "12\r\nx-other: value", "9".repeat(161)]) expect(retryAfterMs(value)).toBeUndefined();
    const events: AdapterEvent[] = [];
    let calls = 0;
    const client = adapter((async () => { calls++; return json({}, 429, { "retry-after": "60" }); }) as typeof fetch, events);
    await expect(client.chat(messages, registry)).rejects.toThrow("429");
    expect(calls).toBe(1);
    expect(events.some(event => event.type === "provider.retry")).toBe(false);
  });

  it("watches a declined-wait error body for stalls instead of hanging", async () => {
    const events: AdapterEvent[] = [];
    let calls = 0, cancelled = false;
    const client = createXAIAdapter({
      apiKey: "secret-never-log",
      fetchImpl: (async () => {
        calls++;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode('{"error":')); },
          cancel() { cancelled = true; },
        }), {
          status: 429, headers: { "retry-after": "3600" },
        });
      }) as typeof fetch,
      onEvent: event => events.push(event),
      retry: { baseDelayMs: 0, maxDelayMs: 20 },
      timeouts: { idleMs: 20 },
    });
    const error = await client.chat(messages, registry, { stream: false }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderStallError);
    expect(error).toMatchObject({ phase: "body" });
    expect(calls).toBe(1);
    expect(cancelled).toBe(true);
    expect(events.filter(event => event.type === "provider.retry")).toHaveLength(0);
  });

  it("cancels a pending backoff without another HTTP request", async () => {
    const events: AdapterEvent[] = [];
    const controller = new AbortController();
    let calls = 0;
    const client = adapter((async () => { calls++; return json({}, 429); }) as typeof fetch, events, { retry: { baseDelayMs: 10_000 }, onEvent: (event: AdapterEvent) => { events.push(event); if (event.type === "provider.retry") controller.abort(new Error("stopped")); } });
    await expect(client.chat(messages, registry, { signal: controller.signal })).rejects.toThrow("stopped");
    expect(calls).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "provider.response", receipt: { outcome: "cancelled" } });
  });

  it("keeps cancellation authoritative before dispatch and after terminal response headers", async () => {
    for (const beforeDispatch of [true, false]) {
      const events: AdapterEvent[] = [];
      const controller = new AbortController();
      const stop = new Error("cancelled by caller");
      let calls = 0, bodyCancelled = false;
      if (beforeDispatch) controller.abort(stop);
      const client = adapter((async () => {
        calls++;
        controller.abort(stop);
        return new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }), { status: 429,
          headers: { "x-sift-error-code": "gateway_attempt_limit", "x-sift-error-retryable": "false" } });
      }) as typeof fetch, events);
      await expect(client.chat(messages, registry, { signal: controller.signal })).rejects.toBe(stop);
      expect(calls).toBe(beforeDispatch ? 0 : 1);
      expect(bodyCancelled).toBe(!beforeDispatch);
      expect(events.at(-1)).toMatchObject({ type: "provider.response", receipt: { attempts: calls, outcome: "cancelled" } });
      expect(events.filter(event => event.type === "provider.retry")).toHaveLength(0);
    }
  });

  it("uses the Retry-After minimum for transient backoff instead of retrying early", async () => {
    const events: AdapterEvent[] = [];
    let calls = 0;
    const client = adapter((async () => ++calls === 1 ? json({}, 429, { "retry-after": "0.01" }) : json(completion())) as typeof fetch, events);
    await client.chat(messages, registry, { stream: false });
    expect(calls).toBe(2);
    expect(events.find(event => event.type === "provider.retry")).toMatchObject({ attempt: 1, delayMs: 10 });
  });

  it("emits text before stream completion and keeps tool calls private until terminal validation", async () => {
    const events: AdapterEvent[] = [];
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
    const client = adapter((async () => new Response(body, { headers: { "content-type": "text/event-stream" } })) as typeof fetch, events);
    let settled = false;
    const promise = client.chat(messages, registry).then(result => { settled = true; return result; });
    streamController.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"hé"}}]}\n\n'));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(events.some(event => event.type === "provider.text.delta" && event.delta === "hé")).toBe(true);
    expect(settled).toBe(false);
    streamController.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n'));
    streamController.enqueue(encoder.encode('data: {"model":"served-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'));
    streamController.close();
    const result = await promise;
    expect(result.toolCall).toEqual({ id: "call-1", name: "read_file", args: { path: "a.ts" } });
    expect(result.providerReceipts?.[0]).toMatchObject({ mode: "streaming", servedModel: "served-model" });
  });

  it("rejects truncated, malformed and length-limited tools without retrying", async () => {
    for (const scenario of ["truncated", "malformed", "length"]) {
      const events: AdapterEvent[] = [];
      let calls = 0;
      const client = adapter((async () => { calls++; return sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "write_file", arguments: scenario === "malformed" ? "{" : "{}" } }] }, ...(scenario === "truncated" ? {} : { finish_reason: scenario === "length" ? "length" : "tool_calls" }) }] }], scenario !== "truncated"); }) as typeof fetch, events);
      await expect(client.chat(messages, registry)).rejects.toThrow();
      expect(calls).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: "provider.response", receipt: { outcome: "failed" } });
    }
  });

  it("streams Responses while preserving continuation and usage", async () => {
    for (const factory of [createOpenAIAdapter, createXAIAdapter]) {
      const events: AdapterEvent[] = [];
      const client = factory({ apiKey: "test", model: "test-model", baseUrl: "http://127.0.0.1:1234/v1", onEvent: event => events.push(event), fetchImpl: (async (url, init) => {
        expect(String(url)).toBe("http://127.0.0.1:1234/v1/responses");
        expect(JSON.parse(String(init?.body)).stream).toBe(true);
        return sse([{ type: "response.output_text.delta", delta: "hello" }, { type: "response.completed", response: { id: "resp-1", model: "actual", status: "completed", usage: { input_tokens: 3, output_tokens: 2 }, output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }] } }], false);
      }) as typeof fetch });
      const result = await client.chat(messages, registry);
      expect(result.text).toBe("hello");
      expect(result.sessionState?.continuationId).toBe("resp-1");
      expect(result.providerReceipts?.[0]).toMatchObject({ mode: "streaming", usage: { inputTokens: 3, outputTokens: 2 } });
      expect(events.filter(event => event.type === "provider.text.delta")).toHaveLength(1);
    }
  });

  it("maps Responses HTTP failures to ProviderHttpError, before and after continuation recovery", async () => {
    // Initial request: a 413 must surface as a typed HTTP error so the agent can prune and retry.
    let calls = 0;
    const initial = createOpenAIAdapter({ apiKey: "test", model: "test-model", baseUrl: "http://127.0.0.1:1234/v1", fetchImpl: (async () => { calls++; return new Response("too large", { status: 413 }); }) as typeof fetch });
    await expect(initial.chat(messages, registry)).rejects.toBeInstanceOf(ProviderHttpError);
    await expect(initial.chat(messages, registry)).rejects.toMatchObject({ status: 413 });
    expect(calls).toBe(2);

    // Continuation recovery: the missing-continuation branch still resends the full
    // history, and a 413 on that resend is typed as well.
    const bodies: Record<string, unknown>[] = [];
    let stage = 0;
    const client = createOpenAIAdapter({ apiKey: "test", model: "test-model", baseUrl: "http://127.0.0.1:1234/v1", fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      stage++;
      if (stage === 1) return sse([{ type: "response.output_text.delta", delta: "hello" }, { type: "response.completed", response: { id: "resp-1", model: "actual", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }] } }], false);
      if (stage === 2) return new Response("previous_response_id resp-1 not found", { status: 400 });
      return new Response("too large", { status: 413 });
    }) as typeof fetch });
    const first = await client.chat(messages, registry);
    expect(first.sessionState?.continuationId).toBe("resp-1");
    const followUp: ChatMessage[] = [...messages, { role: "assistant", content: "hello", providerReplay: first.providerReplay }, { role: "user", content: "again" }];
    await expect(client.chat(followUp, registry, { sessionState: first.sessionState })).rejects.toMatchObject({ name: "ProviderHttpError", status: 413 });
    expect(bodies).toHaveLength(3);
    expect(bodies[1]!.previous_response_id).toBe("resp-1");
    expect(bodies[2]!.previous_response_id).toBeUndefined();
  });

  it("classifies Responses output-limit truncation as ProviderIncompleteError with visible-output tracking", async () => {
    const make = (fetchImpl: typeof fetch) => createOpenAIAdapter({ apiKey: "test", model: "test-model", baseUrl: "http://127.0.0.1:1234/v1", fetchImpl });
    const incomplete = (reason: string, output: unknown[] = []) => ({ id: "resp-x", model: "actual", status: "incomplete", incomplete_details: { reason }, output });
    // Streamed: reasoning consumed the cap with nothing visible -> replayable.
    await expect(make((async () => sse([{ type: "response.incomplete", response: incomplete("max_output_tokens") }], false)) as typeof fetch).chat(messages, registry))
      .rejects.toMatchObject({ name: "ProviderIncompleteError", finishReason: "length", visibleOutput: false });
    // Streamed: partial text already went out -> not replayable.
    await expect(make((async () => sse([{ type: "response.output_text.delta", delta: "partial" }, { type: "response.incomplete", response: incomplete("max_output_tokens") }], false)) as typeof fetch).chat(messages, registry))
      .rejects.toMatchObject({ name: "ProviderIncompleteError", finishReason: "length", visibleOutput: true });
    // Non-streamed: same classification from the response body.
    await expect(make((async () => Response.json(incomplete("max_output_tokens"))) as typeof fetch).chat(messages, registry))
      .rejects.toMatchObject({ name: "ProviderIncompleteError", finishReason: "length", visibleOutput: false });
    await expect(make((async () => Response.json(incomplete("max_output_tokens", [{ type: "function_call", call_id: "c1", name: "write_file", arguments: "{}" }]))) as typeof fetch).chat(messages, registry))
      .rejects.toMatchObject({ name: "ProviderIncompleteError", finishReason: "length", visibleOutput: true });
    // A refusal is visible output: refusal-only truncations are not replayed, buffered or streamed.
    await expect(make((async () => Response.json(incomplete("max_output_tokens", [{ type: "message", content: [{ type: "refusal", refusal: "I cannot help with that." }] }]))) as typeof fetch).chat(messages, registry))
      .rejects.toMatchObject({ name: "ProviderIncompleteError", finishReason: "length", visibleOutput: true });
    const refusalEvents: AdapterEvent[] = [];
    const streamedRefusal = createOpenAIAdapter({ apiKey: "test", model: "test-model", baseUrl: "http://127.0.0.1:1234/v1", onEvent: event => refusalEvents.push(event), fetchImpl: (async () => sse([{ type: "response.refusal.delta", delta: "I cannot" }, { type: "response.incomplete", response: incomplete("max_output_tokens") }], false)) as typeof fetch });
    await expect(streamedRefusal.chat(messages, registry, { stream: true })).rejects.toMatchObject({ name: "ProviderIncompleteError", finishReason: "length", visibleOutput: true });
    // The truncated refusal itself was delivered before the stream ended.
    expect(refusalEvents.filter(event => event.type === "provider.text.delta").map(event => (event as { delta: string }).delta)).toEqual(["I cannot"]);
    // Any other incomplete reason stays a plain, non-retryable error.
    const other = make((async () => Response.json(incomplete("content_filter"))) as typeof fetch);
    await expect(other.chat(messages, registry)).rejects.toThrow("OpenAI response is incomplete");
    await expect(other.chat(messages, registry)).rejects.not.toBeInstanceOf(ProviderIncompleteError);
  });

  it("cancels blocked stream reads and retains a cancelled outcome", async () => {
    const events: AdapterEvent[] = [];
    const controller = new AbortController();
    let cancelled = false;
    const client = adapter((async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch, events);
    const pending = client.chat(messages, registry, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stop stream")), 5);
    await expect(pending).rejects.toThrow("stop stream");
    expect(cancelled).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "provider.response", receipt: { outcome: "cancelled" } });
  });

  it("observes a buffered Gemini request without exposing its key in URL or events", async () => {
    const events: AdapterEvent[] = [];
    const client = createGeminiAdapter({ apiKey: "secret-never-log", onEvent: event => events.push(event), fetchImpl: (async (url, init) => {
      expect(String(url)).not.toContain("secret-never-log");
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("secret-never-log");
      return json({ responseId: "g1", modelVersion: "gemini-served", candidates: [{ finishReason: "STOP", content: { parts: [{ text: "hello" }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } });
    }) as typeof fetch });
    const result = await client.chat(messages, registry, { oneShot: true });
    expect(result.providerReceipts?.[0]).toMatchObject({ mode: "buffered", servedModel: "gemini-served", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } });
    expect(events.some(event => event.type === "provider.text.delta")).toBe(false);
  });

  it("owns Anthropic retries rather than letting SDK retries hide attempts", async () => {
    const events: AdapterEvent[] = [];
    let calls = 0;
    const client = createAnthropicAdapter({ apiKey: "test", onEvent: event => events.push(event), retry: { baseDelayMs: 0 }, fetchImpl: (async () => {
      calls++;
      if (calls === 1) return json({ type: "error", error: { type: "overloaded_error", message: "busy" } }, 503);
      return json({ id: "a1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1 } });
    }) as typeof fetch });
    const result = await client.chat(messages, registry, { stream: false });
    expect(result.text).toBe("done");
    expect(result.providerReceipts?.[0]).toMatchObject({ attempts: 2, usage: { inputTokens: 2, outputTokens: 1 } });
    expect(calls).toBe(2);
  });

  it("keeps default and per-call observers mutually exclusive and rejects credential URLs", async () => {
    const events: AdapterEvent[] = [];
    const perCall: AdapterEvent[] = [];
    const client = adapter((async () => json(completion())) as typeof fetch, events);
    await client.chat(messages, registry, { stream: false, onEvent: event => perCall.push(event) });
    expect(events).toHaveLength(0);
    expect(perCall).toHaveLength(2);
    for (const url of ["https://user:secret@example.com/v1", "https://example.com/v1?key=secret", "file:///secret"]) expect(() => compatibleBaseUrl(url)).toThrow();
  });

  // A fetch that never answers but honors abort the way the real one does.
  const hanging = (onCall?: () => void): typeof fetch => ((_url: unknown, init?: RequestInit) => new Promise((_, reject) => {
    onCall?.();
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
  })) as typeof fetch;
  // A body that emits the given chunks then never closes; reports upstream cancellation.
  const openEnded = (chunks: string[], contentType: string, onCancel: () => void, gapMs = 0) => new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        if (gapMs) await new Promise(resolve => setTimeout(resolve, gapMs));
        controller.enqueue(encoder.encode(chunk));
      }
    },
    cancel() { onCancel(); },
  }), { headers: { "content-type": contentType } });

  for (const stream of [true, false]) it(`fails a ${stream ? "streaming" : "buffered"} request whose headers never arrive, without retrying`, async () => {
    const events: AdapterEvent[] = [];
    let calls = 0;
    const client = adapter(hanging(() => { calls++; }), events, { timeouts: { headersMs: 20 } });
    const error = await client.chat(messages, registry, { stream }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderStallError);
    expect(error).toMatchObject({ phase: "headers", elapsedMs: 20, retryable: false });
    expect(calls).toBe(1);
    expect(events.filter(event => event.type === "provider.retry")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "provider.response", receipt: { outcome: "failed", attempts: 1 } });
  });

  it("fails a streaming body that stops mid-generation and cancels the upstream reader", async () => {
    const events: AdapterEvent[] = [];
    let cancelled = false;
    const client = adapter((async () => openEnded([`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\r\n\r\n`], "text/event-stream", () => { cancelled = true; })) as typeof fetch, events, { timeouts: { idleMs: 20 } });
    const error = await client.chat(messages, registry, { stream: true }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderStallError);
    expect(error).toMatchObject({ phase: "body", elapsedMs: 20 });
    expect(events.find(event => event.type === "provider.text.delta")).toMatchObject({ delta: "hi" });
    expect(events.at(-1)).toMatchObject({ type: "provider.response", receipt: { outcome: "failed", mode: "streaming" } });
    expect(cancelled).toBe(true);
  });

  it("fails a buffered body that stops mid-transfer", async () => {
    const events: AdapterEvent[] = [];
    let cancelled = false;
    const client = adapter((async () => openEnded(['{"id":'], "application/json", () => { cancelled = true; })) as typeof fetch, events, { timeouts: { idleMs: 20 } });
    const error = await client.chat(messages, registry, { stream: false }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderStallError);
    expect(error).toMatchObject({ phase: "body" });
    expect(events.at(-1)).toMatchObject({ type: "provider.response", receipt: { outcome: "failed", mode: "buffered" } });
    expect(cancelled).toBe(true);
  });

  it("treats keepalive comments as progress so slow generations are not mistaken for stalls", async () => {
    const events: AdapterEvent[] = [];
    const chunks = [": keepalive\n\n", ": keepalive\n\n", ": keepalive\n\n", ": keepalive\n\n",
      `data: ${JSON.stringify({ id: "r", choices: [{ delta: { content: "slow answer" }, finish_reason: "stop" }] })}\r\n\r\ndata: [DONE]\r\n\r\n`];
    const client = adapter((async () => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) { await new Promise(resolve => setTimeout(resolve, 10)); controller.enqueue(encoder.encode(chunk)); }
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch, events, { timeouts: { idleMs: 35 } });
    const result = await client.chat(messages, registry, { stream: true });
    expect(result.text).toBe("slow answer");
    expect(events.at(-1)).toMatchObject({ type: "provider.response", receipt: { outcome: "completed" } });
  });

  it("clears both watchdogs after a completed request", async () => {
    const events: AdapterEvent[] = [];
    const client = adapter((async () => json(completion())) as typeof fetch, events, { timeouts: { headersMs: 20, idleMs: 20 } });
    const result = await client.chat(messages, registry, { stream: false });
    expect(result.text).toBe("hello");
    const settled = events.length;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(events).toHaveLength(settled);
    expect(events.at(-1)).toMatchObject({ type: "provider.response", receipt: { outcome: "completed" } });
  });

  it("jitters local backoff within [half, full] and never below the Retry-After floor", async () => {
    const run = async (extra: Record<string, unknown>, retryAfter?: string) => {
      const events: AdapterEvent[] = [];
      let calls = 0;
      const client = adapter((async () => ++calls === 1 ? json({}, 429, retryAfter ? { "retry-after": retryAfter } : {}) : json(completion())) as typeof fetch, events, { retry: { baseDelayMs: 20, maxDelayMs: 1000 }, ...extra });
      await client.chat(messages, registry, { stream: false });
      expect(calls).toBe(2);
      return (events.find(event => event.type === "provider.retry") as { delayMs: number }).delayMs;
    };
    expect(await run({ randomImpl: () => 0 })).toBe(10);
    expect(await run({ randomImpl: () => 0.999 })).toBe(20);
    expect(await run({ randomImpl: () => 0.5 })).toBe(15);
    // Server minimum wins over any jitter outcome.
    expect(await run({ randomImpl: () => 0 }, "0.05")).toBe(50);
  });
});

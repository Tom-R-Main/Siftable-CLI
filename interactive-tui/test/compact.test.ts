/**
 * Public ChatAgent.compact() — the engine behind the TUI's `/compact`. Uses a
 * mock adapter (no network) to prove a forced compaction summarizes the older
 * turns of a within-budget thread and reports before/after token counts.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { homedir } from "node:os";
import { existsSync, rmSync } from "node:fs";
import { createChatAgent } from "../agent-harness";
import { rolloutPathForKey } from "../threadEngine";
import {
  InMemorySessionEventStore,
  SessionInvariantError,
  SessionKernel,
} from "../agent-harness/framework/session";
import type { AIAdapter } from "../agent-harness/framework/adapters/types";
import { buildCompactionConfig } from "../agent-harness/framework/compaction";

const KEY = `__sift_test_compact_${process.pid}`;
const PATH = rolloutPathForKey(homedir(), KEY);
const prevFlag = process.env.SIFT_CONTEXT_COMPACTION;
const prevNative = process.env.SIFT_NATIVE;

beforeAll(() => {
  process.env.SIFT_CONTEXT_COMPACTION = "1";
  if (existsSync(PATH)) rmSync(PATH);
});
afterAll(() => {
  if (prevFlag === undefined) delete process.env.SIFT_CONTEXT_COMPACTION;
  else process.env.SIFT_CONTEXT_COMPACTION = prevFlag;
  if (prevNative === undefined) delete process.env.SIFT_NATIVE;
  else process.env.SIFT_NATIVE = prevNative;
  if (existsSync(PATH)) rmSync(PATH);
});

/** Mock adapter that labels the summarizer call so we can prove it ran. */
function mockAdapter(): AIAdapter {
  return {
    name: "mock",
    model: "mock-1",
    chat: async (messages, _registry, options) => {
      if (options?.oneShot) return { text: "SUMMARY: earlier work" };
      return { text: "ok" };
    },
  };
}

describe("buildCompactionConfig output reserve", () => {
  it("keeps the 24k floor for routes on provider defaults or small caps", () => {
    expect(buildCompactionConfig("mock-1").reserved).toBe(24_000);
    expect(buildCompactionConfig("mock-1", { maxOutputTokens: 4_096 }).reserved).toBe(24_000);
  });

  it("reserves the route's output cap plus drift when it exceeds the floor", () => {
    expect(buildCompactionConfig("mock-1", { maxOutputTokens: 64_000 }).reserved).toBe(72_000);
  });

  it("ignores a nonsensical cap", () => {
    expect(buildCompactionConfig("mock-1", { maxOutputTokens: Number.NaN }).reserved).toBe(24_000);
    expect(buildCompactionConfig("mock-1", { maxOutputTokens: -1 }).reserved).toBe(24_000);
  });
});

describe.serial("ChatAgent.compact() (manual /compact)", () => {
  it("forces a within-budget thread to summarize older turns and reports savings", async () => {
    const agent = await createChatAgent({
      name: "t",
      adapter: mockAdapter(),
      persistKey: KEY,
      memory: false,
      tools: [],
    });
    // Build several whole turns — well within any real context window.
    for (let i = 0; i < 5; i += 1) await agent.chat(`question ${i} ${"detail ".repeat(20)}`);
    const before = agent.getHistory().length;

    const outcome = await agent.compact({ force: true });

    expect(outcome.ran).toBe(true);
    expect(outcome.summarized).toBe(true);
    expect(outcome.beforeTokens).toBeGreaterThan(outcome.afterTokens);
    // History shrank and the recap was folded into the surviving first message.
    const history = agent.getHistory();
    expect(history.length).toBeLessThan(before);
    const head = history[0]!;
    const headText = typeof head.content === "string" ? head.content : JSON.stringify(head.content);
    expect(headText).toContain("Earlier conversation summarized");
    expect(headText).toContain("SUMMARY: earlier work");
  });

  it("keeps the original history when the summary would not shrink it", async () => {
    const adapter: AIAdapter = {
      name: "verbose-mock",
      model: "mock-1",
      chat: async (_messages, _registry, options) => {
        // A "summary" far longer than everything it replaces.
        if (options?.oneShot) return { text: "SUMMARY ".repeat(5_000) };
        return { text: "ok" };
      },
    };
    const agent = await createChatAgent({
      name: "t",
      adapter,
      persistKey: `${KEY}_verbose`,
      memory: false,
      tools: [],
    });
    for (let i = 0; i < 5; i += 1) await agent.chat(`question ${i} ${"detail ".repeat(20)}`);
    const before = structuredClone(agent.getHistory());

    const outcome = await agent.compact({ force: true });

    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toContain("would not shrink");
    expect(agent.getHistory()).toEqual(before);
  });

  it("reports a clean no-op when compaction is disabled", async () => {
    process.env.SIFT_CONTEXT_COMPACTION = "0";
    try {
      const agent = await createChatAgent({
        name: "t",
        adapter: mockAdapter(),
        persistKey: `${KEY}_off`,
        memory: false,
        tools: [],
      });
      await agent.chat("hello");
      const outcome = await agent.compact({ force: true });
      expect(outcome.ran).toBe(false);
      expect(outcome.reason).toContain("disabled");
    } finally {
      process.env.SIFT_CONTEXT_COMPACTION = "1";
    }
  });

  it("does not rewrite history when compaction is cancelled during summarization", async () => {
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const adapter: AIAdapter = {
      name: "abortable-mock",
      model: "mock-1",
      async chat(_messages, _registry, options) {
        if (!options?.oneShot) return { text: "ok" };
        notifyStarted();
        return new Promise((_resolve, reject) => {
          const signal = options.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };
    const agent = await createChatAgent({
      name: "t",
      adapter,
      persistKey: `${KEY}_abort`,
      memory: false,
      tools: [],
    });
    for (let i = 0; i < 5; i += 1) {
      await agent.chat(`question ${i} ${"detail ".repeat(20)}`);
    }
    const before = structuredClone(agent.getHistory());
    const controller = new AbortController();
    const compaction = agent.compact({ force: true, signal: controller.signal });
    await started;
    controller.abort(new Error("cancel compaction"));

    await expect(compaction).rejects.toThrow("cancel compaction");
    expect(agent.getHistory()).toEqual(before);
  });

  it("journals planner degradation once per session when the native engine is disabled", async () => {
    process.env.SIFT_NATIVE = "0";
    try {
      const store = new InMemorySessionEventStore();
      const sessionId = `${KEY}_nonative`;
      const agent = await createChatAgent({
        name: "t",
        adapter: mockAdapter(),
        persistKey: `${KEY}_nonative`,
        session: { id: sessionId, store },
        memory: false,
        tools: [],
      });
      for (let i = 0; i < 5; i += 1) await agent.chat(`question ${i}`);
      // Auto-compaction already attempted a plan (history reached 8 messages);
      // these manual calls must not journal the degradation again.
      const outcome = await agent.compact({ force: true });
      expect(outcome.ran).toBe(false);
      expect(outcome.reason).toContain("native-disabled");
      await agent.compact({ force: true });

      const journal = store.read(sessionId);
      const unavailable = journal.filter((e) => e.type === "compaction/planner-unavailable");
      expect(unavailable).toHaveLength(1);
      const event = unavailable[0]!;
      if (event.type !== "compaction/planner-unavailable") throw new Error("unexpected event type");
      expect(event.data.reason).toBe("native-disabled");
      expect(event.correlationId).toBeTruthy();
      expect(event.turnId).toBeUndefined();
      expect(event.stepId).toBeUndefined();

      // The journal replays cleanly: a fresh kernel validates every event.
      const reopened = new SessionKernel({ sessionId, store: new InMemorySessionEventStore(journal) });
      expect(reopened.getEvents()).toEqual(journal);
    } finally {
      delete process.env.SIFT_NATIVE;
    }
  });

  it("stays silent when a reopened session already journaled the degradation", async () => {
    process.env.SIFT_NATIVE = "0";
    try {
      const sessionId = `${KEY}_reopened`;
      const store = new InMemorySessionEventStore();
      new SessionKernel({ sessionId, store }).append({
        type: "compaction/planner-unavailable",
        data: { reason: "native-disabled" },
        correlationId: "seed",
      });
      const agent = await createChatAgent({
        name: "t",
        adapter: mockAdapter(),
        persistKey: `${KEY}_reopened`,
        session: { id: sessionId, store },
        memory: false,
        tools: [],
      });
      for (let i = 0; i < 5; i += 1) await agent.chat(`question ${i}`);
      await agent.compact({ force: true });
      const unavailable = store.read(sessionId).filter((e) => e.type === "compaction/planner-unavailable");
      expect(unavailable).toHaveLength(1);
    } finally {
      delete process.env.SIFT_NATIVE;
    }
  });

  it("retries the journal event when the first append fails", async () => {
    process.env.SIFT_NATIVE = "0";
    try {
      const sessionId = `${KEY}_retry`;
      const store = new InMemorySessionEventStore();
      const agent = await createChatAgent({
        name: "t",
        adapter: mockAdapter(),
        persistKey: `${KEY}_retry`,
        session: { id: sessionId, store },
        memory: false,
        tools: [],
      });
      // Seed a short history (stays within budget, so no auto-compaction notes yet).
      await agent.chat("seed one");
      await agent.chat("seed two");
      const append = store.append.bind(store);
      store.append = () => { throw new Error("journal locked"); };
      const failed = await agent.compact({ force: true });
      expect(failed.ran).toBe(false);
      expect(store.read(sessionId).filter((e) => e.type === "compaction/planner-unavailable")).toHaveLength(0);
      store.append = append;
      await agent.compact({ force: true });
      expect(store.read(sessionId).filter((e) => e.type === "compaction/planner-unavailable")).toHaveLength(1);
    } finally {
      delete process.env.SIFT_NATIVE;
    }
  });

  it("rejects a malformed planner-unavailable journal event", () => {
    const kernel = new SessionKernel({ sessionId: `${KEY}_schema`, store: new InMemorySessionEventStore() });
    expect(() => kernel.append({
      type: "compaction/planner-unavailable",
      data: { reason: "bogus" } as never,
      correlationId: "x",
    })).toThrow(SessionInvariantError);
    expect(() => kernel.append({
      type: "compaction/planner-unavailable",
      data: { reason: "native-missing", detail: "d".repeat(201) },
      correlationId: "x",
    })).toThrow(SessionInvariantError);
  });
});

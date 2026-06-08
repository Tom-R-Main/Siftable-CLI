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
import { createChatAgent } from "../openfunction/framework/index";
import { rolloutPathForKey } from "../threadEngine";
import type { AIAdapter } from "../openfunction/framework/adapters/types";

const KEY = `__sift_test_compact_${process.pid}`;
const PATH = rolloutPathForKey(homedir(), KEY);
const prevFlag = process.env.SIFT_CONTEXT_COMPACTION;

beforeAll(() => {
  process.env.SIFT_CONTEXT_COMPACTION = "1";
  if (existsSync(PATH)) rmSync(PATH);
});
afterAll(() => {
  if (prevFlag === undefined) delete process.env.SIFT_CONTEXT_COMPACTION;
  else process.env.SIFT_CONTEXT_COMPACTION = prevFlag;
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

describe("ChatAgent.compact() (manual /compact)", () => {
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
});

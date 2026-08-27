/**
 * End-to-end proof of the rollout persist -> resume loop through the real
 * ChatAgent, using a mock adapter (no network). Verifies that a turn in one
 * agent is reloaded into a fresh agent created with the same persistKey — the
 * cross-session memory the TUI previously lacked entirely.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createChatAgent, JsonlSessionEventStore } from "../agent-harness";
import { rolloutPathForKey } from "../threadEngine";
import type { AIAdapter } from "../agent-harness/framework/adapters/types";

const KEY = `__sift_test_persist_${process.pid}`;
const PATH = rolloutPathForKey(homedir(), KEY);
const JOURNAL_ROOT = mkdtempSync(join(tmpdir(), "sift-session-journal-"));
const prevFlag = process.env.SIFT_CONTEXT_COMPACTION;

beforeAll(() => {
  process.env.SIFT_CONTEXT_COMPACTION = "1";
  if (existsSync(PATH)) rmSync(PATH);
  rmSync(JOURNAL_ROOT, { recursive: true, force: true });
});
afterAll(() => {
  if (prevFlag === undefined) delete process.env.SIFT_CONTEXT_COMPACTION;
  else process.env.SIFT_CONTEXT_COMPACTION = prevFlag;
  if (existsSync(PATH)) rmSync(PATH);
  rmSync(JOURNAL_ROOT, { recursive: true, force: true });
});

function mockAdapter(answer: string): AIAdapter {
  return { name: "mock", model: "mock-1", chat: async () => ({ text: answer }) };
}

describe.serial("agent rollout persistence", () => {
  it("resumes a prior turn in a fresh agent with the same persistKey", async () => {
    const a1 = await createChatAgent({
      name: "t",
      adapter: mockAdapter("answer one"),
      persistKey: KEY,
      session: { id: KEY, store: new JsonlSessionEventStore({ rootDir: JOURNAL_ROOT }) },
      memory: false,
      tools: [],
    });
    const r1 = await a1.chat("question one");
    expect(r1.text).toBe("answer one");
    expect(existsSync(PATH)).toBe(false);

    // A brand-new agent (simulating a restarted session) with the same key.
    const a2 = await createChatAgent({
      name: "t",
      adapter: mockAdapter("answer two"),
      persistKey: KEY,
      session: { id: KEY, store: new JsonlSessionEventStore({ rootDir: JOURNAL_ROOT }) },
      memory: false,
      tools: [],
    });
    await a2.chat("question two");

    const flat = a2
      .getHistory()
      .map((m) => [m.role, typeof m.content === "string" ? m.content : ""]);
    // The prior turn was resumed from disk…
    expect(flat).toContainEqual(["user", "question one"]);
    expect(flat).toContainEqual(["assistant", "answer one"]);
    expect(flat.filter(([role, text]) => role === "user" && text === "question one")).toHaveLength(1);
    // …ahead of the new turn.
    expect(flat).toContainEqual(["user", "question two"]);
  });

  it("does not resume when the feature flag is off", async () => {
    process.env.SIFT_CONTEXT_COMPACTION = "0";
    try {
      const a = await createChatAgent({
        name: "t",
        adapter: mockAdapter("x"),
        persistKey: KEY,
        memory: false,
        tools: [],
      });
      await a.chat("isolated question");
      const users = a.getHistory().filter((m) => m.role === "user");
      // Only the current turn — nothing resumed from the prior test's file.
      expect(users).toHaveLength(1);
    } finally {
      process.env.SIFT_CONTEXT_COMPACTION = "1";
    }
  });
});

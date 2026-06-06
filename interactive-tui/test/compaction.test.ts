/**
 * Tests for the pure history-rewrite that executes a compaction plan. These need
 * no model and no native library — they assert the object surgery is correct and,
 * critically, that the rewritten history stays provider-valid (turn-aligned, no
 * orphaned tool results, no illegal leading role).
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { describe, it, expect } from "bun:test";
import { applyCompactionPlan } from "../openfunction/framework/compaction";
import type { CompactionPlan } from "../threadEngine";
import type { ChatMessage } from "../openfunction/framework/adapters/types";

function plan(over: Partial<CompactionPlan>): CompactionPlan {
  return {
    needsCompaction: true,
    estimatedTokens: 0,
    usableTokens: 0,
    prunedTokens: 0,
    prune: [],
    summarizeRange: [0, 0],
    tailStartIndex: 0,
    ...over,
  };
}

const TURN: ChatMessage[] = [
  { role: "user", content: "first question" },
  { role: "assistant", content: '{"q":"x"}', toolCallId: "c1", toolName: "search" },
  { role: "tool", content: "huge tool output ".repeat(50), toolCallId: "c1", toolName: "search" },
  { role: "user", content: "second question" },
  { role: "assistant", content: "the answer" },
];

describe("applyCompactionPlan", () => {
  it("prune-only clears tool content but preserves structure and length", () => {
    const out = applyCompactionPlan(TURN, plan({ prune: [2], prunedTokens: 100 }), null);
    expect(out.length).toBe(TURN.length);
    expect(out[2]!.content).toContain("cleared");
    // ids/roles intact so the assistant call still references a tool result
    expect(out[2]!.role).toBe("tool");
    expect(out[2]!.toolCallId).toBe("c1");
    expect(out[2]!.toolName).toBe("search");
    // untouched messages are unchanged
    expect(out[0]!.content).toBe("first question");
    expect(out[4]!.content).toBe("the answer");
  });

  it("summarize drops the prefix and folds the recap into the first kept user turn", () => {
    const out = applyCompactionPlan(
      TURN,
      plan({ summarizeRange: [0, 3], tailStartIndex: 3 }),
      "GOAL: answer questions. PROGRESS: searched x.",
    );
    expect(out.length).toBe(2); // tail = [user "second question", assistant "the answer"]
    expect(out[0]!.role).toBe("user"); // provider-valid leading role
    expect(out[0]!.content).toContain("summarized");
    expect(out[0]!.content).toContain("GOAL: answer questions");
    expect(out[0]!.content).toContain("second question"); // original turn text retained
    expect(out[1]!.content).toBe("the answer");
  });

  it("does not mutate the input history", () => {
    const before = TURN[2]!.content;
    applyCompactionPlan(TURN, plan({ prune: [2] }), null);
    expect(TURN[2]!.content).toBe(before);
  });

  it("applies prune to messages that survive in the tail", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "q0" },
      { role: "assistant", content: "a0" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "{}", toolCallId: "c9", toolName: "fetch" },
      { role: "tool", content: "big".repeat(99), toolCallId: "c9", toolName: "fetch" },
      { role: "assistant", content: "done" },
    ];
    // tail starts at 2; prune index 4 lives inside the tail.
    const out = applyCompactionPlan(history, plan({ summarizeRange: [0, 2], tailStartIndex: 2, prune: [4] }), "recap");
    expect(out.length).toBe(4); // messages 2..5
    expect(out[0]!.content).toContain("q1"); // recap folded into kept user turn
    expect(out[2]!.content).toContain("cleared"); // pruned tool result (was index 4)
    expect(out[2]!.toolCallId).toBe("c9");
  });

  it("falls back to prune-only when no summary text is available", () => {
    const out = applyCompactionPlan(TURN, plan({ summarizeRange: [0, 3], tailStartIndex: 3, prune: [2] }), null);
    // no summary -> history NOT truncated, only pruned
    expect(out.length).toBe(TURN.length);
    expect(out[2]!.content).toContain("cleared");
  });
});

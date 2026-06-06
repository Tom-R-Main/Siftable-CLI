/**
 * Tests for the thread-engine token estimator bridge.
 *
 * Covers three things: the native (Zig) path returns the locked heuristic
 * values, the pure-TS fallback mirrors it exactly (so behaviour is identical
 * whether or not the dylib is built), and edge cases don't throw.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { describe, it, expect } from "bun:test";
import {
  estimateTokens,
  estimateTokensFallback,
  planCompaction,
  tokenEstimateSource,
  type CompactionConfig,
  type PlanMessage,
} from "../threadEngine";

// Locked heuristic: ceil(word_run/4) per Latin/alnum run, +1 per standalone
// ASCII punctuation, +1 per multibyte codepoint, whitespace folds away. These
// mirror the assertions in native/thread_engine.zig.
const VECTORS: Array<[string, number]> = [
  ["", 0],
  ["test", 1], // 4 chars -> ceil(4/4)
  ["hello", 2], // 5 chars -> ceil(5/4)
  ["the quick brown fox", 6], // 1+2+2+1
  ["a, b.", 4], // a , b .
  ["日本語", 3], // 3 CJK codepoints
  ["héllo", 3], // h | é | llo
  ["😀😀", 2], // two emoji (surrogate pairs), one token each
];

describe("estimateTokens (native Zig path)", () => {
  it("matches the locked heuristic vectors", () => {
    for (const [text, expected] of VECTORS) {
      expect(estimateTokens(text)).toBe(expected);
    }
  });

  it("resolves to the zig engine in the bun test runtime", () => {
    // The dylib is built in this repo; if this ever flips to "ts" the native
    // library failed to load and we are silently on the fallback.
    estimateTokens("warm up the loader");
    expect(tokenEstimateSource()).toBe("zig");
  });

  it("scales a large english body to ~chars/4", () => {
    expect(estimateTokens("a".repeat(4000))).toBe(1000);
  });

  it("never returns negative or fractional counts", () => {
    for (const [text] of VECTORS) {
      const n = estimateTokens(text);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("estimateTokensFallback parity", () => {
  it("matches the native path on the heuristic vectors", () => {
    for (const [text, expected] of VECTORS) {
      expect(estimateTokensFallback(text)).toBe(expected);
    }
  });

  it("matches the native path on mixed real-world strings", () => {
    const corpus = [
      "Refactor the agentLoop so it streams tokens incrementally.",
      "console.log(`value=${x}`); // debug",
      "function add(a, b) { return a + b; }",
      "TODO: handle the 0xFF edge-case — see issue #42.",
      "한국어 텍스트 with mixed English 123",
      "emoji test 🚀🔥✅ done",
      "   leading and trailing whitespace   ",
      "tabs\tand\nnewlines\r\nmixed",
      "ALLCAPS and snake_case and kebab-case-words",
      "https://example.com/path?q=1&r=2",
    ];
    for (const text of corpus) {
      expect(estimateTokensFallback(text)).toBe(estimateTokens(text));
    }
  });
});

describe("planCompaction (Zig planner bridge)", () => {
  const cfg: CompactionConfig = {
    contextWindow: 1000,
    reserved: 100,
    tailTurns: 2,
    preserveRecentTokens: 1000,
    pruneProtectTokens: 40,
    pruneMinTokens: 20,
  };
  const A = "a".repeat(40); // 10 tokens
  const BIG = "a".repeat(4000); // 1000 tokens

  it("reports no compaction under budget", () => {
    const plan = planCompaction([{ role: "user", text: A }], cfg)!;
    expect(plan).not.toBeNull();
    expect(plan.needsCompaction).toBe(false);
    expect(plan.estimatedTokens).toBe(10);
    expect(plan.tailStartIndex).toBe(0);
  });

  it("prunes an old tool output when that alone fits the budget", () => {
    const msgs: PlanMessage[] = [
      { role: "user", text: A },
      { role: "assistant", text: A },
      { role: "tool", text: BIG }, // old, prunable
      { role: "user", text: A },
      { role: "assistant", text: A },
      { role: "tool", text: A }, // recent, protected by window
    ];
    const plan = planCompaction(msgs, cfg)!;
    expect(plan.needsCompaction).toBe(true);
    expect(plan.prune).toEqual([2]);
    expect(plan.prunedTokens).toBe(1000);
    expect(plan.summarizeRange).toEqual([0, 0]); // no summary needed
  });

  it("summarizes a whole-turn prefix when pruning can't fit", () => {
    const BODY = "a".repeat(2000); // 500 tokens
    const msgs: PlanMessage[] = [
      { role: "user", text: BODY },
      { role: "assistant", text: BODY }, // turn 0
      { role: "user", text: BODY },
      { role: "assistant", text: BODY }, // turn 1
      { role: "user", text: A },
      { role: "assistant", text: A }, // turn 2
    ];
    const plan = planCompaction(msgs, { ...cfg, contextWindow: 1500, tailTurns: 1 })!;
    expect(plan.needsCompaction).toBe(true);
    expect(plan.prune).toEqual([]); // no tool outputs to prune
    expect(plan.tailStartIndex).toBe(4); // keep only turn 2 (a user boundary)
    expect(plan.summarizeRange).toEqual([0, 4]);
  });

  it("protects flagged tool output from pruning", () => {
    const msgs: PlanMessage[] = [
      { role: "user", text: A },
      { role: "assistant", text: A },
      { role: "tool", text: BIG, protected: true },
      { role: "user", text: A },
      { role: "assistant", text: A },
      { role: "tool", text: A },
    ];
    const plan = planCompaction(msgs, cfg)!;
    expect(plan.prunedTokens).toBe(0);
    expect(plan.tailStartIndex).toBe(3); // forced to summarize instead
  });
});

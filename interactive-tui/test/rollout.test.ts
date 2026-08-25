/**
 * Rollout persistence round-trips through the REAL Zig file I/O (append + load).
 * Asserts ChatMessage <-> JSONL mapping, last-N-turn truncation, content
 * escaping, and the missing-file path.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { describe, it, expect, afterAll, afterEach, beforeAll } from "bun:test";
import { tmpdir } from "node:os";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { appendTurn, loadHistory } from "../agent-harness/framework/rollout";

const path = `${tmpdir()}/sift-rollout-test-${process.pid}.jsonl`;
const previousCompactionFlag = process.env.SIFT_CONTEXT_COMPACTION;
const reset = () => {
  if (existsSync(path)) rmSync(path);
};
beforeAll(() => {
  process.env.SIFT_CONTEXT_COMPACTION = "1";
});
afterEach(reset);
afterAll(() => {
  if (previousCompactionFlag === undefined) delete process.env.SIFT_CONTEXT_COMPACTION;
  else process.env.SIFT_CONTEXT_COMPACTION = previousCompactionFlag;
});

describe.serial("rollout round-trip", () => {
  it("persists user/assistant turns and reloads them as ChatMessages", () => {
    reset();
    appendTurn(path, "first question", "first answer");
    appendTurn(path, "second question", "second answer");
    const h = loadHistory(path);
    expect(h.map((m) => [m.role, m.content])).toEqual([
      ["user", "first question"],
      ["assistant", "first answer"],
      ["user", "second question"],
      ["assistant", "second answer"],
    ]);
  });

  it("truncates to the last N turns on load", () => {
    reset();
    appendTurn(path, "q0", "a0");
    appendTurn(path, "q1", "a1");
    const h = loadHistory(path, 1);
    expect(h).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
  });

  it("safely round-trips content with quotes and newlines", () => {
    reset();
    const tricky = 'has "quotes"\nand a newline';
    appendTurn(path, tricky, "ok");
    const h = loadHistory(path);
    expect(h[0]!.content).toBe(tricky);
    expect(h[1]!.content).toBe("ok");
  });

  it("skips syntactically valid records with invalid role or text fields", () => {
    reset();
    writeFileSync(path, [
      '{"r":0,"t":"valid question"}',
      '{"r":1,"t":42}',
      '{"r":"1","t":"wrong role type"}',
      '{"r":0}',
      '{"r":1,"t":"valid answer"}',
      "",
    ].join("\n"));

    expect(loadHistory(path)).toEqual([
      { role: "user", content: "valid question" },
      { role: "assistant", content: "valid answer" },
    ]);
  });

  it("omits the assistant record when the answer is empty", () => {
    reset();
    appendTurn(path, "question only", null);
    expect(loadHistory(path)).toEqual([{ role: "user", content: "question only" }]);
  });

  it("returns an empty history for a missing file", () => {
    expect(loadHistory(`${tmpdir()}/sift-rollout-missing-${process.pid}.jsonl`)).toEqual([]);
  });
});

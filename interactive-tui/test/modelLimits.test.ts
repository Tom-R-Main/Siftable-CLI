/**
 * Context-window resolution tests: the shared modelLimits table is the single
 * source of truth for compaction budgeting, so exact-variant hits, family
 * estimates, fallback observability, and SIFT_CONTEXT_WINDOW validation are
 * pinned here.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  CONTEXT_WINDOW_OVERRIDE_MAX,
  FALLBACK_CONTEXT_WINDOW,
  parseContextWindowOverride,
  resolveContextWindow,
} from "../modelLimits";
import { buildCompactionConfig } from "../agent-harness/framework/compaction";

const ENV_KEY = "SIFT_CONTEXT_WINDOW";
const savedEnv = process.env[ENV_KEY];

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

describe("resolveContextWindow", () => {
  it("resolves exact per-variant entries before family estimates", () => {
    // deepseek-v4-flash-0731 claims 1M — the family row (deepseek → 128k) must
    // not win over the exact entry.
    expect(resolveContextWindow("deepseek/deepseek-v4-flash-0731"))
      .toEqual({ window: 1_000_000, source: "model" });
    expect(resolveContextWindow("deepseek-v4-flash-0731"))
      .toEqual({ window: 1_000_000, source: "model" });
    expect(resolveContextWindow("moonshotai/kimi-k3"))
      .toEqual({ window: 1_000_000, source: "model" });
    expect(resolveContextWindow("z-ai/glm-5.2"))
      .toEqual({ window: 1_000_000, source: "model" });
    expect(resolveContextWindow("muse-spark-1.3-contributor"))
      .toEqual({ window: 1_000_000, source: "model" });
  });

  it("resolves the current Claude models to their exact 1M window", () => {
    for (const id of [
      "anthropic/claude-fable-5.1",
      "claude-fable-5-1",
      "anthropic/claude-opus-5.5",
      "claude-opus-5-5",
      "anthropic/claude-sonnet-5.5",
      "claude-sonnet-5-5",
    ]) {
      expect(resolveContextWindow(id), id).toEqual({ window: 1_000_000, source: "model" });
    }
  });

  it("resolves family estimates with an honest source tag", () => {
    expect(resolveContextWindow("google/gemini-3.8-flash"))
      .toEqual({ window: 1_000_000, source: "family" });
    expect(resolveContextWindow("anthropic/claude-haiku-4.5"))
      .toEqual({ window: 200_000, source: "family" });
    expect(resolveContextWindow("deepseek/deepseek-v3.2"))
      .toEqual({ window: 128_000, source: "family" });
    expect(resolveContextWindow("openai/gpt-5.4-mini"))
      .toEqual({ window: 256_000, source: "family" });
  });

  it("reports fallback for unknown models instead of guessing", () => {
    for (const id of ["x-ai/grok-4.6", "moonshotai/kimi-k2.6", "z-ai/glm-5.3-flash", "morph/morph-v3-large", undefined]) {
      const resolution = resolveContextWindow(id);
      expect(resolution.window, String(id)).toBe(FALLBACK_CONTEXT_WINDOW);
      expect(resolution.source, String(id)).toBe("fallback");
    }
  });
});

describe("parseContextWindowOverride", () => {
  it("accepts finite positive integers within the bound", () => {
    expect(parseContextWindowOverride("800")).toBe(800);
    expect(parseContextWindowOverride("1000000")).toBe(1_000_000);
    expect(parseContextWindowOverride(String(CONTEXT_WINDOW_OVERRIDE_MAX))).toBe(CONTEXT_WINDOW_OVERRIDE_MAX);
  });

  it("rejects values that would corrupt the native planner's packing", () => {
    for (const bad of [undefined, "", "0", "-5", "0.5", "abc", "1e30", "Infinity", String(CONTEXT_WINDOW_OVERRIDE_MAX + 1)]) {
      expect(parseContextWindowOverride(bad), String(bad)).toBeNull();
    }
  });
});

describe.serial("buildCompactionConfig window resolution", () => {
  it("applies a valid override and reports the source", () => {
    process.env[ENV_KEY] = "800";
    const config = buildCompactionConfig("moonshotai/kimi-k3");
    expect(config.contextWindow).toBe(800);
    expect(config.contextWindowSource).toBe("override");
  });

  it("ignores an invalid override and resolves the model instead", () => {
    process.env[ENV_KEY] = "1e30";
    const config = buildCompactionConfig("moonshotai/kimi-k3");
    expect(config.contextWindow).toBe(1_000_000);
    expect(config.contextWindowSource).toBe("model");
  });

  it("exposes fallback so callers can surface it", () => {
    delete process.env[ENV_KEY];
    const config = buildCompactionConfig("x-ai/grok-4.6");
    expect(config.contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(config.contextWindowSource).toBe("fallback");
  });
});

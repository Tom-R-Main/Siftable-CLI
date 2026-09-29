/**
 * Claude Fable 5.1, Opus 5.5, and Sonnet 5.5 request contract: retired
 * Sonnet ids resolve to Sonnet 5.5, Opus 5.5 defaults to medium effort, and
 * no sampling parameters or forced tool choice reach these models.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { describe, expect, it } from "bun:test";
import {
  createAnthropicAdapter,
  normalizeClaudeEffort,
  normalizeClaudeModel,
} from "../agent-harness/framework/adapters/anthropic";
import { createOpenRouterAdapter } from "../agent-harness/framework/adapters/openai";
import { isAdaptiveOnlyClaudeModel } from "../agent-harness/framework/adapters/util";
import type { ChatMessage } from "../agent-harness/framework/adapters/types";
import { ToolRegistry } from "../agent-harness/framework/registry";

const registry = new ToolRegistry();
const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const anthropicReply = (model: string) => ({
  id: "a1", type: "message", role: "assistant", model,
  content: [{ type: "text", text: "done" }], stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
});
const completion = { id: "r1", model: "served", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] };

describe("normalizeClaudeModel", () => {
  it("passes the current Claude ids through", () => {
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5"]) {
      expect(normalizeClaudeModel(id)).toBe(id);
    }
  });

  it("routes retired Sonnets to Sonnet 5.5 and every older Opus id to Opus 5.5", () => {
    for (const id of ["claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5-20250929", "claude-sonnet-4-20250514"]) {
      expect(normalizeClaudeModel(id)).toBe("claude-sonnet-5-5");
    }
    for (const id of ["claude-opus-5", "claude-opus-5-20260723", "claude-opus-4-8", "claude-opus-4-1-20250805"]) {
      expect(normalizeClaudeModel(id)).toBe("claude-opus-5-5");
    }
    expect(normalizeClaudeModel(undefined)).toBe("claude-opus-5-5");
  });
});

describe("normalizeClaudeEffort", () => {
  it("defaults Opus 5.5 to medium and the other Claude models to high", () => {
    expect(normalizeClaudeEffort("claude-opus-5-5")).toBe("medium");
    expect(normalizeClaudeEffort("claude-sonnet-5-5")).toBe("high");
    expect(normalizeClaudeEffort("claude-fable-5-1")).toBe("high");
  });

  it("never disables thinking", () => {
    expect(normalizeClaudeEffort("claude-opus-5-5", "none")).toBe("low");
    expect(normalizeClaudeEffort("claude-sonnet-5-5", "minimal")).toBe("low");
    expect(normalizeClaudeEffort("claude-fable-5-1", "max")).toBe("max");
  });
});

describe("isAdaptiveOnlyClaudeModel", () => {
  it("matches both spellings of the current families only", () => {
    for (const id of ["anthropic/claude-opus-5.5", "claude-opus-5-5", "anthropic/claude-sonnet-5.5", "claude-fable-5-1"]) {
      expect(isAdaptiveOnlyClaudeModel(id)).toBe(true);
    }
    for (const id of ["anthropic/claude-opus-5", "claude-opus-5-20260723", "anthropic/claude-sonnet-5", "claude-haiku-4-5", undefined]) {
      expect(isAdaptiveOnlyClaudeModel(id)).toBe(false);
    }
  });
});

describe("request bodies", () => {
  it("sends adaptive thinking, the model default effort, and automatic tool choice to Opus 5.5", async () => {
    let request: Record<string, unknown> = {};
    const client = createAnthropicAdapter({
      apiKey: "test",
      model: "claude-opus-5-5",
      fetchImpl: (async (_url, init) => {
        request = JSON.parse(String(init?.body));
        return json(anthropicReply("claude-opus-5-5"));
      }) as typeof fetch,
    });
    await client.chat(messages, registry);
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request.output_config).toEqual({ effort: "medium" });
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("top_p");
  });

  it("omits temperature and forced tool choice for Sonnet 5.5 on OpenRouter", async () => {
    let request: Record<string, unknown> = {};
    const client = createOpenRouterAdapter({
      apiKey: "test",
      model: "anthropic/claude-sonnet-5.5",
      fetchImpl: (async (_url, init) => {
        request = JSON.parse(String(init?.body));
        return json(completion);
      }) as typeof fetch,
    });
    await client.chat(messages, registry, { toolChoice: "required" });
    expect(request.model).toBe("anthropic/claude-sonnet-5.5");
    expect(request).not.toHaveProperty("temperature");
    expect(request).not.toHaveProperty("tool_choice");
  });

  it("keeps the existing temperature for other OpenRouter models", async () => {
    let request: Record<string, unknown> = {};
    const client = createOpenRouterAdapter({
      apiKey: "test",
      model: "moonshotai/kimi-k3",
      fetchImpl: (async (_url, init) => {
        request = JSON.parse(String(init?.body));
        return json(completion);
      }) as typeof fetch,
    });
    await client.chat(messages, registry);
    expect(request.temperature).toBe(0.7);
  });
});

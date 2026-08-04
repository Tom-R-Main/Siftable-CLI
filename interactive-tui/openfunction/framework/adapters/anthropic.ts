/**
 * Anthropic Adapter (Claude)
 *
 * Env: ANTHROPIC_API_KEY
 * Default model: claude-opus-5
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AIAdapter, AdapterConfig, ChatMessage, ChatOptions, AdapterResponse, ReasoningEffort } from "./types.js";
import type { ToolRegistry } from "../registry.js";
import { safeJsonParse } from "./util.js";
import { chatContentToText, imageBase64, imageMime, normalizeChatContent } from "./content.js";

type ClaudeOpus5Effort = "low" | "medium" | "high" | "xhigh" | "max";

const normalizeClaudeOpus5Effort = (effort?: ReasoningEffort): ClaudeOpus5Effort => {
  if (!effort) return "high";
  if (effort === "none" || effort === "minimal") return "low";
  return effort;
};

const normalizeClaudeModel = (model?: string): string => {
  const requested = model?.trim() || "claude-opus-5";
  if (/claude-(?:opus|sonnet)-(?!5(?:$|-))/.test(requested) || requested.includes("claude-sonnet-")) {
    return "claude-opus-5";
  }
  return requested;
};

export function createAnthropicAdapter(config?: Partial<AdapterConfig>): AIAdapter {
  const apiKey = config?.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY not set.\nGet one at: https://console.anthropic.com/settings/keys"
    );
  }

  const model = normalizeClaudeModel(config?.model);
  const doFetch = config?.fetchImpl ?? fetch;
  const client = new Anthropic({ apiKey, fetch: doFetch });
  const systemPrompt = config?.systemPrompt ?? "You are a helpful assistant with access to tools. Use tools when they're relevant.";
  const effort = normalizeClaudeOpus5Effort(config?.reasoningEffort);
  const maxTokens = effort === "xhigh" || effort === "max" ? 64_000 : 16_000;

  return {
    name: config?.name ?? "Claude",
    model,

    async chat(messages: ChatMessage[], registry: ToolRegistry, options?: ChatOptions): Promise<AdapterResponse> {
      // Convert messages to Anthropic format
      const anthropicMessages: Anthropic.MessageParam[] = [];

      for (const msg of messages) {
        if (msg.role === "user") {
          anthropicMessages.push({
            role: "user",
            content: anthropicContent(msg.content),
          });
        } else if (msg.role === "assistant") {
          // Extended thinking REQUIRES the original thinking block(s) to lead
          // the assistant message that contains the tool_use(s), replayed
          // verbatim (signatures are validated). The agent loop stashes them on
          // `thinkingBlocks`; without this the follow-up turn 400s.
          const preserved = Array.isArray(msg.thinkingBlocks)
            ? msg.thinkingBlocks as Anthropic.ContentBlockParam[]
            : [];
          if (msg.toolCalls?.length) {
            // Parallel: every tool_use block in one assistant turn.
            const toolUses = msg.toolCalls.map((c) => ({
              type: "tool_use",
              id: c.id,
              name: c.name,
              input: c.args,
            }));
            anthropicMessages.push({
              role: "assistant",
              content: preserved.length ? [...preserved, ...toolUses] : toolUses,
            });
          } else if (msg.toolCallId && msg.toolName) {
            const toolUse = {
              type: "tool_use",
              id: msg.toolCallId,
              name: msg.toolName,
              input: safeJsonParse(chatContentToText(msg.content), {}),
            };
            anthropicMessages.push({
              role: "assistant",
              content: preserved.length ? [...preserved, toolUse] : [toolUse],
            });
          } else {
            anthropicMessages.push({
              role: "assistant",
              content: chatContentToText(msg.content),
            });
          }
        } else if (msg.role === "tool") {
          // Anthropic requires all tool_result blocks for a turn's parallel
          // tool_use blocks to arrive in ONE user message — consecutive
          // user-role messages would 400. Merge into the open results message.
          const toolResult = {
            type: "tool_result",
            tool_use_id: msg.toolCallId!,
            content: chatContentToText(msg.content),
          };
          const last = anthropicMessages[anthropicMessages.length - 1];
          const isOpenResultMsg =
            last &&
            last.role === "user" &&
            Array.isArray(last.content) &&
            last.content.every((b: any) => b?.type === "tool_result");
          if (isOpenResultMsg) {
            (last.content as unknown[]).push(toolResult);
          } else {
            anthropicMessages.push({ role: "user", content: [toolResult] });
          }
        }
      }

      const tools = registry.toAnthropicFormat() as Anthropic.Tool[];
      const body: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: maxTokens,
        system: options?.systemPrompt ?? systemPrompt,
        messages: anthropicMessages,
        tools,
        thinking: { type: "adaptive" },
        output_config: { effort },
      };

      // Tool choice + disable parallel tool use.
      // Without disable_parallel_tool_use, Anthropic may emit multiple
      // tool_use blocks in one assistant turn. Our adapter only returns
      // the first tool call (single-call AdapterResponse), which leaves
      // the other tool_use_ids without matching tool_results — the next
      // call then 400s with "tool_use_id was not found".
      // Conservative fix: serialize tool calls. A future change can
      // extend AdapterResponse to carry multiple calls per round.
      if (tools.length > 0) {
        const toolChoice: Record<string, unknown> = { type: "auto" };
        // Adaptive thinking is safest with automatic, serialized tool calls;
        // this also guarantees every tool_use gets a matching tool_result.
        toolChoice.disable_parallel_tool_use = true;
        body.tool_choice = toolChoice as Anthropic.ToolChoice;
      }

      const data = maxTokens > 16_000
        ? await client.messages.stream(body).finalMessage()
        : await client.messages.create(body);

      // Anthropic responses can contain both a text block (preamble like
      // "Let me check that...") AND a tool_use block in the same turn.
      // Capture both — when both are present the text is preamble; when
      // text is alone it's the final response.
      const blocks = data.content;
      const textBlock = blocks.find((b) => b.type === "text");
      const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");

      if (toolUseBlocks.length) {
        // Preserve thinking/redacted_thinking blocks verbatim so the agent loop
        // can replay them on the assistant turn that continues these calls.
        const thinking = blocks.filter(
          (b) => b.type === "thinking" || b.type === "redacted_thinking"
        );
        const calls = toolUseBlocks.map((b) => ({
          id: b.id!,
          name: b.name!,
          args: (b.input as Record<string, unknown>) ?? {},
        }));
        const extra = {
          ...(textBlock?.text && { text: textBlock.text }),
          ...(thinking.length && { thinking }),
        };
        // A lone call stays on `toolCall`; a real fan-out uses `toolCalls`.
        return calls.length === 1 ? { toolCall: calls[0], ...extra } : { toolCalls: calls, ...extra };
      }

      return { text: textBlock?.text ?? "(no response)" };
    },
  };
}

function anthropicContent(content: ChatMessage["content"]): Anthropic.MessageParam["content"] {
  if (typeof content === "string") return content;
  return normalizeChatContent(content).map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: imageMime(part),
            data: imageBase64(part),
          },
        }
  );
}

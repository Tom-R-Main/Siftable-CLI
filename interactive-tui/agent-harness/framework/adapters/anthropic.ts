/**
 * Anthropic Adapter (Claude)
 *
 * Env: ANTHROPIC_API_KEY
 * Default model: claude-opus-5
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AIAdapter, AdapterConfig, ChatMessage, ChatOptions, AdapterResponse, ReasoningEffort } from "./types.js";
import type { ToolRegistry } from "../registry.js";
import { compatibleBaseUrl, outputTokenLimit, providerTransport } from "./transport.js";
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
  const systemPrompt = config?.systemPrompt ?? "You are a helpful assistant with access to tools. Use tools when they're relevant.";
  const effort = normalizeClaudeOpus5Effort(config?.reasoningEffort);
  const maxTokens = outputTokenLimit(config?.maxOutputTokens) ?? (effort === "xhigh" || effort === "max" ? 64_000 : 16_000);

  return {
    name: config?.name ?? "Claude",
    model,

    async chat(messages: ChatMessage[], registry: ToolRegistry, options?: ChatOptions): Promise<AdapterResponse> {
      // Convert messages to Anthropic format
      const anthropicMessages: Anthropic.MessageParam[] = [];

      for (const msg of messages) {
        if (msg.role === "user") {
          const content = anthropicContent(msg.content);
          const last = anthropicMessages[anthropicMessages.length - 1];
          if (last?.role === "user") {
            // Queued durable instructions may precede the next live prompt.
            // Coalesce all adjacent user messages to satisfy Anthropic's role
            // alternation requirement, not only tool-result continuations.
            if (typeof last.content === "string" && typeof content === "string") {
              last.content = `${last.content}\n\n${content}`;
            } else {
              last.content = [
                ...anthropicContentBlocks(last.content),
                ...anthropicContentBlocks(content),
              ];
            }
          } else {
            anthropicMessages.push({ role: "user", content });
          }
        } else if (msg.role === "assistant") {
          // Extended thinking REQUIRES the original thinking block(s) to lead
          // the assistant message that contains the tool_use(s), replayed
          // verbatim (signatures are validated). The agent loop stashes them on
          // `thinkingBlocks`; without this the follow-up turn 400s.
          const preserved = msg.thinkingBlocks?.filter(isReplayableThinkingBlock) ?? [];
          if (msg.toolCalls?.length) {
            // Parallel: every tool_use block in one assistant turn.
            const toolUses: Anthropic.ToolUseBlockParam[] = msg.toolCalls.map((c) => ({
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
            const toolUse: Anthropic.ToolUseBlockParam = {
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
          if (!msg.toolCallId) {
            throw new Error("Anthropic tool result requires a tool call ID");
          }
          const toolResult: Anthropic.ToolResultBlockParam = {
            type: "tool_result",
            tool_use_id: msg.toolCallId,
            content: chatContentToText(msg.content),
          };
          const last = anthropicMessages[anthropicMessages.length - 1];
          if (
            last &&
            last.role === "user" &&
            Array.isArray(last.content) &&
            last.content.every((block) => block.type === "tool_result")
          ) {
            last.content.push(toolResult);
          } else {
            anthropicMessages.push({ role: "user", content: [toolResult] });
          }
        }
      }

      const tools: Anthropic.Tool[] = registry.toAnthropicFormat().map((tool) => ({
        name: tool.name,
        description: tool.description,
        // Anthropic accepts complete JSON Schema objects. Forward the runtime
        // schema verbatim so constraints beyond properties/required survive.
        input_schema: { ...tool.input_schema },
      }));
      const body: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: maxTokens,
        system: options?.systemPrompt ?? systemPrompt,
        messages: anthropicMessages,
        tools,
        thinking: { type: "adaptive" },
        output_config: { effort },
      };

      // Adaptive thinking requires automatic tool selection. Serialize tool
      // use so each signed thinking turn has one unambiguous result sequence.
      if (tools.length > 0) {
        // Adaptive thinking is safest with automatic, serialized tool calls;
        // this also guarantees every tool_use gets a matching tool_result.
        body.tool_choice = {
          type: "auto",
          disable_parallel_tool_use: true,
        };
      }

      const transport = providerTransport({ ...config, name: config?.name ?? "Claude", model }, maxTokens > 16_000 ? { ...options, stream: true } : options);
      // The shared transport owns retries; SDK retries would hide attempts and
      // replay ambiguous failures outside the configured policy.
      const client = new Anthropic({ apiKey, maxRetries: 0,
        ...(config?.baseUrl ? { baseURL: compatibleBaseUrl(config.baseUrl) } : {}),
        fetch: ((url, init) => transport.fetch(url as string, init ?? {})) as typeof fetch,
      });
      try {
        const data = transport.stream || maxTokens > 16_000
          ? await client.messages.stream(body, { signal: options?.signal }).on("text", (delta) => { if (options?.stream !== false) transport.text(delta); }).finalMessage()
          : await client.messages.create(body, { signal: options?.signal });
        transport.capture(data);
        if (!["end_turn", "tool_use", "stop_sequence"].includes(String(data.stop_reason))) throw new Error("Anthropic response is incomplete");
        transport.finish(data);
        const providerReceipts = transport.receipts;

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
            id: b.id,
            name: b.name,
            args: isRecord(b.input) ? b.input : {},
          }));
          const extra = {
            providerReceipts,
            ...(textBlock?.text && { text: textBlock.text }),
            ...(thinking.length && { thinking }),
          };
          // A lone call stays on `toolCall`; a real fan-out uses `toolCalls`.
          return calls.length === 1 ? { toolCall: calls[0], ...extra } : { toolCalls: calls, ...extra };
        }

        return { providerReceipts, text: textBlock?.text ?? "(no response)" };
      } catch (error) {
        transport.fail();
        transport.throwIfObserverFailed();
        transport.throwIfTerminalFailed();
        if (error instanceof Anthropic.APIError && error.status !== undefined) throw new Error(`Anthropic API error (${error.status})`);
        throw error;
      }
    },
  };
}

function anthropicContent(content: ChatMessage["content"]): Anthropic.MessageParam["content"] {
  if (typeof content === "string") return content;
  return normalizeChatContent(content).map((part): Anthropic.TextBlockParam | Anthropic.ImageBlockParam =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: anthropicImageMime(imageMime(part)),
            data: imageBase64(part),
          },
        }
  );
}

function anthropicContentBlocks(
  content: Anthropic.MessageParam["content"],
): Anthropic.ContentBlockParam[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function anthropicImageMime(mime: string): Anthropic.Base64ImageSource["media_type"] {
  switch (mime) {
    case "image/jpeg":
    case "image/png":
    case "image/gif":
    case "image/webp":
      return mime;
    default:
      throw new Error(`Anthropic does not support image MIME type: ${mime}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReplayableThinkingBlock(
  value: unknown,
): value is Anthropic.ThinkingBlockParam | Anthropic.RedactedThinkingBlockParam {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "thinking") {
    return typeof value.thinking === "string" && typeof value.signature === "string";
  }
  return value.type === "redacted_thinking" && typeof value.data === "string";
}

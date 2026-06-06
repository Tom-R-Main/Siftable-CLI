/**
 * Context compaction glue for the ChatAgent.
 *
 * The decision (what to prune, what to summarize, where the tail begins) is made
 * by the Zig planner via the TUI's threadEngine bridge. This module owns only
 * the host-side pieces the planner can't: the config knobs, turning ChatMessages
 * into the planner's plain-text view, building the transcript handed to the
 * summarizer model, and the pure history rewrite that executes the plan.
 *
 * Native-only: when the Zig library is unavailable, planCompaction() returns
 * null and the caller skips compaction (degrading to today's no-compaction
 * behaviour). Codex is handled a layer up — the brain routes the `codex`
 * provider to its app-server sidecar and never constructs a ChatAgent, so this
 * code only ever runs for the OpenFunction adapters.
 */
import type { ChatContent, ChatMessage } from "./adapters/types.js";
import { chatContentToText } from "./adapters/content.js";
import {
  planCompaction,
  type CompactionConfig,
  type CompactionPlan,
  type PlanMessage,
} from "../../threadEngine";

const PRUNE_PLACEHOLDER = "[earlier tool output cleared to free context]";

export const COMPACTION_SUMMARY_SYSTEM =
  "You compress a long assistant/tool conversation into a compact, factual handoff so the work can continue without the full history. Preserve identifiers, file paths, decisions, and open questions. Do not add commentary.";

export const COMPACTION_SUMMARY_INSTRUCTION =
  `Summarize the conversation below into a compact handoff. Use these sections, omitting any that are empty:
- Goal: what the user is ultimately trying to achieve
- Decisions: choices made and why
- Progress: what has been done so far
- Open items: what still needs doing
- Key context: files, identifiers, constraints worth carrying forward
Be concise and factual.`;

/** Feature flag — mirrors the TUI's SIFT_CONTEXT_COMPACTION gate. */
export function compactionEnabled(): boolean {
  return process.env.SIFT_CONTEXT_COMPACTION === "1";
}

/** Budget config; context window is overridable via SIFT_CONTEXT_WINDOW. */
export function buildCompactionConfig(): CompactionConfig {
  const contextWindow = Number(process.env.SIFT_CONTEXT_WINDOW) || 200_000;
  // Reserve covers max output tokens + residual token-estimate drift. The Phase 4
  // punctuation-surcharge calibration eliminated the dangerous code under-count
  // (validated vs DeepSeek's real tokenizer: code went -13% -> ~0%), so the 32k
  // safety band-aid is reduced to a 24k buffer for output + minor residual drift.
  const reserved = 24_000;
  const usable = Math.max(contextWindow - reserved, Math.floor(contextWindow / 2));
  const preserveRecentTokens = Math.min(8_000, Math.max(2_000, Math.floor(usable * 0.25)));
  return {
    contextWindow,
    reserved,
    tailTurns: 2,
    preserveRecentTokens,
    pruneProtectTokens: 40_000,
    pruneMinTokens: 20_000,
  };
}

/** Project ChatMessages onto the planner's role + plain-text view. */
export function toPlanMessages(history: ChatMessage[]): PlanMessage[] {
  return history.map((m) => ({
    role: m.role,
    text: chatContentToText(m.content),
    protected: m.toolName === "skill",
  }));
}

/** Flatten the to-be-summarized prefix into a readable transcript. */
export function buildSummarizeTranscript(history: ChatMessage[], end: number): string {
  const lines: string[] = [];
  for (let i = 0; i < end; i += 1) {
    const m = history[i]!;
    const label = m.role === "tool" ? `tool(${m.toolName ?? "?"})` : m.role;
    lines.push(`${label}: ${chatContentToText(m.content)}`);
  }
  return lines.join("\n");
}

function prependRecap(content: ChatContent, recap: string): ChatContent {
  if (typeof content === "string") return `${recap}\n\n---\n\n${content}`;
  return [{ type: "text", text: `${recap}\n\n---\n\n` }, ...content];
}

/**
 * Pure history rewrite executing a plan. Clears pruned tool outputs, and when a
 * summary was produced, drops the summarized prefix and folds the recap into the
 * first kept (user) message. Folding into the existing user turn — rather than
 * injecting a leading assistant/system message — keeps the user/assistant
 * alternation valid on every provider (Anthropic in particular requires the
 * first message to be a user turn).
 */
export function applyCompactionPlan(
  history: ChatMessage[],
  plan: CompactionPlan,
  summaryText: string | null,
): ChatMessage[] {
  const next = history.map((m) => ({ ...m }));
  for (const idx of plan.prune) {
    if (next[idx]) next[idx]!.content = PRUNE_PLACEHOLDER;
  }
  const end = plan.summarizeRange[1];
  if (summaryText && end > 0 && plan.tailStartIndex < next.length) {
    const tail = next.slice(plan.tailStartIndex);
    const recap = `[Earlier conversation summarized to save context]\n${summaryText}`;
    tail[0] = { ...tail[0]!, content: prependRecap(tail[0]!.content, recap) };
    return tail;
  }
  return next;
}

export type { CompactionPlan, CompactionConfig };
export { planCompaction };

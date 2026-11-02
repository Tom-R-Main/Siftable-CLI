/**
 * Context compaction glue for the ChatAgent.
 *
 * The decision (what to prune, what to summarize, where the tail begins) is made
 * by the Zig planner via the TUI's threadEngine bridge. This module owns only
 * the host-side pieces the planner can't: the config knobs, turning ChatMessages
 * into the planner's plain-text view, building the transcript handed to the
 * summarizer model, and the pure history rewrite that executes the plan.
 *
 * Native-only: when the Zig library is unavailable, planCompaction() reports a
 * structured failure and the caller journals the degradation (compaction is
 * skipped). Codex is handled a layer up — the brain routes the `codex`
 * provider to its app-server sidecar and never constructs a ChatAgent, so this
 * code only ever runs for the Siftable agent-harness adapters.
 */
import type { ChatContent, ChatMessage } from "./adapters/types.js";
import { chatContentToText } from "./adapters/content.js";
import {
  estimateTokens,
  planCompaction,
  type CompactionConfig,
  type CompactionPlan,
  type CompactionPlanFailure,
  type CompactionPlanOutcome,
  type PlanMessage,
} from "../../threadEngine";
import {
  CONTEXT_WINDOW_OVERRIDE_MAX,
  parseContextWindowOverride,
  resolveContextWindow,
  type ContextWindowSource,
} from "../../modelLimits";

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
  // Default ON; set SIFT_CONTEXT_COMPACTION=0 to opt out.
  return process.env.SIFT_CONTEXT_COMPACTION !== "0";
}

// Context windows come from the shared modelLimits table (exact per-variant
// entries, then family estimates, then a conservative fallback). The caller
// sees `contextWindowSource` so a fallback answer stays observable rather than
// masquerading as a model-specific one.
let invalidOverrideWarned = false;

/** Residual token-estimate drift kept free beyond the route's output cap. */
const RESERVE_DRIFT_TOKENS = 8_000;

/**
 * Budget config; window is resolved per-model (SIFT_CONTEXT_WINDOW overrides).
 * `maxOutputTokens` is the route's configured output cap, when it has one.
 */
export function buildCompactionConfig(
  modelId?: string,
  route: { maxOutputTokens?: number } = {},
): CompactionConfig & { contextWindowSource: ContextWindowSource } {
  const rawOverride = process.env.SIFT_CONTEXT_WINDOW;
  const override = parseContextWindowOverride(rawOverride);
  if (rawOverride !== undefined && rawOverride !== "" && override === null && !invalidOverrideWarned) {
    invalidOverrideWarned = true;
    console.warn(`Ignoring invalid SIFT_CONTEXT_WINDOW (${JSON.stringify(rawOverride)}) — expected a positive integer of ${CONTEXT_WINDOW_OVERRIDE_MAX} or less`);
  }
  const resolution = override !== null
    ? { window: override, source: "override" as const }
    : resolveContextWindow(modelId);
  const contextWindow = resolution.window;
  // Reserve covers max output tokens + residual token-estimate drift. The Phase 4
  // punctuation-surcharge calibration eliminated the dangerous code under-count
  // (validated vs DeepSeek's real tokenizer: code went -13% -> ~0%), so the 32k
  // safety band-aid is reduced to a 24k buffer for output + minor residual drift.
  // A route configured for longer output needs that much room plus the same
  // drift margin; the floor stays 24k for routes on provider defaults.
  const routeOutput = route.maxOutputTokens;
  const requestedReserve = typeof routeOutput === "number" && Number.isFinite(routeOutput) && routeOutput > 0
    ? Math.max(24_000, Math.ceil(routeOutput) + RESERVE_DRIFT_TOKENS)
    : 24_000;
  // Never reserve more than half the window. The native planner and this
  // config then agree on the usable input budget, and a large cap cannot
  // shrink that budget toward zero.
  const reserved = Math.min(requestedReserve, Math.floor(contextWindow / 2));
  const usable = Math.max(contextWindow - reserved, Math.floor(contextWindow / 2));
  const preserveRecentTokens = Math.min(8_000, Math.max(2_000, Math.floor(usable * 0.25)));
  return {
    contextWindow,
    contextWindowSource: resolution.source,
    reserved,
    tailTurns: 2,
    preserveRecentTokens,
    pruneProtectTokens: 40_000,
    pruneMinTokens: 20_000,
  };
}

/** Sum the heuristic token estimate across a history (for before/after reports). */
export function estimateHistoryTokens(history: ChatMessage[]): number {
  let sum = 0;
  for (const m of history) sum += estimateTokens(chatContentToText(m.content));
  return sum;
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

export type { CompactionPlan, CompactionConfig, CompactionPlanOutcome, CompactionPlanFailure };
export { planCompaction };

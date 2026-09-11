/**
 * In-turn request budget (CLI-046).
 *
 * Pre-turn compaction rewrites completed turns only. A headless task is a single
 * turn, so tool results accumulate until the provider rejects the request (Meta
 * answers HTTP 413 at roughly 300 KB). Before each model request the current
 * history is measured; when it exceeds the lane's byte ceiling, the oldest large
 * tool results are replaced by a short stub that names the tool, the call id and
 * the original size, so the model can re-run the tool if it still needs the data.
 * The most recent results are always kept; assistant and user messages are never
 * touched. Pruning is recorded in the session journal like any history rewrite.
 */
import type { ChatMessage } from "./adapters/types.js";
import { chatContentToText } from "./adapters/content.js";

export interface RequestBudgetOptions {
  /** Byte ceiling for the serialized request; the lane default when omitted. */
  ceilingBytes?: number;
  /** Number of most recent tool results that are never pruned. */
  keepLast?: number;
  /** Tool results at or below this size are never pruned. */
  minBytes?: number;
}

export interface PrunedToolResult {
  index: number;
  toolName?: string;
  callId?: string;
  bytes: number;
}

export interface RequestBudgetOutcome {
  history: ChatMessage[];
  beforeBytes: number;
  afterBytes: number;
  ceilingBytes: number;
  pruned: PrunedToolResult[];
}

/** Provider request ceilings (bytes). Meta rejects at ~300 KB; others allow far more. */
const PROVIDER_CEILINGS: Array<[RegExp, number]> = [
  [/meta|muse|llama/i, 240_000],
  [/deepseek/i, 400_000],
];
const DEFAULT_CEILING = 800_000;
export const DEFAULT_KEEP_LAST = 4;
export const DEFAULT_MIN_BYTES = 1_024;
export const PRUNE_STUB_PREFIX = "[tool result pruned to fit the provider request limit";

/** Lane default; SIFT_REQUEST_BYTE_CEILING overrides. */
export function requestByteCeiling(provider?: string): number {
  const env = Number(process.env.SIFT_REQUEST_BYTE_CEILING);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  if (provider) for (const [pattern, ceiling] of PROVIDER_CEILINGS) if (pattern.test(provider)) return ceiling;
  return DEFAULT_CEILING;
}

/** Serialized size of what the adapter will send, without provider framing. */
export function estimateRequestBytes(history: ChatMessage[], systemPrompt: string): number {
  return Buffer.byteLength(systemPrompt, "utf8") + Buffer.byteLength(JSON.stringify(history), "utf8");
}

function messageBytes(message: ChatMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

export function pruneStub(message: ChatMessage, bytes: number): string {
  const name = message.toolName ?? "tool";
  const id = message.toolCallId ? ` call ${message.toolCallId}` : "";
  return `${PRUNE_STUB_PREFIX}: ${name}${id} returned ${bytes} bytes earlier in this turn; re-run it if you still need the data]`;
}

/**
 * Replace the oldest large tool results until the request fits, keeping the last
 * `keepLast` results intact. Returns the same history object when nothing changes.
 */
export function fitHistoryToRequestBudget(
  history: ChatMessage[],
  systemPrompt: string,
  options: RequestBudgetOptions & { provider?: string } = {},
): RequestBudgetOutcome {
  const ceilingBytes = options.ceilingBytes ?? requestByteCeiling(options.provider);
  const keepLast = options.keepLast ?? DEFAULT_KEEP_LAST;
  const minBytes = options.minBytes ?? DEFAULT_MIN_BYTES;
  const beforeBytes = estimateRequestBytes(history, systemPrompt);
  if (beforeBytes <= ceilingBytes) return { history, beforeBytes, afterBytes: beforeBytes, ceilingBytes, pruned: [] };
  const toolIndexes = history.map((m, i) => (m.role === "tool" ? i : -1)).filter(i => i >= 0);
  const protectedIndexes = new Set(toolIndexes.slice(Math.max(0, toolIndexes.length - keepLast)));
  const next = history.slice();
  const pruned: PrunedToolResult[] = [];
  let afterBytes = beforeBytes;
  for (const index of toolIndexes) {
    if (afterBytes <= ceilingBytes) break;
    if (protectedIndexes.has(index)) continue;
    const message = next[index]!;
    const text = chatContentToText(message.content);
    if (text.startsWith(PRUNE_STUB_PREFIX)) continue;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes <= minBytes) continue;
    const replacement: ChatMessage = { ...message, content: pruneStub(message, bytes) };
    afterBytes -= messageBytes(message) - messageBytes(replacement);
    next[index] = replacement;
    pruned.push({ index, toolName: message.toolName, callId: message.toolCallId, bytes });
  }
  if (pruned.length === 0) return { history, beforeBytes, afterBytes: beforeBytes, ceilingBytes, pruned };
  return { history: next, beforeBytes, afterBytes, ceilingBytes, pruned };
}

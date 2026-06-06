/**
 * Rollout persistence for the ChatAgent — the cross-session memory layer.
 *
 * Zig owns the file I/O (append-only JSONL under ~/.siftable/threads, last-N-turn
 * truncation on load); this module owns the ChatMessage <-> record mapping and
 * the policy of WHAT to persist. We persist only the human-visible conversation
 * (user prompts + final assistant answers), never tool/assistant-tool-call
 * churn, so a reloaded history is always a valid user/assistant alternation with
 * no orphaned tool results — safe to seed straight into any provider.
 */
import { homedir } from "node:os";
import type { ChatMessage } from "./adapters/types.js";
import { rolloutAppend, rolloutLoad, rolloutPathForKey } from "../../threadEngine";

const ROLE_CODE = { user: 0, assistant: 1 } as const;
const CODE_ROLE = ["user", "assistant", "tool"] as const;

/** Persistence shares the master thread-engine flag. */
export function persistEnabled(): boolean {
  return process.env.SIFT_CONTEXT_COMPACTION === "1";
}

/** Resolve the on-disk rollout path for a thread key (workspace/cwd). */
export function rolloutPathForThread(persistKey: string): string {
  return rolloutPathForKey(homedir(), persistKey);
}

function serializeRecord(role: "user" | "assistant", text: string): string {
  return JSON.stringify({ r: ROLE_CODE[role], t: text });
}

/** Persist a completed turn: the user prompt and (if any) the assistant answer. */
export function appendTurn(path: string, userText: string, assistantText: string | null): void {
  rolloutAppend(path, serializeRecord("user", userText));
  if (assistantText) rolloutAppend(path, serializeRecord("assistant", assistantText));
}

/** Load persisted history as ChatMessages (user/assistant only), last N turns. */
export function loadHistory(path: string, maxTurns = 0): ChatMessage[] {
  const text = rolloutLoad(path, maxTurns);
  if (!text) return [];
  const out: ChatMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as { r: number; t: string };
      const role = CODE_ROLE[rec.r];
      if (role === "user" || role === "assistant") out.push({ role, content: rec.t });
    } catch {
      // Skip a malformed line rather than abort the whole resume.
    }
  }
  return out;
}

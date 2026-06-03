/**
 * Transcript serialization — the single source of truth for "copy the
 * conversation".
 *
 * Copy must never depend on terminal selection (terminals select rendered
 * cells: borders, header, footer, placeholder). It also must never include the
 * TUI's own chrome rows. Only the human↔model turns (`you` / `assistant`) are
 * serialized; `system`, `shell`, and `tool` rows are dropped so the clipboard
 * payload can never contain UI borders, status lines, or tool/shell noise.
 *
 * Tested by `test/commands/interactive.transcript.test.ts`.
 */

export type TranscriptRole = "you" | "assistant" | "system" | "shell" | "tool";

export interface TranscriptMessage {
  role: TranscriptRole;
  text: string;
}

/** Roles that are part of the actual conversation, not the TUI chrome. */
const CONVERSATION_ROLES: ReadonlySet<TranscriptRole> = new Set<TranscriptRole>(["you", "assistant"]);

/** On-screen speaker label for a conversation role (matches the rendered header). */
function speaker(role: TranscriptRole): string {
  return role === "you" ? "you" : "siftable";
}

/**
 * Serialize the conversation from the canonical message objects (never from
 * rendered cells). Returns "" when there is nothing the user would call a
 * conversation yet.
 */
export function serializeConversation(messages: readonly TranscriptMessage[]): string {
  return messages
    .filter((m) => CONVERSATION_ROLES.has(m.role) && m.text.trim())
    .map((m) => `${speaker(m.role)}: ${m.text.trim()}`)
    .join("\n\n");
}

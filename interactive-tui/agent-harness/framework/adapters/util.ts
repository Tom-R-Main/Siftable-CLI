/**
 * Adapter helpers shared across providers.
 */

/**
 * JSON.parse that doesn't throw. Adapters consume strings from the
 * history (which the framework controls) and from API responses (which
 * providers usually shape correctly), but a malformed value should not
 * crash the entire chat — it should degrade to a safe fallback so the
 * loop can continue.
 */
export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Claude Fable 5.1, Opus 5.5, and Sonnet 5.5 in any spelling: OpenRouter
 * (`anthropic/claude-opus-5.5`) or first-party (`claude-opus-5-5`). These
 * models reject sampling parameters, forced tool choice, disabled thinking,
 * and thinking budgets.
 */
export function isAdaptiveOnlyClaudeModel(model: string | undefined): boolean {
  return /claude-(?:fable-5[.-]1|opus-5[.-]5|sonnet-5[.-]5)(?![\d.])/i.test(model ?? "");
}

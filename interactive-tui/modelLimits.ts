/**
 * Shared per-model context-window metadata for the interactive runtime.
 *
 * Deliberately dependency-light: the agent-harness (compaction budgeting) and
 * the command/UI layer both consume this, so it must not import either side.
 *
 * Resolution order: exact model id → provider family → conservative fallback.
 * `SIFT_CONTEXT_WINDOW` overrides everything, validated as a finite positive
 * integer within CONTEXT_WINDOW_OVERRIDE_MAX — the previous `> 0` check let
 * values like 1e30 reach Uint32Array packing in the native planner, where they
 * silently wrapped.
 *
 * Values reflect the registry's documented claims per provider route and
 * variant, not prose parsing — a test asserts descriptions never claim more
 * than this table resolves, so drift fails CI rather than compacting against
 * a window 5-8x too small.
 */
export type ContextWindowSource = "override" | "model" | "family" | "fallback";

export interface ContextWindowResolution {
  window: number;
  /** How the window was decided — keeps conservative fallbacks observable. */
  source: ContextWindowSource;
}

export const FALLBACK_CONTEXT_WINDOW = 200_000;

/** Sanity bound for SIFT_CONTEXT_WINDOW — far past any shipping model. */
export const CONTEXT_WINDOW_OVERRIDE_MAX = 100_000_000;

/**
 * Exact per-variant windows, keyed by the model string the provider adapter
 * sees (e.g. `moonshotai/kimi-k3`, not the registry id `openrouter/…`). Bare
 * aliases cover callers that pass the unqualified name. Entries exist only
 * where the value is claimed/known for that exact variant — unknown variants
 * fall through to family or fallback rather than getting a confident wrong
 * answer.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "muse-spark-1.3-contributor": 1_000_000,
  "moonshotai/kimi-k3": 1_000_000,
  "kimi-k3": 1_000_000,
  "z-ai/glm-5.2": 1_000_000,
  "glm-5.2": 1_000_000,
  "deepseek/deepseek-v4-flash-0731": 1_000_000,
  "deepseek-v4-flash-0731": 1_000_000,
  // Claude Fable 5.1, Opus 5.5, and Sonnet 5.5: 1M context on OpenRouter and
  // the direct Anthropic API.
  "anthropic/claude-fable-5.1": 1_000_000,
  "claude-fable-5-1": 1_000_000,
  "anthropic/claude-opus-5.5": 1_000_000,
  "claude-opus-5-5": 1_000_000,
  "anthropic/claude-sonnet-5.5": 1_000_000,
  "claude-sonnet-5-5": 1_000_000,
};

// Provider-family estimates, first match wins. Conservative where a family
// varies; an exact MODEL_CONTEXT_WINDOWS entry always takes precedence.
const FAMILY_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/gemini/i, 1_000_000],
  [/claude/i, 200_000],
  [/deepseek/i, 128_000],
  [/gpt-?5|^gpt|o\d|codex/i, 256_000],
];

/**
 * Resolve the context window for a model id. `source` tells the caller whether
 * the answer is exact, a family estimate, or the conservative fallback — never
 * silently conflate them.
 */
export function resolveContextWindow(modelId?: string): ContextWindowResolution {
  if (modelId) {
    const exact = MODEL_CONTEXT_WINDOWS[modelId];
    if (exact !== undefined) return { window: exact, source: "model" };
    for (const [re, window] of FAMILY_CONTEXT_WINDOWS) {
      if (re.test(modelId)) return { window, source: "family" };
    }
  }
  return { window: FALLBACK_CONTEXT_WINDOW, source: "fallback" };
}

/**
 * Parse a SIFT_CONTEXT_WINDOW override. Returns the validated window, or null
 * when unset/invalid — callers treat null as "no override" (and may warn).
 * Requires a finite positive integer within a sane bound so out-of-range input
 * can never wrap inside the native planner's fixed-width packing.
 */
export function parseContextWindowOverride(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > CONTEXT_WINDOW_OVERRIDE_MAX) {
    return null;
  }
  return value;
}

/**
 * The TUI color palette — "Sieve" direction.
 *
 * Concept: your raw input is unsifted noise; the assistant's reply is the
 * *signal* you sifted out. Warm amber is reserved for meaning; everything
 * structural recedes to warm-dark. Status colors appear only for live state.
 *
 * Extracted from index.tsx so presentational components (views.tsx) and their
 * frame-snapshot tests share the exact same theme the app renders with. The
 * legacy key names (accent/accentStrong/user/bgMuted/transcriptSelection) are
 * retained so every call-site keeps working; new semantic keys are added below.
 */
export const theme = {
  // ── Surfaces (warm-dark "noise") ──────────────────────────────────────────
  bg: "#0a0a0a", // warm near-black canvas
  bgMuted: "#141210", // status bar, overlays, picker fill (a.k.a. surface)
  raised: "#1c1813", // raised surface / transcript selection
  border: "#2a241c", // dim frame
  borderActive: "#f5b700", // focused frame (== signal)

  // ── Text ladder (warm) ────────────────────────────────────────────────────
  text: "#f5efe6", // warm white body
  muted: "#a8a094", // labels, help text
  dim: "#6b6358", // gutters, de-emphasized

  // ── Signal (the sifted meaning) ───────────────────────────────────────────
  accent: "#f5b700", // fills, active borders, prompt glyph (signal)
  accentStrong: "#ffce4d", // labels/headings on black (signalText, hi-contrast)
  signal: "#f5b700",
  signalText: "#ffce4d",
  cool: "#5C9DFF", // links only — deliberate, rare contrast

  // ── Conversation roles ────────────────────────────────────────────────────
  user: "#cabfa9", // "you" — present but unsifted (warm cream)
  roleYou: "#cabfa9",
  roleAssistant: "#ffce4d", // "siftable" — the signal (amber)
  shell: "#b89cff", // `!` shell output
  tool: "#b0a08a", // tool-call lines

  // ── Live status (used only for in-flight state, never decoration) ─────────
  ok: "#2dc2a3",
  warn: "#ff9f45", // nudged orange so it ≠ signal amber
  err: "#ff6b6b",

  // ── Legacy alias kept for existing call-sites ─────────────────────────────
  transcriptSelection: "#1c1813",
};

export type Theme = typeof theme;

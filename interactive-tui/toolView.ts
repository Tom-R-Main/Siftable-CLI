/**
 * Pure helpers for surfacing what a tool call is actually doing in the
 * transcript — the command/query label and a clipped preview of its output.
 *
 * Kept out of index.tsx (which pulls in @opentui/solid and can't be loaded by
 * jest) so the label/clip logic is unit-testable on its own. The rendering in
 * index.tsx is a thin consumer: it shows `toolCallLabel(...)` next to the call
 * and `gutterIndent(clipOutput(...))` underneath it.
 *
 * Grounded in how opencode/codex expose exec output: show the command, then a
 * bounded slice of stdout/stderr with an explicit "+N more lines" marker — never
 * the whole firehose, and never a bare "✓ shell" with nothing behind it.
 */

/** Max width of the one-line label shown next to a tool call. */
const LABEL_MAX = 80;

/** Output preview bounds (opencode-style: bounded slice + truncation marker). */
export const OUTPUT_MAX_LINES = 8;
export const OUTPUT_MAX_BYTES = 2000;

function clipLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/**
 * Pull a salient arg out of a tool call for a one-line narration. Used for the
 * OpenFunction brain path (codex provides a ready-made `detail` instead). Array
 * values (e.g. a `command: ["bash","-lc","…"]`) are joined, not dropped.
 */
export function toolArgPreview(args?: Record<string, unknown>): string {
  if (!args) return "";
  const keys = ["command", "cmd", "path", "file", "query", "title", "id", "name"];
  const stringify = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map((x) => String(x)).join(" ");
    return "";
  };
  for (const k of keys) {
    const v = stringify(args[k]);
    if (v) return clipLine(`${k}=${v}`, LABEL_MAX);
  }
  const first = Object.entries(args)[0];
  if (first) {
    const v = stringify(first[1]);
    if (v) return clipLine(`${first[0]}=${v}`, LABEL_MAX);
  }
  return "";
}

/**
 * The one-line label shown next to a tool call. Codex hands us a ready `detail`
 * (the command/query/path); the OpenFunction brain hands us raw args.
 */
export function toolCallLabel(
  detail: string | undefined,
  args?: Record<string, unknown>,
): string {
  const d = (detail ?? "").trim();
  if (d) return clipLine(d, LABEL_MAX);
  return toolArgPreview(args);
}

/**
 * Clip a tool's output to a bounded preview: trailing whitespace trimmed, capped
 * to OUTPUT_MAX_BYTES, then to OUTPUT_MAX_LINES with a "+N more lines" marker.
 * Returns "" for empty/whitespace-only output (nothing to show).
 */
export function clipOutput(raw: string): string {
  let s = raw.replace(/\s+$/, "");
  if (!s) return "";
  if (s.length > OUTPUT_MAX_BYTES) {
    s = s.slice(0, OUTPUT_MAX_BYTES).replace(/\s+$/, "") + "\n… output truncated";
  }
  const lines = s.split("\n");
  if (lines.length <= OUTPUT_MAX_LINES) return lines.join("\n");
  const shown = lines.slice(0, OUTPUT_MAX_LINES);
  return shown.join("\n") + `\n… +${lines.length - OUTPUT_MAX_LINES} more lines`;
}

/** Indent each line with a subtle gutter so output nests visually under its call. */
export function gutterIndent(s: string): string {
  return s
    .split("\n")
    .map((line) => `  ▏ ${line}`)
    .join("\n");
}

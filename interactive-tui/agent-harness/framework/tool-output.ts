/**
 * The single output boundary between a tool's serialized result and the
 * model/journal. Content under the caps passes through byte-identical;
 * oversized content is reduced to a head+tail preview with an elision
 * marker, and the complete bytes are spilled — when a spill directory is
 * configured — to a private file the marker references.
 *
 * Caps fail closed: a non-finite or non-positive cap falls back to the
 * default, and a cap too small to honor (the marker alone would exceed it)
 * is raised to the documented minimum. The returned preview honors the
 * effective byte cap: the marker's measured size is subtracted from the
 * head/tail budget rather than taken from a fixed reserve.
 *
 * Spill files can contain anything a tool read (including secrets), so the
 * directory is created 0700 and files are written 0600 with exclusive
 * creation under a unique name — a spill file is immutable once written, so
 * a journal event's fullOutputRef always names the bytes it was written
 * with, even when a call id recurs. A spill failure never fails the tool:
 * the preview simply notes the output was not retained. Retention lifecycle
 * (quotas, cleanup on session deletion) is deliberately out of scope here;
 * files live until their session's store is deleted.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
export const DEFAULT_TOOL_OUTPUT_MAX_LINES = 2000;
/** Smallest honorable caps: marker + a useful head/tail must fit. */
export const MIN_TOOL_OUTPUT_MAX_BYTES = 1024;
export const MIN_TOOL_OUTPUT_MAX_LINES = 8;
/** Head/tail split of the preview budget: most signal is at the start. */
const HEAD_FRACTION = 0.6;

export interface ToolOutputConfig {
  /** Max bytes of model-facing content (default 50 KiB, min 1 KiB). */
  maxBytes?: number;
  /** Max lines of model-facing content (default 2000, min 8). */
  maxLines?: number;
  /** Directory for full-output spill files; no spill when unset. */
  spillDir?: string;
}

export interface BoundedToolOutput {
  /** Model-facing content: the input verbatim, or a head+tail preview. */
  content: string;
  truncated: boolean;
  byteCount: number;
  lineCount: number;
  /** Path to the complete output when truncated and spill succeeded. */
  fullOutputRef?: string;
}

/** Fail-closed cap: non-finite/non-positive -> fallback; tiny -> floor. */
function normalizeCap(value: number | undefined, fallback: number, floor: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(floor, Math.floor(value));
}

/** UTF-8-safe byte-budget prefix (a boundary codepoint may be dropped). */
export function bytePrefix(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1; // back off continuation bytes
  return buf.subarray(0, end).toString("utf8");
}

/** UTF-8-safe byte-budget suffix. */
function byteSuffix(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let start = buf.length - Math.max(0, maxBytes);
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString("utf8");
}

function sanitizeSpillKey(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  return cleaned || "output";
}

function spillFullOutput(spillDir: string, key: string, serialized: string): string | undefined {
  try {
    mkdirSync(spillDir, { recursive: true, mode: 0o700 });
    // Unique name + exclusive creation: never overwrite an existing file, so
    // a recurring call id cannot rewrite bytes an earlier journal event
    // references, and a pre-existing file's looser mode is never inherited.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const unique = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
      const path = join(spillDir, `${sanitizeSpillKey(key)}-${unique}.json`);
      try {
        writeFileSync(path, serialized, { mode: 0o600, flag: "wx" });
        return path;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      }
    }
    return undefined;
  } catch {
    return undefined; // retention is best-effort; the tool result stands
  }
}

/** Take whole lines from the front until either budget is exhausted. */
function takeLines(lines: readonly string[], maxLines: number, maxBytes: number): string[] {
  const out: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (out.length >= maxLines || bytes + cost > maxBytes) break;
    out.push(line);
    bytes += cost;
  }
  return out;
}

export function boundToolOutput(
  serialized: string,
  config: ToolOutputConfig | undefined,
  spillKey: string,
): BoundedToolOutput {
  const maxBytes = normalizeCap(config?.maxBytes, DEFAULT_TOOL_OUTPUT_MAX_BYTES, MIN_TOOL_OUTPUT_MAX_BYTES);
  const maxLines = normalizeCap(config?.maxLines, DEFAULT_TOOL_OUTPUT_MAX_LINES, MIN_TOOL_OUTPUT_MAX_LINES);
  const byteCount = Buffer.byteLength(serialized, "utf8");
  const lines = serialized.split("\n");
  const lineCount = lines.length;

  if (byteCount <= maxBytes && lineCount <= maxLines) {
    return { content: serialized, truncated: false, byteCount, lineCount };
  }

  const fullOutputRef = config?.spillDir
    ? spillFullOutput(config.spillDir, spillKey, serialized)
    : undefined;
  // The ref text is dropped (never the spill itself) when a long spill path
  // would leave no room for content inside the cap; the journal's output
  // metadata still carries the ref.
  let refText = fullOutputRef ? `at ${fullOutputRef}` : "not retained";
  const marker = (keptDescription: string) =>
    `[tool output truncated: kept ${keptDescription} of ${lineCount} lines ` +
    `(${byteCount} bytes); full output ${refText}]`;
  // Reserve the marker's measured worst case (longest kept-description it can
  // carry) plus its two joining newlines, so the preview honors maxBytes.
  const worstDescription = (): string => {
    const lineDesc = `${maxLines} head + ${maxLines} tail lines`;
    const byteDesc = `${maxBytes}-byte head + ${maxBytes}-byte tail`;
    return Buffer.byteLength(byteDesc, "utf8") > Buffer.byteLength(lineDesc, "utf8") ? byteDesc : lineDesc;
  };
  let markerReserve = Buffer.byteLength(marker(worstDescription()), "utf8") + 2;
  if (markerReserve >= maxBytes && fullOutputRef) {
    refText = "spilled";
    markerReserve = Buffer.byteLength(marker(worstDescription()), "utf8") + 2;
  }

  const budget = Math.max(0, maxBytes - markerReserve);
  const headBudgetBytes = Math.max(1, Math.floor(budget * HEAD_FRACTION));
  const tailBudgetBytes = Math.max(0, budget - headBudgetBytes);

  // Line-based head+tail keeps whole lines when the content has them.
  const headBudgetLines = Math.max(1, Math.floor(maxLines * HEAD_FRACTION));
  const head = takeLines(lines, headBudgetLines, headBudgetBytes);
  const tail = takeLines(
    [...lines.slice(head.length)].reverse(),
    Math.max(0, maxLines - head.length - 1),
    tailBudgetBytes,
  ).reverse();

  let content: string;
  if (head.length + tail.length > 0) {
    content = [...head, marker(`${head.length} head + ${tail.length} tail lines`), ...tail].join("\n");
  } else {
    // Single enormous line (the JSON.stringify norm): slice by bytes instead
    // of losing everything to whole-line selection.
    const headSlice = bytePrefix(serialized, headBudgetBytes);
    const tailSlice = byteSuffix(serialized.slice(headSlice.length), tailBudgetBytes);
    content = `${headSlice}\n${marker(`${headBudgetBytes}-byte head + ${tailBudgetBytes}-byte tail`)}\n${tailSlice}`;
  }

  return {
    content,
    truncated: true,
    byteCount,
    lineCount,
    ...(fullOutputRef ? { fullOutputRef } : {}),
  };
}

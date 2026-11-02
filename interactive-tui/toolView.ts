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

export type ExplorerActivityBranch = {
  id: string;
  role?: string;
  status: "ok" | "failed" | "skipped";
  elapsedMs?: number;
  suggestedFileCount: number;
  warningCount?: number;
  failureReason?: string;
};

export type ExplorerActivityView = {
  mode: "deterministic" | "scout" | "fanout";
  classification?: string;
  evidenceQuality?: "low" | "medium" | "high";
  cacheHit?: boolean;
  cacheMiss?: boolean;
  elapsedMs: number;
  reportChars: number;
  suggestedFileCount: number;
  usedSuggestedFileCount?: number;
  redundantBroadSearch?: boolean;
  primaryCandidates?: string[];
  scoutSuggestedFiles?: string[];
  fanoutSuggestedFiles?: string[];
  assignedRoles?: string[];
  branches?: ExplorerActivityBranch[];
  warnings?: string[];
  rawReport?: string;
};

function clipLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/**
 * Pull a salient arg out of a tool call for a one-line narration. Used for the
 * Agent-harness path (Codex provides a ready-made `detail` instead). Array
 * values (e.g. a `command: ["bash","-lc","…"]`) are joined, not dropped.
 */
export function toolArgPreview(args?: Record<string, unknown>): string {
  if (!args) return "";
  const keys = ["command", "cmd", "path", "file", "query", "title", "id", "name"];
  const stringify = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return v.map((x) => stringify(x)).filter(Boolean).join(" ");
    if (v && typeof v === "object") {
      const record = v as Record<string, unknown>;
      const path = typeof record.path === "string"
        ? record.path
        : typeof record.file === "string"
          ? record.file
          : "";
      if (path) {
        const start = typeof record.startLine === "number" ? record.startLine : undefined;
        const end = typeof record.endLine === "number" ? record.endLine : undefined;
        return start && end ? `${path}:${start}-${end}` : path;
      }
      return Object.entries(record)
        .slice(0, 3)
        .map(([key, value]) => {
          const preview = stringify(value);
          return preview ? `${key}:${preview}` : "";
        })
        .filter(Boolean)
        .join(",");
    }
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
 * (the command/query/path); the agent harness hands us raw args.
 */
export function toolCallLabel(
  detail: string | undefined,
  args?: Record<string, unknown>,
): string {
  const d = (detail ?? "").trim();
  if (d) return clipLine(d, LABEL_MAX);
  return toolArgPreview(args);
}

export function isExplorerToolName(name: string | undefined): boolean {
  return name === "repo_explorer" || name === "repo_explorer_scout" || name === "repo_explorer_fanout";
}

export function explorerToolCallText(name: string, detail?: string): string {
  const label = name === "repo_explorer_fanout"
    ? "checking repo in parallel"
    : name === "repo_explorer_scout"
      ? "checking repo"
      : "checking repo";
  const d = (detail ?? "").trim();
  return `◇ Explorer · ${label}${d ? ` · ${clipLine(d, 44)}` : ""}`;
}

function formatCount(label: string, count: number | undefined): string {
  return typeof count === "number" ? `${count} ${label}${count === 1 ? "" : "s"}` : "";
}

function formatReportSize(chars: number): string {
  if (chars < 1024) return `${chars}B`;
  return `${(chars / 1024).toFixed(1)}KB`;
}

function cacheText(activity: ExplorerActivityView): string {
  if (activity.cacheHit) return "cache hit";
  if (activity.cacheMiss) return "cache miss";
  return "";
}

function modeText(mode: ExplorerActivityView["mode"]): string {
  return mode === "fanout" ? "fan-out" : mode;
}

function explorerStatusText(activity: ExplorerActivityView): string {
  const branches = activity.branches ?? [];
  if (activity.mode === "fanout" && branches.length > 0 && branches.every((branch) => branch.status !== "ok")) {
    return "fallback only";
  }
  if (activity.evidenceQuality === "low") return "low-confidence map";
  return "checked repo";
}

export function formatExplorerActivityLine(activity: ExplorerActivityView): string {
  const branchText = activity.mode === "fanout" && activity.branches?.length
    ? `${activity.branches.filter((branch) => branch.status === "ok").length}/${activity.branches.length} scouts`
    : "";
  const roles = activity.mode === "fanout" && activity.assignedRoles?.length
    ? clipLine(activity.assignedRoles.slice(0, 4).join("/"), 56)
    : "";
  const warnings = activity.warnings?.length
    ? formatCount("warning", activity.warnings.length)
    : "";
  return [
    "◇ Explorer",
    explorerStatusText(activity),
    roles,
    branchText,
    formatCount("file", activity.suggestedFileCount),
    `${activity.elapsedMs}ms`,
    warnings,
  ].filter(Boolean).join(" · ");
}

export function formatExplorerActivityDetails(activity: ExplorerActivityView): string {
  const lines = [
    `Mode: ${modeText(activity.mode)}`,
    `Cache: ${cacheText(activity) || "unknown"}`,
    `Elapsed: ${activity.elapsedMs}ms`,
    `Report: ${formatReportSize(activity.reportChars)}`,
    `Files suggested: ${activity.suggestedFileCount}`,
  ];
  if (typeof activity.usedSuggestedFileCount === "number") {
    lines.push(`Used by model: ${activity.usedSuggestedFileCount}`);
  }
  if (typeof activity.redundantBroadSearch === "boolean") {
    lines.push(`Redundant broad search: ${activity.redundantBroadSearch ? "yes" : "no"}`);
  }
  if (activity.assignedRoles?.length) {
    lines.push(`Assigned scouts: ${activity.assignedRoles.join(', ')}`);
  }

  const primary = activity.primaryCandidates ?? [];
  if (primary.length) {
    lines.push("", "Primary candidates", ...primary.slice(0, 8).map((path) => `- ${path}`));
  }

  const scout = activity.scoutSuggestedFiles ?? [];
  if (scout.length) {
    lines.push("", "Scout suggestions", ...scout.slice(0, 8).map((path) => `- ${path}`));
  }

  const fanout = activity.fanoutSuggestedFiles ?? [];
  if (fanout.length) {
    lines.push("", "Fan-out suggestions", ...fanout.slice(0, 10).map((path) => `- ${path}`));
  }

  const branches = activity.branches ?? [];
  if (branches.length) {
    lines.push("", "Fan-out branches");
    for (const branch of branches) {
      const icon = branch.status === "ok" ? "✓" : branch.status === "failed" ? "⚠" : "-";
      const warnings = branch.warningCount ? ` · ${formatCount("warning", branch.warningCount)}` : "";
      const failure = branch.failureReason ? ` · ${clipLine(branch.failureReason, 72)}` : "";
      const role = branch.role && branch.role !== branch.id ? ` · ${branch.role}` : "";
      lines.push(`${icon} ${branch.id}${role} · ${formatCount("file", branch.suggestedFileCount)} · ${branch.elapsedMs ?? 0}ms${warnings}${failure}`);
    }
  }

  const warnings = activity.warnings ?? [];
  if (warnings.length) {
    lines.push("", "Warnings", ...warnings.slice(0, 8).map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

export function asExplorerActivityView(input: unknown): ExplorerActivityView | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Partial<ExplorerActivityView>;
  if (
    (record.mode === "deterministic" || record.mode === "scout" || record.mode === "fanout") &&
    (record.evidenceQuality === undefined || record.evidenceQuality === "low" || record.evidenceQuality === "medium" || record.evidenceQuality === "high") &&
    typeof record.elapsedMs === "number" &&
    typeof record.reportChars === "number" &&
    typeof record.suggestedFileCount === "number"
  ) {
    return record as ExplorerActivityView;
  }
  return null;
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

/** A display-only projection. The caller must retain the original tool result. */
export interface ToolOutputSummaryOptions {
  /** Unwrapped command output must not be interpreted as a tool envelope. */
  format?: "text";
  /** Usable terminal columns, excluding the transcript gutter. */
  width?: number;
  args?: Record<string, unknown>;
}

function outputRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function outputText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Strip terminal controls; conservatively budget non-ASCII glyphs as two cells. */
function boundedOutputLines(text: string, width: number): string {
  const clean = text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").trim();
  if (!clean) return "";
  const source = clean.split("\n");
  const shown = source.slice(0, 3).map((line) => {
    let used = 0;
    let result = "";
    for (const glyph of line.replace(/\t/g, "  ")) {
      const cells = /\p{Mark}/u.test(glyph) ? 0 : glyph.codePointAt(0)! > 127 ? 2 : 1;
      if (used + cells > width - 2) return result + "…";
      result += glyph;
      used += cells;
      // Combining characters also have a finite processing/display budget.
      if (result.length >= OUTPUT_MAX_BYTES) return result + "…";
    }
    return result;
  });
  if (source.length > 3) {
    const marker = `… +${source.length - 3} more lines`;
    shown.push(marker.length + 1 <= width ? marker : "…");
  }
  return shown.join("\n");
}

/**
 * OpenCode-style semantic Read/Grep/Skill labels with Codex-style bounded rows.
 * Never serialize unknown result fields or skill/file bodies into the preview.
 */
export function summarizeToolOutput(
  name: string,
  raw: string,
  options: ToolOutputSummaryOptions = {},
): string {
  const width = Number.isFinite(options.width) ? Math.max(4, Math.floor(options.width!)) : 100;
  const render = (lines: string[]) => boundedOutputLines(lines.filter(Boolean).join("\n"), width);
  if (!raw.trim()) return "";
  if (options.format === "text") return boundedOutputLines(raw, width);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Incomplete serialized payloads are not useful human-facing previews.
    if (/^\s*\{/.test(raw) && /"(?:success|data|error|message)"\s*:/.test(raw)) return render([/truncat(?:ed|ion)/i.test(raw)
      ? "Structured output truncated (preview unavailable)"
      : "Structured output received (preview unavailable)"]);
    return boundedOutputLines(raw, width);
  }
  if (typeof parsed === "string") return boundedOutputLines(parsed, width);
  const envelope = outputRecord(parsed);
  const data = outputRecord(envelope.data ?? parsed);
  const error = outputText(envelope.error) || outputText(data.error)
    || outputText(outputRecord(envelope.error).message);
  if (envelope.success === false || data.success === false || error) {
    return render([`Failed: ${error || outputText(envelope.message) || "tool reported failure"}`]);
  }
  const args = options.args ?? {};
  if (name === "skill" || name === "load_skill") {
    return render([`Loaded skill: ${outputText(data.name) || outputText(args.name) || "requested skill"}`]);
  }
  if (/search|find_local_files|grep/.test(name) && Array.isArray(data.matches)) {
    const matches = Array.isArray(data.matches) ? data.matches : [];
    const stats = outputRecord(data.stats);
    const scan = outputRecord(stats.scan);
    const presentation = outputRecord(stats.presentation);
    const count = typeof stats.matches === "number" ? stats.matches : matches.length;
    const searched = typeof stats.searchedFiles === "number" ? ` in ${stats.searchedFiles} files` : "";
    const partial = scan.status === "partial" || stats.capped === true;
    const reasons = Array.isArray(scan.reasons) ? scan.reasons.filter((item) => typeof item === "string") : [];
    const status = [partial ? "partial search" : "", stats.capped === true ? "capped" : "",
      presentation.clipped === true || stats.truncated === true ? "results clipped" : "",
      ...reasons].filter(Boolean).join(" · ");
    return render([
      `${count} matches${searched}${status ? ` · ${status}` : ""}`,
      ...matches.slice(0, 3).map((match) => {
        const item = outputRecord(match);
        return `${outputText(item.path) || outputText(match)}${typeof item.line === "number" ? `:${item.line}` : ""}`;
      }),
    ]);
  }
  if (/read.*file|file.*read/.test(name)) {
    const files = Array.isArray(data.files) ? data.files : [data];
    const failures = files.filter((file) => Boolean(outputRecord(file).error)).length;
    const outcome = failures ? `${files.length - failures} files read · ${failures} failed` : `${files.length} file${files.length === 1 ? "" : "s"} read`;
    const truncated = data.truncated === true || files.some((file) => outputRecord(file).truncated === true);
    return render([`${truncated ? "Partial read · truncated · " : ""}${outcome}`, ...[...files].sort((a, b) => Number(Boolean(outputRecord(b).error)) - Number(Boolean(outputRecord(a).error))).map((file) => {
      const item = outputRecord(file);
      const path = outputText(item.path) || outputText(args.path) || outputText(args.file);
      const descriptors = Array.isArray(args.files) ? args.files : [];
      const requested = outputRecord(descriptors.find((entry) => outputRecord(entry).path === path));
      const start = item.startLine ?? requested.startLine ?? args.startLine;
      const end = item.endLine ?? requested.endLine ?? args.endLine;
      const failure = outputText(item.error);
      return `${path}${typeof start === "number" ? `:${start}${typeof end === "number" ? `-${end}` : ""}` : ""}${failure ? ` · Failed: ${failure}` : ""}`;
    })]);
  }
  for (const key of ["tasks", "workItems", "work_items", "items"]) {
    if (!Array.isArray(data[key])) continue;
    const items = data[key] as unknown[];
    const label = key === "tasks" ? "tasks" : "items";
    const total = typeof data.total === "number" ? ` of ${data.total}` : "";
    return render([`${items.length}${total} ${label} returned`, ...items.map((entry) => {
      const item = outputRecord(entry);
      const title = outputText(item.title) || outputText(item.name);
      const status = outputText(item.status);
      return title ? `${title}${status ? ` · ${status}` : ""}` : "Untitled item";
    })]);
  }
  // Shell envelopes carry useful plain stdout/stderr, not structured metadata.
  const stdout = outputText(data.stdout);
  const stderr = outputText(data.stderr);
  const exitCode = data.exitCode ?? data.exit_code;
  if (stdout || stderr || typeof exitCode === "number") {
    return render([typeof exitCode === "number" ? `Exit ${exitCode}` : "", stderr, stdout]);
  }
  const collection = Array.isArray(parsed) ? parsed : Array.isArray(envelope.data) ? envelope.data : null;
  if (collection) return render([`${collection.length} results returned`]);
  return render([outputText(envelope.message) || outputText(data.message)
    || (envelope.success === true ? "Completed" : "Structured result received")]);
}

/** Indent each line with a subtle gutter so output nests visually under its call. */
export function gutterIndent(s: string): string {
  return s
    .split("\n")
    .map((line) => `  ▏ ${line}`)
    .join("\n");
}

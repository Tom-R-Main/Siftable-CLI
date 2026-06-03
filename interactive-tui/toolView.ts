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
 * OpenFunction brain path (codex provides a ready-made `detail` instead). Array
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
    "checked repo",
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

/** Indent each line with a subtle gutter so output nests visually under its call. */
export function gutterIndent(s: string): string {
  return s
    .split("\n")
    .map((line) => `  ▏ ${line}`)
    .join("\n");
}

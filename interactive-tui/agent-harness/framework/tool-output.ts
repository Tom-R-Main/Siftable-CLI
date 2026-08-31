/**
 * The single output boundary between a tool's serialized result and the
 * model/journal. Content under the caps passes through byte-identical;
 * oversized content is reduced to a head+tail preview with an elision
 * marker, and the complete bytes are spilled — when a spill directory is
 * configured — to a private file referenced only by local journal metadata.
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
 * the preview simply notes the output was not retained. Spill retention is
 * bounded by age, bytes, and file count. Callers that have the authoritative
 * session projection provide its referenced paths so collection can remove
 * abandoned files without deleting live receipts.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 50 * 1024;
export const DEFAULT_TOOL_OUTPUT_MAX_LINES = 2000;
/** Smallest honorable caps: marker + a useful head/tail must fit. */
export const MIN_TOOL_OUTPUT_MAX_BYTES = 1024;
export const MIN_TOOL_OUTPUT_MAX_LINES = 8;
export const DEFAULT_TOOL_OUTPUT_SPILL_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_TOOL_OUTPUT_SPILL_MAX_FILES = 256;
export const DEFAULT_TOOL_OUTPUT_SPILL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_TOOL_OUTPUT_SPILL_ORPHAN_GRACE_MS = 5 * 60 * 1000;
/** Head/tail split of the preview budget: most signal is at the start. */
const HEAD_FRACTION = 0.6;
const OWNED_SPILL_DIR_NAME = ".sift-tool-output-v1";
const OWNED_SPILL_FILE_PREFIX = "spill-";
const OWNERSHIP_MARKER_NAME = ".owner";
const OWNERSHIP_MARKER_CONTENT = "sift-tool-output-v1\n";

export interface ToolOutputSpillPolicy {
  /** Maximum retained bytes per session spill directory (default 100 MiB). */
  maxBytes?: number;
  /** Maximum retained spill files per session (default 256). */
  maxFiles?: number;
  /** Hard retention age (default seven days). */
  maxAgeMs?: number;
  /** Minimum age before an unreferenced file may be collected (default five minutes). */
  orphanGraceMs?: number;
}

export interface ToolOutputConfig {
  /** Max bytes of model-facing content (default 50 KiB, min 1 KiB). */
  maxBytes?: number;
  /** Max lines of model-facing content (default 2000, min 8). */
  maxLines?: number;
  /** Parent directory for a module-owned spill directory; no spill when unset. */
  spillDir?: string;
  /** Retention limits for the per-session spill directory. */
  spillPolicy?: ToolOutputSpillPolicy;
  /**
   * Paths referenced by the current durable session projection. When set,
   * quota collection may remove other files after orphanGraceMs. When unset,
   * existing non-expired files are conservatively treated as referenced.
   */
  protectedSpillRefs?: Iterable<string>;
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

export interface ToolOutputSpillCollectionResult {
  removed: number;
  removedBytes: number;
  retained: number;
  retainedBytes: number;
  /** Whether the retained set plus the requested reserve fits both quotas. */
  withinQuota: boolean;
}

export interface ResolvedToolOutputSpillPolicy {
  maxBytes: number;
  maxFiles: number;
  maxAgeMs: number;
  orphanGraceMs: number;
}

interface SpillEntry {
  path: string;
  bytes: number;
  mtimeMs: number;
}

/** Fail-closed cap: non-finite/non-positive -> fallback; tiny -> floor. */
function normalizeCap(value: number | undefined, fallback: number, floor: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(floor, Math.floor(value));
}

function normalizeDuration(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/** Resolve malformed/partial policy input to the exact effective limits. */
export function resolveToolOutputSpillPolicy(
  policy: ToolOutputSpillPolicy | undefined,
): ResolvedToolOutputSpillPolicy {
  return {
    maxBytes: normalizeCap(policy?.maxBytes, DEFAULT_TOOL_OUTPUT_SPILL_MAX_BYTES, 1),
    maxFiles: normalizeCap(policy?.maxFiles, DEFAULT_TOOL_OUTPUT_SPILL_MAX_FILES, 1),
    maxAgeMs: normalizeDuration(policy?.maxAgeMs, DEFAULT_TOOL_OUTPUT_SPILL_MAX_AGE_MS),
    orphanGraceMs: normalizeDuration(
      policy?.orphanGraceMs,
      DEFAULT_TOOL_OUTPUT_SPILL_ORPHAN_GRACE_MS,
    ),
  };
}

function ownedSpillDirPath(spillRoot: string): string | undefined {
  if (!spillRoot.trim()) return undefined;
  return join(resolve(spillRoot), OWNED_SPILL_DIR_NAME);
}

function isOwnedSpillFilename(name: string): boolean {
  return name.startsWith(OWNED_SPILL_FILE_PREFIX) && name.endsWith(".json");
}

function ensurePrivateSpillDir(spillRoot: string): string | undefined {
  const spillDir = ownedSpillDirPath(spillRoot);
  if (!spillDir) return undefined;
  try {
    mkdirSync(spillDir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(spillDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    chmodSync(spillDir, 0o700);
    const marker = join(spillDir, OWNERSHIP_MARKER_NAME);
    try {
      writeFileSync(marker, OWNERSHIP_MARKER_CONTENT, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      const markerStat = lstatSync(marker);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) return undefined;
      if (readFileSync(marker, "utf8") !== OWNERSHIP_MARKER_CONTENT) return undefined;
    }
    chmodSync(marker, 0o600);
    return spillDir;
  } catch {
    return undefined;
  }
}

function directChildPath(spillDir: string, candidate: string): string | undefined {
  const root = resolve(spillDir);
  const path = resolve(candidate);
  return dirname(path) === root ? path : undefined;
}

function listSpills(spillRoot: string): SpillEntry[] {
  const spillDir = ensurePrivateSpillDir(spillRoot);
  if (!spillDir) return [];
  const entries: SpillEntry[] = [];
  try {
    for (const dirent of readdirSync(spillDir, { withFileTypes: true })) {
      if (!dirent.isFile() || !isOwnedSpillFilename(dirent.name)) continue;
      const path = join(spillDir, dirent.name);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        entries.push({ path: resolve(path), bytes: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // A concurrent collector or session deletion may have removed it.
      }
    }
  } catch {
    return [];
  }
  return entries;
}

/**
 * Collect expired spills and, when references are complete, abandoned/quota
 * victims. Expiration is a hard privacy bound. Quota collection never removes
 * a path present in protectedPaths, and reserve space protects a spill about
 * to be created from being immediately selected as a victim.
 */
export function garbageCollectToolOutputSpills(options: {
  spillDir: string;
  policy?: ToolOutputSpillPolicy;
  protectedPaths?: Iterable<string>;
  /** True only when protectedPaths came from the authoritative journal projection. */
  referencesComplete?: boolean;
  reserveBytes?: number;
  reserveFiles?: number;
  nowMs?: number;
}): ToolOutputSpillCollectionResult {
  const policy = resolveToolOutputSpillPolicy(options.policy);
  const nowMs = options.nowMs ?? Date.now();
  const reserveBytes = Math.max(0, Math.floor(options.reserveBytes ?? 0));
  const reserveFiles = Math.max(0, Math.floor(options.reserveFiles ?? 0));
  const root = ownedSpillDirPath(options.spillDir);
  if (!root) {
    return {
      removed: 0,
      removedBytes: 0,
      retained: 0,
      retainedBytes: 0,
      withinQuota: false,
    };
  }
  const protectedPaths = new Set<string>();
  for (const candidate of options.protectedPaths ?? []) {
    const path = directChildPath(root, candidate);
    if (path) protectedPaths.add(path);
  }

  let entries = listSpills(options.spillDir);
  let removed = 0;
  let removedBytes = 0;
  const remove = (entry: SpillEntry): boolean => {
    try {
      unlinkSync(entry.path);
      removed += 1;
      removedBytes += entry.bytes;
      return true;
    } catch {
      return false;
    }
  };

  // maxAgeMs is a hard retention limit, including for journal-referenced
  // files. orphanGraceMs prevents racing a spill that has not been appended.
  entries = entries.filter((entry) => {
    const ageMs = Math.max(0, nowMs - entry.mtimeMs);
    const expired = ageMs >= policy.maxAgeMs && ageMs >= policy.orphanGraceMs;
    const orphaned = options.referencesComplete === true
      && !protectedPaths.has(entry.path)
      && ageMs >= policy.orphanGraceMs;
    return (expired || orphaned) && remove(entry) ? false : true;
  });

  let retainedBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let retained = entries.length;
  const exceedsQuota = () =>
    retainedBytes + reserveBytes > policy.maxBytes || retained + reserveFiles > policy.maxFiles;

  if (exceedsQuota() && options.referencesComplete === true) {
    const victims = entries
      // A fresh unreferenced file may be between exclusive creation and its
      // journal append. The grace period protects that in-flight spill from
      // quota collection just as it protects it from orphan collection.
      .filter((entry) =>
        !protectedPaths.has(entry.path)
        && Math.max(0, nowMs - entry.mtimeMs) >= policy.orphanGraceMs,
      )
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
    for (const victim of victims) {
      if (!exceedsQuota()) break;
      if (!remove(victim)) continue;
      entries = entries.filter((entry) => entry.path !== victim.path);
      retained -= 1;
      retainedBytes -= victim.bytes;
    }
  }

  return {
    removed,
    removedBytes,
    retained,
    retainedBytes,
    withinQuota: !exceedsQuota(),
  };
}

/** Best-effort deletion of one explicitly identified module-owned spill. */
export function discardToolOutputSpill(fullOutputRef: string, spillDir: string): boolean {
  const ownedDir = ownedSpillDirPath(spillDir);
  if (!ownedDir) return false;
  const path = directChildPath(ownedDir, fullOutputRef);
  if (!path || !isOwnedSpillFilename(basename(path))) return false;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Delete only the marked module-owned child used by one session. */
export function cleanupToolOutputSpillSession(spillDir: string): boolean {
  const ownedDir = ownedSpillDirPath(spillDir);
  if (!ownedDir) return false;
  try {
    const stat = lstatSync(ownedDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    // Delete only files this module owns. Refuse a non-empty directory with
    // foreign entries rather than turning a bad session path into recursive
    // data loss.
    const ownedPaths: string[] = [];
    let markerSeen = false;
    for (const dirent of readdirSync(ownedDir, { withFileTypes: true })) {
      if (dirent.name === OWNERSHIP_MARKER_NAME) {
        if (!dirent.isFile()) return false;
        const marker = join(ownedDir, dirent.name);
        const markerStat = lstatSync(marker);
        if (markerStat.isSymbolicLink() || readFileSync(marker, "utf8") !== OWNERSHIP_MARKER_CONTENT) {
          return false;
        }
        markerSeen = true;
        continue;
      }
      if (!dirent.isFile() || !isOwnedSpillFilename(dirent.name)) return false;
      const path = directChildPath(ownedDir, join(ownedDir, dirent.name));
      if (!path) return false;
      const child = lstatSync(path);
      if (!child.isFile() || child.isSymbolicLink()) return false;
      ownedPaths.push(path);
    }
    if (!markerSeen) return false;
    for (const path of ownedPaths) unlinkSync(path);
    unlinkSync(join(ownedDir, OWNERSHIP_MARKER_NAME));
    rmdirSync(ownedDir);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
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

function spillFullOutput(
  spillDir: string,
  key: string,
  serialized: string,
  config: ToolOutputConfig,
): string | undefined {
  try {
    const ownedDir = ensurePrivateSpillDir(spillDir);
    if (!ownedDir) return undefined;
    const bytes = Buffer.byteLength(serialized, "utf8");
    const quota = garbageCollectToolOutputSpills({
      spillDir,
      policy: config.spillPolicy,
      protectedPaths: config.protectedSpillRefs,
      referencesComplete: config.protectedSpillRefs !== undefined,
      reserveBytes: bytes,
      reserveFiles: 1,
    });
    if (!quota.withinQuota) return undefined;
    // Unique name + exclusive creation: never overwrite an existing file, so
    // a recurring call id cannot rewrite bytes an earlier journal event
    // references, and a pre-existing file's looser mode is never inherited.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const unique = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
      const path = join(
        ownedDir,
        `${OWNED_SPILL_FILE_PREFIX}${sanitizeSpillKey(key)}-${unique}.json`,
      );
      try {
        writeFileSync(path, serialized, { mode: 0o600, flag: "wx" });
        chmodSync(path, 0o600);
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
    ? spillFullOutput(config.spillDir, spillKey, serialized, config)
    : undefined;
  // The absolute ref remains local journal metadata. Model-facing content
  // only states whether retention succeeded so local usernames and paths are
  // never sent to the external model on the next round.
  const refText = fullOutputRef ? "retained privately" : "not retained";
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
  const markerReserve = Buffer.byteLength(marker(worstDescription()), "utf8") + 2;

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

/**
 * Native local filesystem engine.
 *
 * Zig owns the byte-heavy path under Bun (`native/fs_engine.zig`); TypeScript
 * keeps a same-policy fallback for tests and degraded local dev. The FFI
 * contract is intentionally boring: caller-owned output buffers, ptr+u32
 * strings, status codes, and compact JSON result frames.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve as resolvePath, relative } from "node:path";

export interface ReadTextResult {
  path: string;
  content: string;
  truncated: boolean;
  bytes: number;
  source: "zig" | "ts";
}

export interface SearchCaps {
  maxFiles?: number;
  maxMatches?: number;
  maxDepth?: number;
  maxFileBytes?: number;
  previewBytes?: number;
  includeHidden?: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  byteStart: number;
  byteEnd: number;
  preview: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  stats: {
    searchedFiles: number;
    skippedFiles: number;
    matchedFiles: number;
    matches: number;
    truncated: number;
  };
  source: "zig" | "ts";
}

export interface WorkspaceFile {
  path: string;
  absPath: string;
  bytes: number;
  depth: number;
  language: string;
  keyReason?: "package" | "entrypoint" | "config" | "test" | "readme" | "native" | "build";
}

export interface WorkspaceSymbol {
  path: string;
  language: string;
  symbol: string;
  kind: "function" | "class" | "type" | "interface" | "method" | "export";
  line: number;
  score: number;
  signature?: string;
}

export interface InspectLocalWorkspaceResult {
  root: string;
  repoKind: "git" | "plain";
  languages: Array<{ language: string; files: number; bytes: number }>;
  keyFiles: Array<{ path: string; reason: NonNullable<WorkspaceFile["keyReason"]> }>;
  tree: Array<{ path: string; kind: "dir" | "file"; files?: number; bytes?: number; omitted?: boolean }>;
  symbols: WorkspaceSymbol[];
  stats: {
    scannedFiles: number;
    skippedFiles: number;
    binaryFiles: number;
    truncated: boolean;
  };
  source: "ts";
}

export interface CodeSearchResult {
  answerHint?: string;
  files: Array<{ path: string; score: number; reasons: string[]; symbols: string[] }>;
  spans: Array<{
    path: string;
    startLine: number;
    endLine: number;
    preview: string;
    matchedQueries: string[];
    score: number;
    symbol?: string;
  }>;
  followups: Array<{ tool: "batch_read_files"; args: { path: string; startLine: number; endLine: number }; reason: string }>;
  stats: { searchedFiles: number; matchedFiles: number; searchedBytes: number; truncated: boolean };
}

export interface FileSearchResult {
  matches: Array<{
    path: string;
    score: number;
    indices: number[];
    language: string;
    reason?: WorkspaceFile["keyReason"];
  }>;
  stats: { scannedFiles: number; skippedFiles: number; truncated: boolean };
  source: "ts";
}

export interface BatchReadFilesResult {
  files: Array<{
    path: string;
    content: string;
    startLine: number;
    endLine: number;
    truncated: boolean;
    bytes: number;
    error?: string;
  }>;
  truncated: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

const STATUS_OK = 0;
const STATUS_OUTPUT_TOO_SMALL = 9;
const DEFAULT_READ_BYTES = 64 * 1024;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_MATCHES = 100;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_PREVIEW_BYTES = 240;
const NOISY_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "coverage", "tmp", ".zig-cache", "zig-out"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".zig", ".rs", ".go", ".py", ".swift", ".java", ".kt", ".rb", ".php", ".css", ".scss", ".html", ".json", ".md", ".toml", ".yaml", ".yml"]);

type NativeSymbols = {
  sift_fs_read_text: (
    path: Uint8Array,
    pathLen: number,
    maxBytes: number,
    out: Uint8Array,
    outCap: number,
    written: Uint32Array,
    needed: Uint32Array,
  ) => number;
  sift_fs_search_literal: (
    root: Uint8Array,
    rootLen: number,
    query: Uint8Array,
    queryLen: number,
    caps: Uint32Array,
    out: Uint8Array,
    outCap: number,
    written: Uint32Array,
    needed: Uint32Array,
    stats: Uint32Array,
  ) => number;
};

let native: NativeSymbols | null | undefined;

function nativeSymbols(): NativeSymbols | null {
  if (native !== undefined) return native;
  if (typeof Bun === "undefined" || process.env.SIFT_NO_NATIVE === "1") {
    native = null;
    return native;
  }
  const { default: nativeLibraryPath } = require("./native/fs_engine") as { default: string };
  if (!existsSync(nativeLibraryPath)) {
    native = null;
    return native;
  }

  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
  const lib = dlopen(nativeLibraryPath, {
    sift_fs_read_text: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32,
    },
    sift_fs_search_literal: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.u32,
    },
  });

  native = lib.symbols as NativeSymbols;
  return native;
}

function readJsonFromOut(out: Uint8Array, written: Uint32Array): string {
  return decoder.decode(out.subarray(0, written[0]));
}

function grow(cap: number, needed: Uint32Array): number {
  return Math.max(cap * 2, needed[0] + 1024);
}

export async function readText(path: string, maxBytes = DEFAULT_READ_BYTES): Promise<ReadTextResult> {
  const symbols = nativeSymbols();
  if (symbols) {
    const pathBytes = encoder.encode(path);
    let cap = Math.max(4096, maxBytes + 8192);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const out = new Uint8Array(cap);
      const written = new Uint32Array(1);
      const needed = new Uint32Array(1);
      const status = symbols.sift_fs_read_text(pathBytes, pathBytes.byteLength, maxBytes, out, out.byteLength, written, needed);
      if (status === STATUS_OK) return { ...JSON.parse(readJsonFromOut(out, written)), source: "zig" };
      if (status === STATUS_OUTPUT_TOO_SMALL) {
        cap = grow(cap, needed);
        continue;
      }
      throw new Error(nativeStatusMessage(status, "read_file"));
    }
  }
  return readTextFallback(path, maxBytes);
}

export async function searchLiteral(root: string, query: string, caps: SearchCaps = {}): Promise<SearchResult> {
  const symbols = nativeSymbols();
  if (symbols) {
    const rootBytes = encoder.encode(root);
    const queryBytes = encoder.encode(query);
    const capWords = new Uint32Array([
      caps.maxFiles ?? DEFAULT_MAX_FILES,
      caps.maxMatches ?? DEFAULT_MAX_MATCHES,
      caps.maxDepth ?? DEFAULT_MAX_DEPTH,
      caps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      caps.previewBytes ?? DEFAULT_PREVIEW_BYTES,
      caps.includeHidden ? 1 : 0,
    ]);

    let cap = 256 * 1024;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const out = new Uint8Array(cap);
      const written = new Uint32Array(1);
      const needed = new Uint32Array(1);
      const stats = new Uint32Array(5);
      const status = symbols.sift_fs_search_literal(
        rootBytes,
        rootBytes.byteLength,
        queryBytes,
        queryBytes.byteLength,
        capWords,
        out,
        out.byteLength,
        written,
        needed,
        stats,
      );
      if (status === STATUS_OK) return { ...JSON.parse(readJsonFromOut(out, written)), source: "zig" };
      if (status === STATUS_OUTPUT_TOO_SMALL) {
        cap = grow(cap, needed);
        continue;
      }
      throw new Error(nativeStatusMessage(status, "search_local_files"));
    }
  }
  return searchLiteralFallback(root, query, caps);
}

function nativeStatusMessage(status: number, op: string): string {
  const label =
    status === 1 ? "invalid arguments" :
    status === 2 ? "not found" :
    status === 3 ? "not a file" :
    status === 4 ? "not a directory" :
    status === 5 ? "permission denied" :
    status === 6 ? "binary file skipped" :
    status === 7 ? "file too large" :
    status === 8 ? "invalid UTF-8" :
    status === 13 ? "I/O error" :
    `native status ${status}`;
  return `${op}: ${label}`;
}

async function readTextFallback(path: string, maxBytes: number): Promise<ReadTextResult> {
  const data = await readFile(path);
  if (data.subarray(0, Math.min(data.byteLength, 8192)).includes(0)) throw new Error("read_file: binary file skipped");
  const truncated = data.byteLength > maxBytes;
  return {
    path,
    content: data.subarray(0, maxBytes).toString("utf8"),
    truncated,
    bytes: data.byteLength,
    source: "ts",
  };
}

async function searchLiteralFallback(root: string, query: string, caps: SearchCaps): Promise<SearchResult> {
  const absRoot = resolvePath(root || ".");
  const maxFiles = caps.maxFiles ?? DEFAULT_MAX_FILES;
  const maxMatches = caps.maxMatches ?? DEFAULT_MAX_MATCHES;
  const maxDepth = caps.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFileBytes = caps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const previewBytes = caps.previewBytes ?? DEFAULT_PREVIEW_BYTES;
  const includeHidden = Boolean(caps.includeHidden);
  const matches: SearchMatch[] = [];
  const stats = { searchedFiles: 0, skippedFiles: 0, matchedFiles: 0, matches: 0, truncated: 0 };

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || stats.searchedFiles >= maxFiles || matches.length >= maxMatches) {
      stats.truncated = 1;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      stats.skippedFiles += 1;
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      const abs = join(dir, name);
      const rel = relative(absRoot, abs) || name;
      if (!includeHidden && rel.split(/[\\/]/).some((part) => part.startsWith("."))) {
        stats.skippedFiles += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (NOISY_DIRS.has(name)) {
          stats.skippedFiles += 1;
          continue;
        }
        await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        stats.skippedFiles += 1;
        continue;
      }
      if (stats.searchedFiles >= maxFiles || matches.length >= maxMatches) {
        stats.truncated = 1;
        return;
      }
      try {
        const data = await readFile(abs);
        if (data.byteLength > maxFileBytes || data.subarray(0, Math.min(data.byteLength, 8192)).includes(0)) {
          stats.skippedFiles += 1;
          continue;
        }
        const text = data.toString("utf8");
        stats.searchedFiles += 1;
        let foundInFile = false;
        let offset = 0;
        while (offset < text.length) {
          const index = text.indexOf(query, offset);
          if (index === -1) break;
          const end = index + query.length;
          const startPreview = Math.max(0, index - Math.floor(previewBytes / 2));
          const endPreview = Math.min(text.length, end + Math.floor(previewBytes / 2));
          matches.push({
            path: rel,
            line: text.slice(0, index).split("\n").length,
            column: index - text.lastIndexOf("\n", index - 1),
            byteStart: Buffer.byteLength(text.slice(0, index)),
            byteEnd: Buffer.byteLength(text.slice(0, end)),
            preview: text.slice(startPreview, endPreview),
          });
          stats.matches = matches.length;
          foundInFile = true;
          if (matches.length >= maxMatches) {
            stats.truncated = 1;
            break;
          }
          offset = end;
        }
        if (foundInFile) stats.matchedFiles += 1;
      } catch {
        stats.skippedFiles += 1;
      }
    }
  }

  await walk(absRoot, 0);
  return { matches, stats, source: "ts" };
}

export function fsEngineAvailable(): boolean {
  return nativeSymbols() !== null;
}

export async function inspectLocalWorkspace(root = process.env.SIFT_USER_CWD || "."): Promise<InspectLocalWorkspaceResult> {
  const absRoot = resolvePath(root || ".");
  const files = await collectWorkspaceFiles(absRoot, { maxFiles: 1500, maxDepth: 8 });
  const languages = new Map<string, { files: number; bytes: number }>();
  const keyFiles: InspectLocalWorkspaceResult["keyFiles"] = [];
  const treeStats = new Map<string, { files: number; bytes: number }>();
  const symbols: WorkspaceSymbol[] = [];
  let binaryFiles = 0;

  for (const file of files.files) {
    const lang = languages.get(file.language) ?? { files: 0, bytes: 0 };
    lang.files += 1;
    lang.bytes += file.bytes;
    languages.set(file.language, lang);
    if (file.keyReason) keyFiles.push({ path: file.path, reason: file.keyReason });

    const first = file.path.split(/[\\/]/)[0] || file.path;
    const entry = treeStats.get(first) ?? { files: 0, bytes: 0 };
    entry.files += 1;
    entry.bytes += file.bytes;
    treeStats.set(first, entry);

    if (symbols.length < 80 && file.bytes <= 256 * 1024 && isLikelySource(file.path)) {
      try {
        const text = (await readFile(file.absPath)).toString("utf8");
        symbols.push(...extractSymbols(file.path, file.language, text).slice(0, 12));
      } catch {
        binaryFiles += 1;
      }
    }
  }

  return {
    root: absRoot,
    repoKind: existsSync(join(absRoot, ".git")) ? "git" : "plain",
    languages: [...languages.entries()]
      .map(([language, stats]) => ({ language, files: stats.files, bytes: stats.bytes }))
      .sort((a, b) => b.files - a.files)
      .slice(0, 12),
    keyFiles: keyFiles.slice(0, 40),
    tree: [...treeStats.entries()]
      .map(([path, stats]) => ({ path, kind: "dir" as const, files: stats.files, bytes: stats.bytes }))
      .sort((a, b) => b.files - a.files)
      .slice(0, 40),
    symbols: symbols.sort((a, b) => b.score - a.score).slice(0, 80),
    stats: {
      scannedFiles: files.files.length,
      skippedFiles: files.skippedFiles,
      binaryFiles,
      truncated: files.truncated,
    },
    source: "ts",
  };
}

export async function codeSearch(input: {
  root?: string;
  intent: string;
  queries?: string[];
  paths?: string[];
  maxFiles?: number;
  maxSpans?: number;
  contextLines?: number;
}): Promise<CodeSearchResult> {
  const root = resolvePath(input.root || process.env.SIFT_USER_CWD || ".");
  const maxSpans = input.maxSpans ?? 12;
  const contextLines = input.contextLines ?? 2;
  const queries = compileQueries(input.intent, input.queries).slice(0, 8);
  const files = await collectWorkspaceFiles(root, { maxFiles: input.maxFiles ?? 2000, maxDepth: 10 });
  const fileScores = new Map<string, { score: number; reasons: Set<string>; symbols: Set<string> }>();
  const spans: CodeSearchResult["spans"] = [];
  let searchedFiles = 0;
  let searchedBytes = 0;

  for (const file of files.files) {
    const bucket = fileScores.get(file.path) ?? { score: 0, reasons: new Set<string>(), symbols: new Set<string>() };
    if (file.keyReason) {
      bucket.score += 75;
      bucket.reasons.add(file.keyReason);
    }
    for (const q of queries) {
      const ql = q.toLowerCase();
      if (file.path.toLowerCase().includes(ql)) {
        bucket.score += 250;
        bucket.reasons.add(`path:${q}`);
      }
    }
    fileScores.set(file.path, bucket);
  }

  for (const query of queries) {
    const result = await searchLiteral(root, query, {
      maxMatches: Math.max(maxSpans * 3, 24),
      maxFiles: input.maxFiles ?? 2000,
      previewBytes: 320,
    });
    searchedFiles = Math.max(searchedFiles, result.stats.searchedFiles);
    for (const match of result.matches) {
      const bucket = fileScores.get(match.path) ?? { score: 0, reasons: new Set<string>(), symbols: new Set<string>() };
      bucket.score += exactBoost(input.intent, query);
      bucket.reasons.add(`literal:${query}`);
      fileScores.set(match.path, bucket);
      searchedBytes += match.preview.length;
      spans.push({
        path: match.path,
        startLine: Math.max(1, match.line - contextLines),
        endLine: match.line + contextLines,
        preview: match.preview,
        matchedQueries: [query],
        score: bucket.score,
      });
    }
  }

  const dedupedSpans = dedupeSpans(spans)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSpans);
  const rankedFiles = [...fileScores.entries()]
    .filter(([, info]) => info.score > 0)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 12)
    .map(([path, info]) => ({ path, score: info.score, reasons: [...info.reasons], symbols: [...info.symbols] }));

  return {
    answerHint: dedupedSpans.length
      ? "Use the ranked spans first; call batch_read_files only for the files needed to answer."
      : "No literal spans matched. Use inspect_local_workspace for a repo map or try more exact identifiers.",
    files: rankedFiles,
    spans: dedupedSpans,
    followups: dedupedSpans.slice(0, 6).map((span) => ({
      tool: "batch_read_files",
      args: { path: span.path, startLine: span.startLine, endLine: span.endLine },
      reason: `Inspect ranked span matching ${span.matchedQueries.join(", ")}`,
    })),
    stats: {
      searchedFiles,
      matchedFiles: new Set(dedupedSpans.map((span) => span.path)).size,
      searchedBytes,
      truncated: files.truncated || dedupedSpans.length >= maxSpans,
    },
  };
}

/**
 * Fuzzy-ish path/name search, not content search.
 *
 * Codex's engineered file-search surface is also path search: it walks files
 * and ranks path matches for @-mentions. This small A0 version keeps the same
 * product distinction without pulling in nucleo/ignore yet.
 */
export async function findLocalFiles(input: {
  root?: string;
  query: string;
  limit?: number;
  maxFiles?: number;
}): Promise<FileSearchResult> {
  const root = resolvePath(input.root || process.env.SIFT_USER_CWD || ".");
  const query = String(input.query || "").trim();
  if (!query) return { matches: [], stats: { scannedFiles: 0, skippedFiles: 0, truncated: false }, source: "ts" };

  const files = await collectWorkspaceFiles(root, { maxFiles: input.maxFiles ?? 5000, maxDepth: 10 });
  const matches = files.files
    .map((file) => {
      const ranked = fuzzyPathScore(file.path, query);
      if (!ranked) return null;
      return {
        path: file.path,
        score: ranked.score + (file.keyReason ? 50 : 0),
        indices: ranked.indices,
        language: file.language,
        reason: file.keyReason,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, input.limit ?? 64);

  return {
    matches,
    stats: { scannedFiles: files.files.length, skippedFiles: files.skippedFiles, truncated: files.truncated },
    source: "ts",
  };
}

export async function batchReadFiles(
  files: Array<{ path: string; startLine?: number; endLine?: number; maxBytes?: number }>,
  root = process.env.SIFT_USER_CWD || ".",
): Promise<BatchReadFilesResult> {
  const absRoot = resolvePath(root || ".");
  const output: BatchReadFilesResult["files"] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const request of files.slice(0, 12)) {
    const absPath = resolvePath(absRoot, request.path);
    try {
      const maxBytes = Math.min(request.maxBytes ?? 48 * 1024, 96 * 1024);
      const read = await readText(absPath, maxBytes);
      const lines = read.content.split(/\r\n|\r|\n/);
      const startLine = Math.max(1, request.startLine ?? 1);
      const endLine = Math.min(lines.length, Math.max(startLine, request.endLine ?? lines.length));
      const content = lines.slice(startLine - 1, endLine).map((line, i) => `${startLine + i}: ${line}`).join("\n");
      totalBytes += Buffer.byteLength(content);
      if (totalBytes > 192 * 1024) {
        truncated = true;
        break;
      }
      output.push({ path: relative(absRoot, absPath), content, startLine, endLine, truncated: read.truncated, bytes: read.bytes });
    } catch (err) {
      output.push({
        path: request.path,
        content: "",
        startLine: request.startLine ?? 1,
        endLine: request.endLine ?? request.startLine ?? 1,
        truncated: false,
        bytes: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { files: output, truncated };
}

async function collectWorkspaceFiles(root: string, opts: { maxFiles: number; maxDepth: number }): Promise<{ files: WorkspaceFile[]; skippedFiles: number; truncated: boolean }> {
  const files: WorkspaceFile[] = [];
  let skippedFiles = 0;
  let truncated = false;
  const absRoot = resolvePath(root || ".");

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > opts.maxDepth || files.length >= opts.maxFiles) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      skippedFiles += 1;
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(absRoot, abs) || entry.name;
      if (entry.name.startsWith(".") || rel.split(/[\\/]/).some((part) => NOISY_DIRS.has(part))) {
        skippedFiles += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        skippedFiles += 1;
        continue;
      }
      if (!isLikelySource(rel)) {
        skippedFiles += 1;
        continue;
      }
      try {
        const data = await readFile(abs);
        if (data.byteLength > DEFAULT_MAX_FILE_BYTES || data.subarray(0, Math.min(data.byteLength, 8192)).includes(0)) {
          skippedFiles += 1;
          continue;
        }
        files.push({
          path: rel,
          absPath: abs,
          bytes: data.byteLength,
          depth,
          language: languageForPath(rel),
          keyReason: keyReasonForPath(rel),
        });
      } catch {
        skippedFiles += 1;
      }
      if (files.length >= opts.maxFiles) {
        truncated = true;
        return;
      }
    }
  }

  await walk(absRoot, 0);
  return { files, skippedFiles, truncated };
}

function isLikelySource(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path;
  return SOURCE_EXTENSIONS.has(extname(path).toLowerCase()) || /^(package|tsconfig|bunfig|Dockerfile|Makefile|README|CHANGELOG|AGENTS|CLAUDE)(\.|$)/i.test(name);
}

function languageForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".zig") return "zig";
  if (ext === ".rs") return "rust";
  if (ext === ".go") return "go";
  if (ext === ".py") return "python";
  if (ext === ".swift") return "swift";
  if (ext === ".json") return "json";
  if (ext === ".md") return "markdown";
  return ext ? ext.slice(1) : "text";
}

function keyReasonForPath(path: string): WorkspaceFile["keyReason"] | undefined {
  const lower = path.toLowerCase();
  const name = lower.split(/[\\/]/).pop() ?? lower;
  if (name === "package.json" || name === "bun.lock" || name === "pnpm-lock.yaml") return "package";
  if (name.includes("index.") || name.includes("main.") || name.includes("server.") || name.includes("app.")) return "entrypoint";
  if (name.includes("test.") || name.includes(".test.") || name.includes(".spec.")) return "test";
  if (name.includes("config") || name === "tsconfig.json" || name === "bunfig.toml") return "config";
  if (name.startsWith("readme") || name.startsWith("agents") || name.startsWith("claude")) return "readme";
  if (lower.includes("/native/") || name.endsWith(".zig")) return "native";
  if (name.includes("build") || name === "makefile" || name === "dockerfile") return "build";
  return undefined;
}

function extractSymbols(path: string, language: string, text: string): WorkspaceSymbol[] {
  const out: WorkspaceSymbol[] = [];
  const patterns: Array<{ kind: WorkspaceSymbol["kind"]; re: RegExp }> = [
    { kind: "function", re: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g },
    { kind: "class", re: /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g },
    { kind: "interface", re: /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g },
    { kind: "type", re: /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/g },
    { kind: "export", re: /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g },
    { kind: "function", re: /export\s+fn\s+([A-Za-z_][\w]*)/g },
    { kind: "function", re: /fn\s+([A-Za-z_][\w]*)/g },
  ];
  for (const { kind, re } of patterns) {
    for (const match of text.matchAll(re)) {
      const symbol = match[1];
      const line = text.slice(0, match.index ?? 0).split("\n").length;
      out.push({ path, language, symbol, kind, line, score: kind === "export" ? 700 : 500, signature: match[0] });
      if (out.length >= 30) return out;
    }
  }
  return out;
}

function compileQueries(intent: string, explicit: string[] = []): string[] {
  const queries = new Set<string>();
  for (const q of explicit) if (q.trim()) queries.add(q.trim());
  for (const quoted of intent.matchAll(/["'`](.+?)["'`]/g)) queries.add(quoted[1]);
  for (const token of intent.match(/[A-Za-z_][A-Za-z0-9_$:-]{2,}/g) ?? []) {
    if (STOP_WORDS.has(token.toLowerCase())) continue;
    queries.add(token);
  }
  return [...queries].slice(0, 10);
}

const STOP_WORDS = new Set(["this", "that", "with", "from", "codebase", "scour", "search", "find", "where", "what", "how", "why", "the", "and", "for", "about", "local", "files"]);

function exactBoost(intent: string, query: string): number {
  return intent.includes(query) ? 500 : 300;
}

function dedupeSpans(spans: CodeSearchResult["spans"]): CodeSearchResult["spans"] {
  const seen = new Map<string, CodeSearchResult["spans"][number]>();
  for (const span of spans) {
    const key = `${span.path}:${span.startLine}:${span.endLine}`;
    const current = seen.get(key);
    if (current) {
      current.matchedQueries = [...new Set([...current.matchedQueries, ...span.matchedQueries])];
      current.score = Math.max(current.score, span.score);
    } else {
      seen.set(key, { ...span });
    }
  }
  return [...seen.values()];
}

function fuzzyPathScore(path: string, query: string): { score: number; indices: number[] } | null {
  const hay = path.toLowerCase();
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return null;

  const exact = hay.indexOf(needle);
  if (exact >= 0) {
    const indices = Array.from({ length: needle.length }, (_, i) => exact + i);
    const basenameBoost = hay.split(/[\\/]/).pop()?.includes(needle) ? 250 : 0;
    return { score: 1000 + basenameBoost - exact, indices };
  }

  let h = 0;
  const indices: number[] = [];
  let score = 0;
  for (let n = 0; n < needle.length; n += 1) {
    const c = needle[n];
    let found = -1;
    while (h < hay.length) {
      if (hay[h] === c) {
        found = h;
        break;
      }
      h += 1;
    }
    if (found === -1) return null;
    indices.push(found);
    const prev = found > 0 ? hay[found - 1] : "/";
    score += prev === "/" || prev === "-" || prev === "_" || prev === "." ? 90 : 25;
    if (indices.length > 1 && found === indices[indices.length - 2] + 1) score += 40;
    h = found + 1;
  }
  return { score: score - path.length, indices };
}

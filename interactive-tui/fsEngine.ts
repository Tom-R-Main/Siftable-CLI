/**
 * Native local filesystem engine.
 *
 * Zig owns the byte-heavy path under Bun (`native/fs_engine.zig`); TypeScript
 * keeps a same-policy fallback for tests and degraded local dev. The FFI
 * contract is intentionally boring: caller-owned output buffers, ptr+u32
 * strings, status codes, and compact JSON result frames.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile, rename, mkdir, stat, chmod, unlink, realpath } from "node:fs/promises";
import { extname, join, dirname, resolve as resolvePath, relative, isAbsolute, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { getSessionCwd, getWorkspaceRoot } from "./navigation";

export interface ReadTextResult {
  path: string;
  content: string;
  truncated: boolean;
  bytes: number;
  source: "zig" | "ts";
}

export interface WriteTextResult {
  path: string;
  bytesWritten: number;
  created: boolean;
  source: "zig" | "ts";
}

export interface EditTextResult {
  path: string;
  bytesWritten: number;
  replacements: number;
  /** FNV-1a 32 of the new content — caller can use it as the next freshness token. */
  newHash: number;
  source: "zig" | "ts";
}

export interface WriteTextOptions {
  /** Writable root the target must sit within. Empty/undefined disables the jail. */
  root?: string;
  /** Fail with "already exists" instead of overwriting. */
  createOnly?: boolean;
  /** Create missing parent directories. */
  makePath?: boolean;
}

export interface EditTextOptions {
  root?: string;
  /** Reject the edit if `oldString` matches more than once (default true). */
  requireUnique?: boolean;
  /** FNV-1a 32 of the content the caller last read; mismatch → stale, edit refused. */
  expectedHash?: number;
}

export interface SearchCaps {
  maxFiles?: number;
  maxMatches?: number;
  maxDepth?: number;
  maxFileBytes?: number;
  previewBytes?: number;
  includeHidden?: boolean;
  includeVendor?: boolean;
  includeBuildOutputs?: boolean;
  respectGitignore?: boolean;
  /** Force the TypeScript traversal so sensitive-file exclusions are guaranteed. */
  excludeSensitive?: boolean;
  detail?: SearchDetail;
}

export type SearchDetail = "paths" | "locations" | "snippets" | "full";

export interface RepositoryScanCaps extends SearchCaps {
  sourceOnly?: boolean;
}

export interface RepositoryScanManifest {
  files: Array<{
    path: string;
    bytes: number;
    depth: number;
  }>;
  stats: {
    scannedFiles: number;
    skippedFiles: number;
    truncated: number;
    capped: boolean;
    capReason: "maxFiles" | "maxDepth" | null;
    bytesScanned: number;
    skippedByReason: SearchSkippedByReason;
  };
  source: "zig" | "ts";
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  byteStart: number;
  byteEnd: number;
  preview: string;
}

export interface SearchSkippedByReason {
  hidden: number;
  vendor: number;
  buildOutput: number;
  binary: number;
  tooLarge: number;
  invalidUtf8: number;
  ioError: number;
  gitignore: number;
  depth: number;
  nonFile: number;
  other: number;
}

export interface SearchResult {
  matches: SearchMatch[];
  stats: {
    searchedFiles: number;
    skippedFiles: number;
    matchedFiles: number;
    matches: number;
    truncated: number;
    capped: boolean;
    capReason: SearchCapReason | null;
    bytesScanned: number;
    skippedByReason: SearchSkippedByReason;
    phaseTimings?: SearchPhaseTimings;
  };
  source: "zig" | "ts";
}

export type SearchCapReason = "maxMatches" | "maxFiles" | "maxBytes" | "maxDepth";

export interface SearchPhaseTimings {
  searchReadWallMs: number;
  searchScanWallMs: number;
}

export interface WorkspaceFile {
  path: string;
  absPath: string;
  bytes: number;
  mtimeMs: number;
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
    cacheHit?: boolean;
    fileSetId?: string;
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
  stats: {
    searchedFiles: number;
    matchedFiles: number;
    searchedBytes: number;
    truncated: boolean;
    cacheHit?: boolean;
    fileSetId?: string;
    eligibleFiles?: number;
    phaseTimings?: CodeSearchPhaseTimings;
    contentCache?: CodeSearchContentCacheStats;
    excludedSensitiveFiles?: number;
  };
}

export interface CodeSearchPhaseTimings {
  totalWallMs: number;
  cacheLookupWallMs: number;
  /** Full eligible-file collection phase. On cache hits this is zero. */
  fileSetBuildWallMs: number;
  /** Directory enumeration during file-set collection; a subcomponent of fileSetBuildWallMs. */
  fileSetStatWallMs: number;
  /** File reads during file-set collection; a subcomponent of fileSetBuildWallMs. */
  fileSetReadWallMs: number;
  /** Wall time spent inside content search across all compiled queries. */
  searchWallMs: number;
  /** File reads during content search; a subcomponent of searchWallMs. */
  searchReadWallMs: number;
  /** UTF-8 decode plus literal scan time for content search. */
  searchScanWallMs: number;
  shapeWallMs: number;
  previewWallMs: number;
}

export interface CodeSearchContentCacheStats {
  enabled: boolean;
  hitFiles: number;
  missFiles: number;
  hitBytes: number;
  missBytes: number;
  storedBytes: number;
  currentBytes: number;
  evictions: number;
  skippedTooLarge: number;
}

const SENSITIVE_DISCOVERY_FILE_RE =
  /(^|\/)(?:(?:secrets?|credentials?|private[-_]?keys?)(?:\/|$)|\.env(?:\.|$)|\.npmrc$|\.pypirc$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$|[^/]+\.(?:pem|key|p12|pfx|keystore|crt|cer|der)$|(?:credentials|service[-_]?account|secrets?)\.(?:json|ya?ml|toml)$)/i;

export function isSensitiveDiscoveryPath(path: string): boolean {
  return SENSITIVE_DISCOVERY_FILE_RE.test(toSlash(path));
}

export async function assertAuthorizedDiscoveryRoot(root: string, authorizedRoot: string): Promise<void> {
  const [canonicalRoot, canonicalAuthorizedRoot] = await Promise.all([
    realpath(root),
    realpath(authorizedRoot),
  ]);
  const rel = relative(canonicalAuthorizedRoot, canonicalRoot);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`code_search root escapes the authorized workspace: ${root}`);
  }
}

export interface FileSearchResult {
  matches: Array<{
    path: string;
    score: number;
    indices: number[];
    language: string;
    reason?: WorkspaceFile["keyReason"];
  }>;
  stats: { scannedFiles: number; skippedFiles: number; truncated: boolean; cacheHit?: boolean; fileSetId?: string };
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
const WRITE_FLAG_CREATE_ONLY = 0x1;
const WRITE_FLAG_MAKE_PATH = 0x2;
const EDIT_FLAG_REQUIRE_UNIQUE = 0x1;
const EDIT_FLAG_CHECK_FRESHNESS = 0x2;
const SEARCH_FLAG_INCLUDE_HIDDEN = 0x1;
const SEARCH_FLAG_INCLUDE_VENDOR = 0x8;
const SEARCH_FLAG_INCLUDE_BUILD_OUTPUTS = 0x10;
const SEARCH_FLAG_IGNORE_GITIGNORE = 0x20;
const SCAN_FLAG_SOURCE_ONLY = 0x2;
const SEARCH_DETAIL_SHIFT = 24;
const SEARCH_DETAIL_PATHS = 1 << SEARCH_DETAIL_SHIFT;
const SEARCH_DETAIL_LOCATIONS = 2 << SEARCH_DETAIL_SHIFT;
const SEARCH_DETAIL_FULL = 3 << SEARCH_DETAIL_SHIFT;
const DEFAULT_READ_BYTES = 64 * 1024;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_MATCHES = 100;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_PREVIEW_BYTES = 240;
const WORKSPACE_FILE_CACHE_TTL_MS = 30_000;
const WORKSPACE_CONTENT_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_CONTENT_CACHE_BYTES = 64 * 1024 * 1024;
const VENDOR_DIRS = new Set([
  "node_modules",
  "vendor",
]);
const BUILD_OUTPUT_DIRS = new Set([
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "tmp",
  "target",
  "zig-cache",
  ".zig-cache",
  "zig-out",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".zig", ".rs", ".go", ".py", ".swift", ".java", ".kt", ".rb", ".php", ".css", ".scss", ".html", ".json", ".md", ".toml", ".yaml", ".yml"]);

type WorkspaceFileCollection = {
  files: WorkspaceFile[];
  skippedFiles: number;
  sensitiveExcludedFiles: number;
  truncated: boolean;
  cacheHit: boolean;
  fileSetId: string;
  phaseTimings: WorkspaceFilePhaseTimings;
};

type WorkspaceFileCacheEntry = {
  createdAt: number;
  result: WorkspaceFileCollection;
};

type WorkspaceFilePhaseTimings = {
  cacheLookupWallMs: number;
  fileSetBuildWallMs: number;
  fileSetStatWallMs: number;
  fileSetReadWallMs: number;
};

type TraversalFile = {
  path: string;
  absPath: string;
  bytes: number;
  mtimeMs: number;
  depth: number;
};

type TraversalPolicy = {
  maxFiles: number;
  maxDepth: number;
  maxFileBytes: number;
  caps: SearchCaps;
  sourceOnly: boolean;
  respectGitignore: boolean;
};

type TraversalResult = {
  files: TraversalFile[];
  skippedFiles: number;
  sensitiveExcludedFiles: number;
  skippedByReason: SearchSkippedByReason;
  truncated: boolean;
  capReason: SearchCapReason | null;
  fileSetStatWallMs: number;
};

type GitignoreRule = {
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
  hasSlash: boolean;
  baseRel: string;
};

const workspaceFileCache = new Map<string, WorkspaceFileCacheEntry>();

type WorkspaceContentCacheEntry = {
  absPath: string;
  text: string;
  bytes: number;
  mtimeMs: number;
  createdAt: number;
  lastUsedAt: number;
};

const workspaceContentCache = new Map<string, WorkspaceContentCacheEntry>();
let workspaceContentCacheBytes = 0;

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
  sift_repo_scan_manifest: (
    root: Uint8Array,
    rootLen: number,
    caps: Uint32Array,
    out: Uint8Array,
    outCap: number,
    written: Uint32Array,
    needed: Uint32Array,
    stats: Uint32Array,
  ) => number;
  sift_fs_write_text: (
    root: Uint8Array,
    rootLen: number,
    path: Uint8Array,
    pathLen: number,
    content: Uint8Array,
    contentLen: number,
    flags: number,
    out: Uint8Array,
    outCap: number,
    written: Uint32Array,
    needed: Uint32Array,
  ) => number;
  sift_fs_edit_text: (
    root: Uint8Array,
    rootLen: number,
    path: Uint8Array,
    pathLen: number,
    oldStr: Uint8Array,
    newStr: Uint8Array,
    params: Uint32Array,
    out: Uint8Array,
    outCap: number,
    written: Uint32Array,
    needed: Uint32Array,
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
    sift_repo_scan_manifest: {
      args: [
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
    sift_fs_write_text: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.u32,
    },
    sift_fs_edit_text: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.u32,
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
      if (status === STATUS_OK) {
        return { ...JSON.parse(readJsonFromOut(out, written)), source: "zig" };
      }
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
  if (symbols && !caps.excludeSensitive) {
    const rootBytes = encoder.encode(root);
    const queryBytes = encoder.encode(query);
    const capWords = new Uint32Array([
      caps.maxFiles ?? DEFAULT_MAX_FILES,
      caps.maxMatches ?? DEFAULT_MAX_MATCHES,
      caps.maxDepth ?? DEFAULT_MAX_DEPTH,
      caps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      caps.previewBytes ?? DEFAULT_PREVIEW_BYTES,
      searchFlags(caps),
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

export async function scanRepositoryManifest(root: string, caps: RepositoryScanCaps = {}): Promise<RepositoryScanManifest> {
  const symbols = nativeSymbols();
  if (symbols) {
    const rootBytes = encoder.encode(root);
    const capWords = new Uint32Array([
      caps.maxFiles ?? DEFAULT_MAX_FILES,
      caps.maxDepth ?? DEFAULT_MAX_DEPTH,
      caps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      searchFlags(caps) | (caps.sourceOnly === false ? 0 : SCAN_FLAG_SOURCE_ONLY),
    ]);

    let cap = 256 * 1024;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const out = new Uint8Array(cap);
      const written = new Uint32Array(1);
      const needed = new Uint32Array(1);
      const stats = new Uint32Array(8);
      const status = symbols.sift_repo_scan_manifest(
        rootBytes,
        rootBytes.byteLength,
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
      throw new Error(nativeStatusMessage(status, "scan_repository"));
    }
  }
  return scanRepositoryManifestFallback(root, caps);
}

function searchFlags(caps: SearchCaps): number {
  return (caps.includeHidden ? SEARCH_FLAG_INCLUDE_HIDDEN : 0) |
    (caps.includeVendor ? SEARCH_FLAG_INCLUDE_VENDOR : 0) |
    (caps.includeBuildOutputs ? SEARCH_FLAG_INCLUDE_BUILD_OUTPUTS : 0) |
    (caps.respectGitignore === false ? SEARCH_FLAG_IGNORE_GITIGNORE : 0) |
    detailFlag(caps.detail);
}

function detailFlag(detail: SearchDetail | undefined): number {
  if (detail === "paths") return SEARCH_DETAIL_PATHS;
  if (detail === "locations") return SEARCH_DETAIL_LOCATIONS;
  if (detail === "full") return SEARCH_DETAIL_FULL;
  return 0;
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
    status === 10 ? "file already exists" :
    status === 11 ? "no match for the text to replace" :
    status === 12 ? "ambiguous edit: the text to replace appears more than once" :
    status === 13 ? "I/O error" :
    status === 14 ? "stale: the file changed since it was read" :
    status === 15 ? "path is outside the writable root" :
    `native status ${status}`;
  return `${op}: ${label}`;
}

// FNV-1a 32, mirrored from native/fs_engine.zig (hashes UTF-8 bytes so the
// native and fallback paths agree on freshness tokens).
export function contentHash(text: string): number {
  const bytes = encoder.encode(text);
  let h = 2166136261 >>> 0;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function clearWorkspaceFileCache(root?: string): void {
  if (!root) {
    workspaceFileCache.clear();
    workspaceContentCache.clear();
    workspaceContentCacheBytes = 0;
    return;
  }
  const absRoot = resolvePath(root || ".");
  for (const key of workspaceFileCache.keys()) {
    if (key.startsWith(`${absRoot}|`)) workspaceFileCache.delete(key);
  }
  for (const [key, entry] of workspaceContentCache.entries()) {
    if (entry.absPath.startsWith(`${absRoot}/`) || entry.absPath === absRoot) {
      workspaceContentCache.delete(key);
      workspaceContentCacheBytes -= entry.bytes;
    }
  }
  workspaceContentCacheBytes = Math.max(0, workspaceContentCacheBytes);
}

function evictWorkspaceContentCache(maxBytes: number): number {
  if (workspaceContentCacheBytes <= maxBytes) return 0;
  let evictions = 0;
  const entries = [...workspaceContentCache.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  for (const [key, entry] of entries) {
    if (workspaceContentCacheBytes <= maxBytes) break;
    workspaceContentCache.delete(key);
    workspaceContentCacheBytes -= entry.bytes;
    evictions += 1;
  }
  workspaceContentCacheBytes = Math.max(0, workspaceContentCacheBytes);
  return evictions;
}

function rememberWorkspaceContent(file: WorkspaceFile, text: string, bytes: number, mtimeMs: number, maxBytes: number): { storedBytes: number; evictions: number; skippedTooLarge: number } {
  if (bytes > maxBytes) return { storedBytes: 0, evictions: 0, skippedTooLarge: 1 };
  const now = Date.now();
  const previous = workspaceContentCache.get(file.absPath);
  if (previous) workspaceContentCacheBytes -= previous.bytes;
  workspaceContentCache.set(file.absPath, {
    absPath: file.absPath,
    text,
    bytes,
    mtimeMs,
    createdAt: now,
    lastUsedAt: now,
  });
  workspaceContentCacheBytes += bytes;
  const evictions = evictWorkspaceContentCache(maxBytes);
  return { storedBytes: bytes, evictions, skippedTooLarge: 0 };
}

function countOccurrencesTs(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = 0;
  for (;;) {
    const found = haystack.indexOf(needle, i);
    if (found === -1) break;
    count += 1;
    i = found + needle.length;
  }
  return count;
}

type LineCursor = {
  offset: number;
  byteOffset: number;
  line: number;
  lineStartByte: number;
};

function utf8WidthAt(text: string, offset: number): number {
  const codePoint = text.codePointAt(offset);
  if (codePoint == null) return 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function advanceLineCursor(text: string, cursor: LineCursor, targetOffset: number): void {
  while (cursor.offset < targetOffset) {
    const codePoint = text.codePointAt(cursor.offset);
    if (codePoint == null) break;
    const width = utf8WidthAt(text, cursor.offset);
    if (text.charCodeAt(cursor.offset) === 0x0a) {
      cursor.line += 1;
      cursor.lineStartByte = cursor.byteOffset + 1;
    }
    cursor.byteOffset += width;
    cursor.offset += codePoint > 0xffff ? 2 : 1;
  }
}

function columnForCursor(cursor: LineCursor): number {
  return cursor.byteOffset - cursor.lineStartByte + 1;
}

function pathHasDotDot(p: string): boolean {
  return p.split(/[\\/]/).some((part) => part === "..");
}

function withinRoot(root: string, p: string): boolean {
  if (!p || p.includes("\0") || pathHasDotDot(p)) return false;
  if (!root) return true;
  if (!isAbsolute(p)) return false;
  if (!p.startsWith(root)) return false;
  if (p.length === root.length) return true;
  const c = p[root.length];
  return c === "/" || c === "\\";
}

type SearchSkipReason = keyof SearchSkippedByReason;

function emptySearchSkippedByReason(): SearchSkippedByReason {
  return {
    hidden: 0,
    vendor: 0,
    buildOutput: 0,
    binary: 0,
    tooLarge: 0,
    invalidUtf8: 0,
    ioError: 0,
    gitignore: 0,
    depth: 0,
    nonFile: 0,
    other: 0,
  };
}

function searchExcludeReason(name: string, caps: SearchCaps): SearchSkipReason | null {
  if (name === ".git") return "other";
  if (!caps.includeVendor && VENDOR_DIRS.has(name)) return "vendor";
  if (!caps.includeBuildOutputs && BUILD_OUTPUT_DIRS.has(name)) return "buildOutput";
  return null;
}

function pathToSearchRel(absRoot: string, absPath: string, fallback: string): string {
  return toSlash(relative(absRoot, absPath) || fallback);
}

function toSlash(path: string): string {
  return path.split(sep).join("/");
}

async function collectTraversalFiles(root: string, policy: TraversalPolicy): Promise<TraversalResult> {
  const absRoot = resolvePath(root || ".");
  const files: TraversalFile[] = [];
  const skippedByReason = emptySearchSkippedByReason();
  const gitRoot = policy.respectGitignore ? findGitRoot(absRoot) : null;
  const ancestorRules = gitRoot ? await loadAncestorGitignoreRules(gitRoot, absRoot) : [];
  let skippedFiles = 0;
  let sensitiveExcludedFiles = 0;
  let truncated = false;
  let capReason: SearchCapReason | null = null;
  let fileSetStatWallMs = 0;
  const skip = (reason: SearchSkipReason) => {
    skippedFiles += 1;
    skippedByReason[reason] += 1;
  };
  const cap = (reason: SearchCapReason) => {
    truncated = true;
    capReason ??= reason;
  };

  async function walk(dir: string, depth: number, inheritedRules: GitignoreRule[]): Promise<void> {
    if (depth > policy.maxDepth) {
      cap("maxDepth");
      skip("depth");
      return;
    }
    if (files.length >= policy.maxFiles) {
      cap("maxFiles");
      return;
    }

    let entries;
    try {
      const statStart = performance.now();
      entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      fileSetStatWallMs += performance.now() - statStart;
    } catch {
      skip("ioError");
      return;
    }

    const relDir = toSlash(relative(absRoot, dir));
    const localRules = gitRoot ? await loadGitignoreRules(dir, relDir) : [];
    const rules = localRules.length ? inheritedRules.concat(localRules) : inheritedRules;

    for (const entry of entries) {
      if (files.length >= policy.maxFiles) {
        cap("maxFiles");
        return;
      }
      const abs = join(dir, entry.name);
      const rel = pathToSearchRel(absRoot, abs, entry.name);
      const isDir = entry.isDirectory();
      const excludedReason = isDir ? searchExcludeReason(entry.name, policy.caps) : null;
      if (excludedReason) {
        skip(excludedReason);
        continue;
      }
      if (!policy.caps.includeHidden && rel.split("/").some((part) => part.startsWith("."))) {
        skip("hidden");
        continue;
      }
      if (gitRoot && gitignoreDecision(rules, rel, isDir)) {
        skip("gitignore");
        continue;
      }
      if (isSensitiveDiscoveryPath(rel)) {
        sensitiveExcludedFiles += 1;
        skip("other");
        continue;
      }
      if (isDir) {
        await walk(abs, depth + 1, rules);
        continue;
      }
      if (!entry.isFile()) {
        skip("nonFile");
        continue;
      }
      if (policy.sourceOnly && !isLikelySource(rel)) {
        skip("other");
        continue;
      }

      try {
        const statStart = performance.now();
        const fileStat = await stat(abs);
        fileSetStatWallMs += performance.now() - statStart;
        if (fileStat.size > policy.maxFileBytes) {
          skip("tooLarge");
          continue;
        }
        files.push({
          path: rel,
          absPath: abs,
          bytes: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          depth,
        });
      } catch {
        skip("ioError");
      }
    }
  }

  await walk(absRoot, 0, ancestorRules);
  return {
    files,
    skippedFiles,
    sensitiveExcludedFiles,
    skippedByReason,
    truncated,
    capReason,
    fileSetStatWallMs,
  };
}

function findGitRoot(absRoot: string): string | null {
  let current = absRoot;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function loadAncestorGitignoreRules(gitRoot: string, absRoot: string): Promise<GitignoreRule[]> {
  const rules: GitignoreRule[] = [];
  let current = gitRoot;
  for (;;) {
    rules.push(...await loadGitignoreRules(current, toSlash(relative(absRoot, current))));
    if (current === absRoot) return rules;
    const next = join(current, relative(current, absRoot).split(/[\\/]/)[0] ?? "");
    if (!next || next === current || !absRoot.startsWith(`${next}${sep}`) && next !== absRoot) return rules;
    current = next;
  }
}

async function loadGitignoreRules(dir: string, baseRel: string): Promise<GitignoreRule[]> {
  let text: string;
  try {
    text = await readFile(join(dir, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  const normalizedBase = toSlash(baseRel).replace(/^\/+|\/+$/g, "");
  const rules: GitignoreRule[] = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1).trim();
    }
    if (!line) continue;
    line = line.replace(/^\/+/, "");
    const directoryOnly = line.endsWith("/");
    line = line.replace(/\/+$/g, "");
    if (!line) continue;
    rules.push({
      pattern: line,
      negated,
      directoryOnly,
      hasSlash: line.includes("/"),
      baseRel: normalizedBase,
    });
  }
  return rules;
}

function gitignoreDecision(rules: GitignoreRule[], relPath: string, isDir: boolean): boolean {
  let ignored = false;
  const normalized = toSlash(relPath).replace(/^\/+/, "");
  for (const rule of rules) {
    if (gitignoreRuleMatches(rule, normalized, isDir)) ignored = !rule.negated;
  }
  return ignored;
}

function gitignoreRuleMatches(rule: GitignoreRule, relPath: string, isDir: boolean): boolean {
  if (rule.directoryOnly && !isDir) return false;
  const path = rule.baseRel && relPath.startsWith(`${rule.baseRel}/`)
    ? relPath.slice(rule.baseRel.length + 1)
    : rule.baseRel
      ? ""
      : relPath;
  if (!path) return false;
  if (!rule.hasSlash) {
    return path.split("/").some((part) => globSegmentMatches(rule.pattern, part));
  }
  if (rule.pattern.endsWith("/*")) {
    const prefix = rule.pattern.slice(0, -1);
    if (!path.startsWith(prefix)) return false;
    return !path.slice(prefix.length).includes("/");
  }
  return globPathMatches(rule.pattern, path);
}

function globSegmentMatches(pattern: string, value: string): boolean {
  return globPathMatches(pattern, value) || value === pattern;
}

function globPathMatches(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return value === pattern;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function isLikelyBinaryBuffer(data: Buffer): boolean {
  return data.subarray(0, Math.min(data.byteLength, 8192)).includes(0);
}

function isValidUtf8(data: Buffer): boolean {
  try {
    new TextDecoder("utf-8", {fatal: true}).decode(data);
    return true;
  } catch {
    return false;
  }
}

/** Temp-file + rename, preserving the existing mode. Mirrors the Zig atomic write. */
async function atomicWriteTs(path: string, content: string, makePath: boolean): Promise<void> {
  if (makePath) await mkdir(dirname(path), { recursive: true });
  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode;
  } catch {
    mode = undefined;
  }
  const tmp = `${path}.sift-tmp-${process.pid}`;
  try {
    await writeFile(tmp, content, "utf8");
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function writeText(path: string, content: string, opts: WriteTextOptions = {}): Promise<WriteTextResult> {
  const root = opts.root ?? "";
  const symbols = nativeSymbols();
  if (symbols) {
    const rootBytes = encoder.encode(root);
    const pathBytes = encoder.encode(path);
    const contentBytes = encoder.encode(content);
    const flags = (opts.createOnly ? WRITE_FLAG_CREATE_ONLY : 0) | (opts.makePath ? WRITE_FLAG_MAKE_PATH : 0);
    let cap = 4096;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const out = new Uint8Array(cap);
      const written = new Uint32Array(1);
      const needed = new Uint32Array(1);
      const status = symbols.sift_fs_write_text(
        rootBytes,
        rootBytes.byteLength,
        pathBytes,
        pathBytes.byteLength,
        contentBytes,
        contentBytes.byteLength,
        flags,
        out,
        out.byteLength,
        written,
        needed,
      );
      if (status === STATUS_OK) {
        clearWorkspaceFileCache();
        return { ...JSON.parse(readJsonFromOut(out, written)), source: "zig" };
      }
      if (status === STATUS_OUTPUT_TOO_SMALL) {
        cap = grow(cap, needed);
        continue;
      }
      throw new Error(nativeStatusMessage(status, "write_file"));
    }
  }
  return writeTextFallback(path, content, opts);
}

export async function editText(
  path: string,
  oldString: string,
  newString: string,
  opts: EditTextOptions = {},
): Promise<EditTextResult> {
  const root = opts.root ?? "";
  const requireUnique = opts.requireUnique ?? true;
  const checkFreshness = opts.expectedHash != null;
  const symbols = nativeSymbols();
  if (symbols) {
    const rootBytes = encoder.encode(root);
    const pathBytes = encoder.encode(path);
    const oldBytes = encoder.encode(oldString);
    const newBytes = encoder.encode(newString);
    const flags = (requireUnique ? EDIT_FLAG_REQUIRE_UNIQUE : 0) | (checkFreshness ? EDIT_FLAG_CHECK_FRESHNESS : 0);
    const params = new Uint32Array([oldBytes.byteLength, newBytes.byteLength, (opts.expectedHash ?? 0) >>> 0, flags]);
    let cap = 4096;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const out = new Uint8Array(cap);
      const written = new Uint32Array(1);
      const needed = new Uint32Array(1);
      const status = symbols.sift_fs_edit_text(
        rootBytes,
        rootBytes.byteLength,
        pathBytes,
        pathBytes.byteLength,
        oldBytes,
        newBytes,
        params,
        out,
        out.byteLength,
        written,
        needed,
      );
      if (status === STATUS_OK) {
        clearWorkspaceFileCache();
        return { ...JSON.parse(readJsonFromOut(out, written)), source: "zig" };
      }
      if (status === STATUS_OUTPUT_TOO_SMALL) {
        cap = grow(cap, needed);
        continue;
      }
      throw new Error(nativeStatusMessage(status, "edit_file"));
    }
  }
  return editTextFallback(path, oldString, newString, opts);
}

async function writeTextFallback(path: string, content: string, opts: WriteTextOptions): Promise<WriteTextResult> {
  const root = opts.root ?? "";
  if (!withinRoot(root, path)) throw new Error("write_file: path is outside the writable root");
  const created = !existsSync(path);
  if (opts.createOnly && !created) throw new Error("write_file: file already exists");
  await atomicWriteTs(path, content, Boolean(opts.makePath));
  clearWorkspaceFileCache();
  return { path, bytesWritten: Buffer.byteLength(content), created, source: "ts" };
}

async function editTextFallback(
  path: string,
  oldString: string,
  newString: string,
  opts: EditTextOptions,
): Promise<EditTextResult> {
  const root = opts.root ?? "";
  if (!oldString) throw new Error("edit_file: the text to replace must not be empty");
  if (!withinRoot(root, path)) throw new Error("edit_file: path is outside the writable root");
  const data = (await readFile(path)).toString("utf8");
  if (opts.expectedHash != null && contentHash(data) !== (opts.expectedHash >>> 0)) {
    throw new Error("edit_file: stale: the file changed since it was read");
  }
  const occ = countOccurrencesTs(data, oldString);
  if (occ === 0) throw new Error("edit_file: no match for the text to replace");
  if ((opts.requireUnique ?? true) && occ > 1) {
    throw new Error("edit_file: ambiguous edit: the text to replace appears more than once");
  }
  const next = data.split(oldString).join(newString);
  await atomicWriteTs(path, next, false);
  clearWorkspaceFileCache();
  return { path, bytesWritten: Buffer.byteLength(next), replacements: occ, newHash: contentHash(next), source: "ts" };
}

async function readTextFallback(path: string, maxBytes: number): Promise<ReadTextResult> {
  const data = await readFile(path);
  if (isLikelyBinaryBuffer(data)) throw new Error("read_file: binary file skipped");
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
  const detail = caps.detail ?? "snippets";
  const queryBytes = Buffer.byteLength(query);
  const matches: SearchMatch[] = [];
  const traversal = await collectTraversalFiles(absRoot, {
    maxFiles,
    maxDepth,
    maxFileBytes,
    caps,
    sourceOnly: false,
    respectGitignore: caps.respectGitignore !== false,
  });
  const stats: SearchResult["stats"] = {
    searchedFiles: 0,
    skippedFiles: traversal.skippedFiles,
    matchedFiles: 0,
    matches: 0,
    truncated: traversal.truncated ? 1 : 0,
    capped: traversal.truncated,
    capReason: traversal.capReason,
    bytesScanned: 0,
    skippedByReason: traversal.skippedByReason,
  };
  const skip = (reason: SearchSkipReason) => {
    stats.skippedFiles += 1;
    stats.skippedByReason[reason] += 1;
  };
  const cap = (reason: SearchCapReason) => {
    stats.truncated = 1;
    stats.capped = true;
    stats.capReason ??= reason;
  };

  for (const file of traversal.files) {
    if (stats.searchedFiles >= maxFiles || matches.length >= maxMatches) {
      cap(stats.searchedFiles >= maxFiles ? "maxFiles" : "maxMatches");
      break;
    }
    try {
      const data = await readFile(file.absPath);
      if (isLikelyBinaryBuffer(data)) {
        skip("binary");
        continue;
      }
      if (!isValidUtf8(data)) {
        skip("invalidUtf8");
        continue;
      }
      const text = data.toString("utf8");
      stats.searchedFiles += 1;
      if (stats.searchedFiles >= maxFiles) cap("maxFiles");
      stats.bytesScanned += data.byteLength;
      let foundInFile = false;
      let offset = 0;
      const cursor: LineCursor = {offset: 0, byteOffset: 0, line: 1, lineStartByte: 0};
      while (offset < text.length) {
        const index = text.indexOf(query, offset);
        if (index === -1) break;
        const end = index + query.length;
        let line = 0;
        let column = 0;
        let byteStart = 0;
        let byteEnd = 0;
        let preview = "";
        if (detail !== "paths") {
          advanceLineCursor(text, cursor, index);
          byteStart = cursor.byteOffset;
          byteEnd = byteStart + queryBytes;
          line = cursor.line;
          column = columnForCursor(cursor);
          if (detail === "snippets" || detail === "full") {
            const startPreview = Math.max(0, index - Math.floor(previewBytes / 2));
            const endPreview = Math.min(text.length, end + Math.floor(previewBytes / 2));
            preview = text.slice(startPreview, endPreview);
          }
        }
        matches.push({
          path: file.path,
          line,
          column,
          byteStart,
          byteEnd,
          preview,
        });
        stats.matches = matches.length;
        foundInFile = true;
        if (matches.length >= maxMatches) {
          cap("maxMatches");
          break;
        }
        if (detail === "paths") break;
        offset = end;
      }
      if (foundInFile) stats.matchedFiles += 1;
    } catch {
      skip("ioError");
    }
  }
  return { matches, stats, source: "ts" };
}

async function scanRepositoryManifestFallback(root: string, caps: RepositoryScanCaps): Promise<RepositoryScanManifest> {
  const absRoot = resolvePath(root || ".");
  const traversal = await collectTraversalFiles(absRoot, {
    maxFiles: caps.maxFiles ?? DEFAULT_MAX_FILES,
    maxDepth: caps.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxFileBytes: caps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    caps,
    sourceOnly: caps.sourceOnly !== false,
    respectGitignore: caps.respectGitignore !== false,
  });
  const skippedByReason = {...traversal.skippedByReason};
  let skippedFiles = traversal.skippedFiles;
  let bytesScanned = 0;
  const files: RepositoryScanManifest["files"] = [];

  for (const file of traversal.files) {
    try {
      const data = await readFile(file.absPath);
      if (isLikelyBinaryBuffer(data)) {
        skippedFiles += 1;
        skippedByReason.binary += 1;
        continue;
      }
      if (!isValidUtf8(data)) {
        skippedFiles += 1;
        skippedByReason.invalidUtf8 += 1;
        continue;
      }
      bytesScanned += data.byteLength;
      files.push({
        path: file.path,
        bytes: data.byteLength,
        depth: file.depth,
      });
    } catch {
      skippedFiles += 1;
      skippedByReason.ioError += 1;
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    files,
    stats: {
      scannedFiles: files.length,
      skippedFiles,
      truncated: traversal.truncated ? 1 : 0,
      capped: traversal.truncated,
      capReason: traversal.capReason === "maxMatches" || traversal.capReason === "maxBytes"
        ? null
        : traversal.capReason,
      bytesScanned,
      skippedByReason,
    },
    source: "ts",
  };
}

export function fsEngineAvailable(): boolean {
  return nativeSymbols() !== null;
}

export async function inspectLocalWorkspace(root = getWorkspaceRoot() || getSessionCwd()): Promise<InspectLocalWorkspaceResult> {
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
      cacheHit: files.cacheHit,
      fileSetId: files.fileSetId,
    },
    source: "ts",
  };
}

async function searchWorkspaceFiles(
  root: string,
  files: WorkspaceFile[],
  query: string,
  caps: SearchCaps & {
    useContentCache?: boolean;
    maxContentCacheBytes?: number;
    contentCacheStats?: CodeSearchContentCacheStats;
  },
): Promise<SearchResult> {
  const absRoot = resolvePath(root || ".");
  const maxFiles = caps.maxFiles ?? DEFAULT_MAX_FILES;
  const maxMatches = caps.maxMatches ?? DEFAULT_MAX_MATCHES;
  const detail = caps.detail ?? "snippets";
  const previewBytes = caps.previewBytes ?? DEFAULT_PREVIEW_BYTES;
  const queryBytes = Buffer.byteLength(query);
  const matches: SearchMatch[] = [];
  let searchReadWallMs = 0;
  let searchScanWallMs = 0;
  const stats: SearchResult["stats"] = {
    searchedFiles: 0,
    skippedFiles: 0,
    matchedFiles: 0,
    matches: 0,
    truncated: 0,
    capped: false,
    capReason: null as SearchCapReason | null,
    bytesScanned: 0,
    skippedByReason: emptySearchSkippedByReason(),
  };
  const cap = (reason: SearchCapReason) => {
    stats.truncated = 1;
    stats.capped = true;
    stats.capReason ??= reason;
  };

  for (const file of files.slice(0, maxFiles)) {
    if (matches.length >= maxMatches) {
      cap("maxMatches");
      break;
    }
    try {
      const readStart = performance.now();
      const data = await readWorkspaceFileForSearch(file, caps);
      searchReadWallMs += performance.now() - readStart;
      stats.searchedFiles += 1;
      stats.bytesScanned += data.bytes;
      const scanStart = performance.now();
      const text = data.text;
      let foundInFile = false;
      let offset = 0;
      const cursor: LineCursor = {offset: 0, byteOffset: 0, line: 1, lineStartByte: 0};
      while (offset < text.length) {
        const index = text.indexOf(query, offset);
        if (index === -1) break;
        const end = index + query.length;
        let line = 0;
        let column = 0;
        let byteStart = 0;
        let byteEnd = 0;
        let preview = "";
        if (detail !== "paths") {
          advanceLineCursor(text, cursor, index);
          byteStart = cursor.byteOffset;
          byteEnd = byteStart + queryBytes;
          line = cursor.line;
          column = columnForCursor(cursor);
          if (detail === "snippets" || detail === "full") {
            const startPreview = Math.max(0, index - Math.floor(previewBytes / 2));
            const endPreview = Math.min(text.length, end + Math.floor(previewBytes / 2));
            preview = text.slice(startPreview, endPreview);
          }
        }
        matches.push({
          path: relative(absRoot, file.absPath) || file.path,
          line,
          column,
          byteStart,
          byteEnd,
          preview,
        });
        stats.matches = matches.length;
        foundInFile = true;
        if (matches.length >= maxMatches) {
          cap("maxMatches");
          break;
        }
        if (detail === "paths") break;
        offset = end;
      }
      searchScanWallMs += performance.now() - scanStart;
      if (foundInFile) stats.matchedFiles += 1;
    } catch {
      stats.skippedFiles += 1;
      stats.skippedByReason.ioError += 1;
    }
  }
  if (files.length > maxFiles) cap("maxFiles");
  stats.phaseTimings = {
    searchReadWallMs,
    searchScanWallMs,
  };
  return { matches, stats, source: "ts" };
}

async function readWorkspaceFileForSearch(
  file: WorkspaceFile,
  opts: {
    useContentCache?: boolean;
    maxContentCacheBytes?: number;
    contentCacheStats?: CodeSearchContentCacheStats;
  },
): Promise<{ text: string; bytes: number }> {
  if (!opts.useContentCache) {
    const data = await readFile(file.absPath);
    return { text: data.toString("utf8"), bytes: data.byteLength };
  }

  const maxBytes = Math.max(0, opts.maxContentCacheBytes ?? DEFAULT_MAX_CONTENT_CACHE_BYTES);
  const contentCacheStats = opts.contentCacheStats ?? {
    enabled: true,
    hitFiles: 0,
    missFiles: 0,
    hitBytes: 0,
    missBytes: 0,
    storedBytes: 0,
    currentBytes: workspaceContentCacheBytes,
    evictions: 0,
    skippedTooLarge: 0,
  };
  const fileStat = await stat(file.absPath);
  const now = Date.now();
  const cached = workspaceContentCache.get(file.absPath);
  if (
    maxBytes > 0 &&
    cached &&
    cached.bytes <= maxBytes &&
    cached.bytes === fileStat.size &&
    cached.mtimeMs === fileStat.mtimeMs &&
    now - cached.createdAt <= WORKSPACE_CONTENT_CACHE_TTL_MS
  ) {
    cached.lastUsedAt = now;
    contentCacheStats.hitFiles += 1;
    contentCacheStats.hitBytes += cached.bytes;
    contentCacheStats.currentBytes = workspaceContentCacheBytes;
    return { text: cached.text, bytes: cached.bytes };
  }

  const data = await readFile(file.absPath);
  const text = data.toString("utf8");
  contentCacheStats.missFiles += 1;
  contentCacheStats.missBytes += data.byteLength;
  const remembered = rememberWorkspaceContent(file, text, data.byteLength, fileStat.mtimeMs, maxBytes);
  contentCacheStats.storedBytes += remembered.storedBytes;
  contentCacheStats.evictions += remembered.evictions;
  contentCacheStats.skippedTooLarge += remembered.skippedTooLarge;
  contentCacheStats.currentBytes = workspaceContentCacheBytes;
  return { text, bytes: data.byteLength };
}

export async function codeSearch(input: {
  root?: string;
  authorizedRoot?: string;
  intent: string;
  queries?: string[];
  paths?: string[];
  maxFiles?: number;
  maxSpans?: number;
  contextLines?: number;
  forceRefresh?: boolean;
  maxCacheAgeMs?: number;
  useContentCache?: boolean;
  maxContentCacheBytes?: number;
  respectGitignore?: boolean;
}): Promise<CodeSearchResult> {
  const totalStart = performance.now();
  const root = resolvePath(input.root || getWorkspaceRoot() || getSessionCwd());
  if (input.authorizedRoot) {
    await assertAuthorizedDiscoveryRoot(root, resolvePath(input.authorizedRoot));
  }
  const maxSpans = input.maxSpans ?? 12;
  const contextLines = input.contextLines ?? 2;
  const queries = compileQueries(input.intent, input.queries).slice(0, 8);
  const collectedFiles = await collectWorkspaceFiles(root, {
    maxFiles: input.maxFiles ?? 2000,
    maxDepth: 10,
    forceRefresh: input.forceRefresh,
    maxCacheAgeMs: input.maxCacheAgeMs,
    respectGitignore: input.respectGitignore,
  });
  const files = {
    ...collectedFiles,
    files: collectedFiles.files.filter((file) => !isSensitiveDiscoveryPath(file.path)),
  };
  const excludedSensitiveFiles =
    collectedFiles.sensitiveExcludedFiles + collectedFiles.files.length - files.files.length;
  const phaseTimings: CodeSearchPhaseTimings = {
    totalWallMs: 0,
    cacheLookupWallMs: files.phaseTimings.cacheLookupWallMs,
    fileSetBuildWallMs: files.phaseTimings.fileSetBuildWallMs,
    fileSetStatWallMs: files.phaseTimings.fileSetStatWallMs,
    fileSetReadWallMs: files.phaseTimings.fileSetReadWallMs,
    searchWallMs: 0,
    searchReadWallMs: 0,
    searchScanWallMs: 0,
    shapeWallMs: 0,
    previewWallMs: 0,
  };
  const fileScores = new Map<string, { score: number; reasons: Set<string>; symbols: Set<string> }>();
  const spans: CodeSearchResult["spans"] = [];
  const contentCacheStats: CodeSearchContentCacheStats = {
    enabled: input.useContentCache === true,
    hitFiles: 0,
    missFiles: 0,
    hitBytes: 0,
    missBytes: 0,
    storedBytes: 0,
    currentBytes: workspaceContentCacheBytes,
    evictions: 0,
    skippedTooLarge: 0,
  };
  let searchedFiles = 0;
  let searchedBytes = 0;

  let shapeStart = performance.now();
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
  phaseTimings.shapeWallMs += performance.now() - shapeStart;

  for (const query of queries) {
    const searchStart = performance.now();
    const result = await searchWorkspaceFiles(root, files.files, query, {
      maxMatches: Math.max(maxSpans * 3, 24),
      maxFiles: input.maxFiles ?? 2000,
      detail: "locations",
      useContentCache: input.useContentCache,
      maxContentCacheBytes: input.maxContentCacheBytes,
      contentCacheStats,
    });
    phaseTimings.searchWallMs += performance.now() - searchStart;
    phaseTimings.searchReadWallMs += result.stats.phaseTimings?.searchReadWallMs ?? 0;
    phaseTimings.searchScanWallMs += result.stats.phaseTimings?.searchScanWallMs ?? 0;
    searchedFiles = Math.max(searchedFiles, result.stats.searchedFiles);
    searchedBytes += result.stats.bytesScanned;
    shapeStart = performance.now();
    for (const match of result.matches) {
      const bucket = fileScores.get(match.path) ?? { score: 0, reasons: new Set<string>(), symbols: new Set<string>() };
      bucket.score += exactBoost(input.intent, query);
      bucket.reasons.add(`literal:${query}`);
      fileScores.set(match.path, bucket);
      spans.push({
        path: match.path,
        startLine: Math.max(1, match.line - contextLines),
        endLine: match.line + contextLines,
        preview: "",
        matchedQueries: [query],
        score: bucket.score,
      });
    }
    phaseTimings.shapeWallMs += performance.now() - shapeStart;
  }

  shapeStart = performance.now();
  const candidateSpans = dedupeSpans(spans)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSpans);
  phaseTimings.shapeWallMs += performance.now() - shapeStart;
  const previewStart = performance.now();
  const previewReads = await batchReadFiles(candidateSpans.map((span) => ({
    path: span.path,
    startLine: span.startLine,
    endLine: span.endLine,
    maxBytes: 8 * 1024,
  })), root);
  phaseTimings.previewWallMs += performance.now() - previewStart;
  shapeStart = performance.now();
  const previewBySpan = new Map(
    previewReads.files.map((file) => [`${file.path}:${file.startLine}:${file.endLine}`, file.content]),
  );
  const dedupedSpans = candidateSpans.map((span) => ({
    ...span,
    preview: previewBySpan.get(`${span.path}:${span.startLine}:${span.endLine}`) ?? span.preview,
  }));
  const rankedFiles = [...fileScores.entries()]
    .filter(([, info]) => info.score > 0)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 12)
    .map(([path, info]) => ({ path, score: info.score, reasons: [...info.reasons], symbols: [...info.symbols] }));
  phaseTimings.shapeWallMs += performance.now() - shapeStart;
  phaseTimings.totalWallMs = performance.now() - totalStart;

  return {
    answerHint: files.truncated
      ? "Search was partial because the eligible file set was capped. Narrow the query/path or explicitly broaden scope before treating absence as definitive."
      : dedupedSpans.length
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
      cacheHit: files.cacheHit,
      fileSetId: files.fileSetId,
      eligibleFiles: files.files.length,
      phaseTimings,
      contentCache: contentCacheStats,
      excludedSensitiveFiles,
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
  respectGitignore?: boolean;
}): Promise<FileSearchResult> {
  const root = resolvePath(input.root || getSessionCwd());
  const query = String(input.query || "").trim();
  if (!query) return { matches: [], stats: { scannedFiles: 0, skippedFiles: 0, truncated: false }, source: "ts" };

  const files = await collectWorkspaceFiles(root, {
    maxFiles: input.maxFiles ?? 5000,
    maxDepth: 10,
    respectGitignore: input.respectGitignore,
  });
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
    stats: {
      scannedFiles: files.files.length,
      skippedFiles: files.skippedFiles,
      truncated: files.truncated,
      cacheHit: files.cacheHit,
      fileSetId: files.fileSetId,
    },
    source: "ts",
  };
}

export async function batchReadFiles(
  files: Array<{ path: string; startLine?: number; endLine?: number; maxBytes?: number }>,
  root = getSessionCwd(),
): Promise<BatchReadFilesResult> {
  const absRoot = resolvePath(root || ".");
  const output: BatchReadFilesResult["files"] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const request of files.slice(0, 12)) {
    const absPath = resolvePath(absRoot, request.path);
    try {
      await assertAuthorizedDiscoveryRoot(absPath, absRoot);
      if (isSensitiveDiscoveryPath(request.path)) {
        throw new Error("refusing to read sensitive file path");
      }
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

function workspaceFileCacheKey(absRoot: string, opts: { maxFiles: number; maxDepth: number; respectGitignore?: boolean }): string {
  return `${absRoot}|maxFiles=${opts.maxFiles}|maxDepth=${opts.maxDepth}|maxFileBytes=${DEFAULT_MAX_FILE_BYTES}|sourceOnly=1|hidden=0|vendor=0|build=0|gitignore=${opts.respectGitignore !== false}`;
}

function workspaceFileSetId(cacheKey: string, files: WorkspaceFile[]): string {
  return contentHash(`${cacheKey}|${files.map((file) => `${file.path}:${file.bytes}:${file.mtimeMs}`).join("|")}`).toString(16);
}

function cloneWorkspaceFileCollection(
  result: WorkspaceFileCollection,
  cacheHit: boolean,
  phaseTimings?: WorkspaceFilePhaseTimings,
): WorkspaceFileCollection {
  return {
    files: result.files.map((file) => ({ ...file })),
    skippedFiles: result.skippedFiles,
    sensitiveExcludedFiles: result.sensitiveExcludedFiles,
    truncated: result.truncated,
    cacheHit,
    fileSetId: result.fileSetId,
    phaseTimings: phaseTimings ?? { ...result.phaseTimings },
  };
}

async function collectWorkspaceFiles(
  root: string,
  opts: { maxFiles: number; maxDepth: number; forceRefresh?: boolean; maxCacheAgeMs?: number; respectGitignore?: boolean },
): Promise<WorkspaceFileCollection> {
  const collectStart = performance.now();
  const files: WorkspaceFile[] = [];
  let fileSetStatWallMs = 0;
  let fileSetReadWallMs = 0;
  const absRoot = resolvePath(root || ".");
  const cacheKey = workspaceFileCacheKey(absRoot, opts);
  const cacheLookupStart = performance.now();
  const cached = workspaceFileCache.get(cacheKey);
  const cacheLookupWallMs = performance.now() - cacheLookupStart;
  const maxCacheAgeMs = Math.max(0, opts.maxCacheAgeMs ?? WORKSPACE_FILE_CACHE_TTL_MS);
  if (!opts.forceRefresh && cached && Date.now() - cached.createdAt <= maxCacheAgeMs) {
    return cloneWorkspaceFileCollection(cached.result, true, {
      cacheLookupWallMs,
      fileSetBuildWallMs: 0,
      fileSetStatWallMs: 0,
      fileSetReadWallMs: 0,
    });
  }

  const traversal = await collectTraversalFiles(absRoot, {
    maxFiles: opts.maxFiles,
    maxDepth: opts.maxDepth,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    caps: {
      includeHidden: false,
      includeVendor: false,
      includeBuildOutputs: false,
      respectGitignore: opts.respectGitignore,
    },
    sourceOnly: true,
    respectGitignore: opts.respectGitignore !== false,
  });
  fileSetStatWallMs += traversal.fileSetStatWallMs;
  let skippedFiles = traversal.skippedFiles;
  for (const file of traversal.files) {
    try {
      const readStart = performance.now();
      const data = await readFile(file.absPath);
      fileSetReadWallMs += performance.now() - readStart;
      if (isLikelyBinaryBuffer(data) || !isValidUtf8(data)) {
        skippedFiles += 1;
        continue;
      }
      files.push({
        path: file.path,
        absPath: file.absPath,
        bytes: data.byteLength,
        mtimeMs: file.mtimeMs,
        depth: file.depth,
        language: languageForPath(file.path),
        keyReason: keyReasonForPath(file.path),
      });
    } catch {
      skippedFiles += 1;
    }
  }
  const result: WorkspaceFileCollection = {
    files,
    skippedFiles,
    sensitiveExcludedFiles: traversal.sensitiveExcludedFiles,
    truncated: traversal.truncated || files.length >= opts.maxFiles,
    cacheHit: false,
    fileSetId: workspaceFileSetId(cacheKey, files),
    phaseTimings: {
      cacheLookupWallMs,
      fileSetBuildWallMs: performance.now() - collectStart,
      fileSetStatWallMs,
      fileSetReadWallMs,
    },
  };
  workspaceFileCache.set(cacheKey, {
    createdAt: Date.now(),
    result: cloneWorkspaceFileCollection(result, false),
  });
  return result;
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

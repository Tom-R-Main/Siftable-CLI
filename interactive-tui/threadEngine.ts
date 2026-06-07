/**
 * Thread engine bridge.
 *
 * Deterministic context-window kernel for the TUI: token estimation now, the
 * compaction planner and rollout codec in later phases. The hot path lives in
 * Zig (`native/thread_engine.zig`) and loads through Bun FFI; a TypeScript
 * fallback keeps A0 usable when the native library has not been built yet.
 *
 * Scope boundary: this module never calls a model or does network I/O. It only
 * answers "how big is this?" / "what should the host do?" — the host owns the
 * one summarize call and the history rewrite.
 */
import { existsSync } from "node:fs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let native:
  | {
      sift_thread_estimate_tokens: (bytes: Uint8Array, len: number) => number;
      sift_thread_plan_chunks: (
        text: Uint8Array,
        textLen: number,
        maxChars: number,
        overlapChars: number,
        out: Uint8Array,
        outCap: number,
        written: Uint32Array,
        needed: Uint32Array,
      ) => number;
      sift_thread_plan_compaction: (
        msgs: Uint8Array,
        msgsLen: number,
        config: Uint32Array,
        out: Uint8Array,
        outCap: number,
        written: Uint32Array,
        needed: Uint32Array,
      ) => number;
      sift_thread_rollout_append: (
        path: Uint8Array,
        pathLen: number,
        line: Uint8Array,
        lineLen: number,
      ) => number;
      sift_thread_rollout_load: (
        path: Uint8Array,
        pathLen: number,
        maxTurns: number,
        out: Uint8Array,
        outCap: number,
        written: Uint32Array,
        needed: Uint32Array,
      ) => number;
    }
  | null
  | undefined;

function nativeSymbols() {
  if (native !== undefined) return native;
  if (typeof Bun === "undefined") {
    native = null;
    return native;
  }
  const { default: nativeLibraryPath } = require("./native/thread_engine") as { default: string };
  if (!existsSync(nativeLibraryPath)) {
    native = null;
    return native;
  }

  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
  const lib = dlopen(nativeLibraryPath, {
    // ptr accepts a Uint8Array and matches Zig's [*]const u8 C ABI.
    sift_thread_estimate_tokens: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    sift_thread_plan_chunks: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32,
    },
    sift_thread_plan_compaction: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32,
    },
    sift_thread_rollout_append: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32],
      returns: FFIType.u32,
    },
    sift_thread_rollout_load: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32,
    },
  });

  native = lib.symbols;
  return native;
}

/** Source of the most recent token estimate, for diagnostics/tests. */
export type TokenEstimateSource = "zig" | "ts";

let lastEstimateSource: TokenEstimateSource = "ts";

/** Which engine produced the last `estimateTokens` result. */
export function tokenEstimateSource(): TokenEstimateSource {
  return lastEstimateSource;
}

/**
 * Heuristic token count for a string. Deterministic and fast; intended as a
 * pre-turn overflow gate, not a billing-accurate BPE count.
 */
export function estimateTokens(text: string): number {
  if (!text) {
    lastEstimateSource = nativeSymbols() ? "zig" : "ts";
    return 0;
  }
  const symbols = nativeSymbols();
  if (symbols) {
    const bytes = encoder.encode(text);
    lastEstimateSource = "zig";
    return symbols.sift_thread_estimate_tokens(bytes, bytes.byteLength);
  }
  lastEstimateSource = "ts";
  return estimateTokensFallback(text);
}

/**
 * Mirror of the Zig heuristic for environments without the native library.
 * Exported for parity tests; prefer {@link estimateTokens} at call sites.
 */
export function estimateTokensFallback(text: string): number {
  // Mirrors native/thread_engine.zig: word runs ceil(chars/4), multibyte 1 each,
  // punctuation carries a surcharge (PUNCT_WEIGHT_TENTHS/10) to correct the
  // code under-count without lowering prose. Keep these two in lockstep.
  const PUNCT_WEIGHT_TENTHS = 13;
  let wordTokens = 0;
  let punct = 0;
  let multibyte = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const code = text.codePointAt(i)!;
    const ch = String.fromCodePoint(code);
    const size = ch.length; // 1 for BMP, 2 for surrogate pairs
    if (/[a-zA-Z0-9]/.test(ch)) {
      let run = 0;
      while (i < len && /[a-zA-Z0-9]/.test(text[i]!)) {
        run += 1;
        i += 1;
      }
      wordTokens += Math.ceil(run / 4);
    } else if (/\s/.test(ch)) {
      i += size;
    } else if (code < 0x80) {
      punct += 1;
      i += size;
    } else {
      multibyte += 1;
      i += size;
    }
  }
  return wordTokens + multibyte + Math.floor((punct * PUNCT_WEIGHT_TENTHS + 5) / 10);
}

// ── Text chunk planner bridge ───────────────────────────────────────────────

export interface NativeTextChunk {
  index: number;
  body: string;
}

interface NativeChunkOffset {
  index: number;
  start: number;
  end: number;
}

interface NativeChunkPlan {
  chunks: NativeChunkOffset[];
}

/** True when the native text chunk planner can be called. */
export function nativeChunkingAvailable(): boolean {
  return nativeSymbols() != null;
}

/**
 * Run the native structural chunk planner and decode its returned byte ranges.
 *
 * This mirrors `exf-app/src/services/chunkingService.ts` for bridge evaluation;
 * backend call sites should keep using the TypeScript chunker until the lane-B
 * bridge decision exists.
 */
export function chunkTextNative(text: string, maxChars = 1000, overlapChars = 200): NativeTextChunk[] | null {
  const symbols = nativeSymbols();
  if (!symbols) return null;

  const normalised = text.trim();
  if (!normalised) return [];

  const input = encoder.encode(normalised);
  let cap = Math.max(512, Math.ceil(input.byteLength / Math.max(1, maxChars)) * 48 + 128);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const out = new Uint8Array(cap);
    const written = new Uint32Array(1);
    const needed = new Uint32Array(1);
    const status = symbols.sift_thread_plan_chunks(
      input,
      input.byteLength,
      maxChars,
      overlapChars,
      out,
      out.byteLength,
      written,
      needed,
    );
    if (status === STATUS_OK) {
      const plan = JSON.parse(decoder.decode(out.subarray(0, written[0]))) as NativeChunkPlan;
      return plan.chunks.map((chunk) => ({
        index: chunk.index,
        body: decoder.decode(input.subarray(chunk.start, chunk.end)),
      }));
    }
    if (status === STATUS_OUTPUT_TOO_SMALL) {
      cap = Math.max(needed[0]! + 64, cap * 2);
      continue;
    }
    return null;
  }
  return null;
}

// ── Compaction planner bridge ────────────────────────────────────────────────

/** Roles the planner understands, matching the Zig ROLE_* constants. */
export type PlanRole = "user" | "assistant" | "tool";

/** A message as the planner sees it: role + plain-text content + protect flag. */
export interface PlanMessage {
  role: PlanRole;
  text: string;
  /** Tool output that must never be pruned (e.g. a skill result). */
  protected?: boolean;
}

/** Budget knobs for {@link planCompaction}. All values are token counts. */
export interface CompactionConfig {
  contextWindow: number;
  /** Output + safety reserve subtracted from the window. */
  reserved: number;
  /** How many recent whole turns to keep verbatim. */
  tailTurns: number;
  /** Cap on the kept-tail token budget. */
  preserveRecentTokens: number;
  /** Protect the most-recent N tokens of tool output from pruning. */
  pruneProtectTokens: number;
  /** Only prune if it frees at least this many tokens. */
  pruneMinTokens: number;
}

/** The plan returned by the Zig planner — what the host should execute. */
export interface CompactionPlan {
  needsCompaction: boolean;
  estimatedTokens: number;
  usableTokens: number;
  prunedTokens: number;
  /** Message indices whose tool-output content should be cleared. */
  prune: number[];
  /** [start, end) range of messages to replace with a summary. */
  summarizeRange: [number, number];
  /** Index where the verbatim tail begins (a user-message boundary). */
  tailStartIndex: number;
}

const ROLE_CODE: Record<PlanRole, number> = { user: 0, assistant: 1, tool: 2 };
const FLAG_PROTECTED = 0x1;
const STATUS_OK = 0;
const STATUS_OUTPUT_TOO_SMALL = 9;

/** Pack messages into the framed buffer the Zig planner parses. */
function frameMessages(messages: PlanMessage[]): Uint8Array {
  const encoded = messages.map((m) => encoder.encode(m.text));
  let size = 0;
  for (const e of encoded) size += 6 + e.byteLength;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let off = 0;
  for (let i = 0; i < messages.length; i += 1) {
    buf[off] = ROLE_CODE[messages[i]!.role];
    buf[off + 1] = messages[i]!.protected ? FLAG_PROTECTED : 0;
    view.setUint32(off + 2, encoded[i]!.byteLength, true); // little-endian
    buf.set(encoded[i]!, off + 6);
    off += 6 + encoded[i]!.byteLength;
  }
  return buf;
}

/**
 * Decide what to do with an over-budget conversation: prune-then-summarize,
 * turn-aligned. Native-only — returns null when the Zig library is unavailable,
 * in which case the caller should skip compaction (degrading to no compaction).
 */
export function planCompaction(
  messages: PlanMessage[],
  config: CompactionConfig,
): CompactionPlan | null {
  const symbols = nativeSymbols();
  if (!symbols) return null;

  const msgs = frameMessages(messages);
  const cfg = Uint32Array.from([
    config.contextWindow,
    config.reserved,
    config.tailTurns,
    config.preserveRecentTokens,
    config.pruneProtectTokens,
    config.pruneMinTokens,
  ]);

  let cap = Math.max(512, messages.length * 8 + 256);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const out = new Uint8Array(cap);
    const written = new Uint32Array(1);
    const needed = new Uint32Array(1);
    const status = symbols.sift_thread_plan_compaction(
      msgs,
      msgs.byteLength,
      cfg,
      out,
      out.byteLength,
      written,
      needed,
    );
    if (status === STATUS_OK) {
      return JSON.parse(decoder.decode(out.subarray(0, written[0]))) as CompactionPlan;
    }
    if (status === STATUS_OUTPUT_TOO_SMALL) {
      cap = Math.max(needed[0]! + 64, cap * 2);
      continue;
    }
    return null; // invalid args / unexpected — treat as "no plan"
  }
  return null;
}

// ── Rollout persistence bridge ───────────────────────────────────────────────

const STATUS_NOT_FOUND = 2;

/** True when the native rollout I/O is available. */
export function rolloutAvailable(): boolean {
  return nativeSymbols() != null;
}

/** FNV-1a 32-bit, matching the Zig/TS hashes elsewhere in the engine. */
function fnv1a32(s: string): number {
  let h = 2166136261;
  const b = encoder.encode(s);
  for (let i = 0; i < b.length; i += 1) {
    h ^= b[i]!;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Stable rollout file path for a thread key (typically the workspace/cwd), under
 * the shared ~/.siftable/threads directory. Hashing keeps it filename-safe.
 */
export function rolloutPathForKey(homeDir: string, key: string): string {
  const hash = fnv1a32(key).toString(16).padStart(8, "0");
  return `${homeDir}/.siftable/threads/${hash}.jsonl`;
}

/** Append one record line to the rollout (the trailing newline is added by Zig). */
export function rolloutAppend(path: string, line: string): boolean {
  const symbols = nativeSymbols();
  if (!symbols) return false;
  const p = encoder.encode(path);
  const l = encoder.encode(line);
  return symbols.sift_thread_rollout_append(p, p.byteLength, l, l.byteLength) === STATUS_OK;
}

/**
 * Load the rollout's JSONL text, optionally truncated to the last `maxTurns`
 * whole turns (0 = all). Returns "" when the file is absent (no history yet) and
 * null only when the native library is unavailable.
 */
export function rolloutLoad(path: string, maxTurns = 0): string | null {
  const symbols = nativeSymbols();
  if (!symbols) return null;
  const p = encoder.encode(path);
  let cap = 64 * 1024;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const out = new Uint8Array(cap);
    const written = new Uint32Array(1);
    const needed = new Uint32Array(1);
    const status = symbols.sift_thread_rollout_load(p, p.byteLength, maxTurns, out, out.byteLength, written, needed);
    if (status === STATUS_OK) return decoder.decode(out.subarray(0, written[0]));
    if (status === STATUS_NOT_FOUND) return "";
    if (status === STATUS_OUTPUT_TOO_SMALL) {
      cap = Math.max(needed[0]! + 1024, cap * 2);
      continue;
    }
    return null; // hard I/O error
  }
  return null;
}

/**
 * Composer / paste policy.
 *
 * The hot path is implemented in Zig (`native/composer_policy.zig`) and loaded
 * through Bun FFI. A TypeScript fallback keeps local A0 usable when the native
 * library has not been built yet.
 */
import { existsSync } from "node:fs";

export type PasteDecision = "inline" | "chip" | "force-chip";

export interface PasteAnalysis {
  chars: number;
  lines: number;
  structured: boolean;
  decision: PasteDecision;
  source: "zig" | "ts";
}

const encoder = new TextEncoder();

const DECISION_INLINE = 0;
const DECISION_CHIP = 1;
const DECISION_FORCE_CHIP = 2;

let native:
  | {
      sift_paste_char_count: (bytes: Uint8Array, len: number) => number;
      sift_paste_line_count: (bytes: Uint8Array, len: number) => number;
      sift_paste_looks_structured: (bytes: Uint8Array, len: number) => boolean;
      sift_should_chip_paste: (bytes: Uint8Array, len: number) => number;
    }
  | null
  | undefined;

function nativeSymbols() {
  if (native !== undefined) return native;
  if (typeof Bun === "undefined") {
    native = null;
    return native;
  }
  const { default: nativeLibraryPath } = require("./native/composer_policy") as { default: string };
  if (!existsSync(nativeLibraryPath)) {
    native = null;
    return native;
  }

  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
  const lib = dlopen(nativeLibraryPath, {
    // Bun 1.3.13 exposes FFIType.buffer but rejects it in dlopen() for this
    // path; ptr accepts a Uint8Array and matches Zig's [*]const u8 C ABI.
    sift_paste_char_count: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    sift_paste_line_count: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    sift_paste_looks_structured: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
    sift_should_chip_paste: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  });

  native = lib.symbols;
  return native;
}

export function analyzePaste(text: string): PasteAnalysis {
  const bytes = encoder.encode(text);
  const symbols = nativeSymbols();
  if (symbols) {
    const decision = symbols.sift_should_chip_paste(bytes, bytes.byteLength);
    return {
      chars: symbols.sift_paste_char_count(bytes, bytes.byteLength),
      lines: symbols.sift_paste_line_count(bytes, bytes.byteLength),
      structured: symbols.sift_paste_looks_structured(bytes, bytes.byteLength),
      decision: decision === DECISION_FORCE_CHIP ? "force-chip" : decision === DECISION_CHIP ? "chip" : "inline",
      source: "zig",
    };
  }
  return analyzePasteFallback(text);
}

function analyzePasteFallback(text: string): PasteAnalysis {
  const chars = [...text].length;
  const lines = text ? text.split(/\r\n|\r|\n/).length : 0;
  const structured = looksLikeStructuredBlock(text);

  let decision: PasteDecision = "inline";
  if (chars >= 4000 || lines >= 40) decision = "force-chip";
  else if (chars >= 1500 || lines >= 12) decision = "chip";
  else if (chars >= 1000 && lines >= 6 && structured) decision = "chip";

  return { chars, lines, structured, decision, source: "ts" };
}

function looksLikeStructuredBlock(text: string): boolean {
  return (
    text.includes("```") ||
    text.includes("Error:") ||
    text.includes("Traceback ") ||
    text.includes("Exception") ||
    text.includes("    at ") ||
    text.includes("http://") ||
    text.includes("https://") ||
    text.includes("\t") ||
    text.includes("{\n") ||
    text.includes("[\n") ||
    /^[-*#] /m.test(text) ||
    /^ {4}\S/m.test(text)
  );
}

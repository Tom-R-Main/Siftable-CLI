/**
 * Bridge to the `cell-render` binary (the image-to-ascii / "Cell Render" Zig
 * project). It turns Mermaid text and raster images into terminal cells.
 *
 * Mermaid is text-in / ANSI-out, so we shell out rather than link a native
 * library — there are no pixels to marshal and the binary owns the parser,
 * layout, and renderer. The same locator + runner is reused by the TUI slash
 * commands, the assistant fenced-block auto-render, and (via its own copy of the
 * locator) the `sift mermaid` / `sift image` oclif commands.
 *
 * Binary discovery order: `SIFT_CELL_RENDER_BIN` → vendored `native/cell-render`
 * (populated by scripts/build-native.sh) → the sibling `image-to-ascii` repo
 * build output → `PATH`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_NAME = "cell-render";
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const CELL_RENDER_MISSING_MESSAGE =
  "cell-render binary not found. Build it (cd ~/projects/image-to-ascii && zig build) " +
  "or set SIFT_CELL_RENDER_BIN to its path.";

export interface CellRenderResult {
  ok: boolean;
  /** Rendered terminal output (stdout). */
  text: string;
  /** Error detail (locate failure, stderr, or non-zero exit). */
  error?: string;
}

export interface MermaidRenderOptions {
  glyph?: "unicode" | "ascii";
  color?: "none" | "truecolor";
  /** Exact pane (pads/clips). */
  width?: number;
  height?: number;
  /** Upper bound only (no padding). */
  maxWidth?: number;
  maxHeight?: number;
  overflow?: "allow" | "clip" | "error";
}

let cachedBin: string | null | undefined;

/** Locate the `cell-render` binary, caching the result for the process. */
export function resolveCellRenderBin(): string | null {
  if (cachedBin !== undefined) return cachedBin;
  cachedBin = locateCellRenderBin();
  return cachedBin;
}

function locateCellRenderBin(): string | null {
  const fromEnv = process.env.SIFT_CELL_RENDER_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  // Vendored next to the native dylibs by scripts/build-native.sh.
  const vendored = fileURLToPath(new URL(`./native/${BIN_NAME}`, import.meta.url));
  if (existsSync(vendored)) return vendored;

  // Dev fallback: the sibling image-to-ascii repo build output.
  const sibling = join(homedir(), "projects", "image-to-ascii", "zig-out", "bin", BIN_NAME);
  if (existsSync(sibling)) return sibling;

  // PATH.
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [BIN_NAME], {
    encoding: "utf8",
  });
  if (probe.status === 0 && probe.stdout) {
    const first = probe.stdout.split("\n").map((s) => s.trim()).find(Boolean);
    if (first && existsSync(first)) return first;
  }
  return null;
}

function mermaidArgs(path: string, opts: MermaidRenderOptions): string[] {
  const args = ["mermaid", path, opts.glyph === "ascii" ? "--ascii" : "--unicode"];
  args.push("--color", opts.color ?? "none");
  if (opts.width != null) args.push("--width", String(opts.width));
  if (opts.height != null) args.push("--height", String(opts.height));
  if (opts.maxWidth != null) args.push("--max-width", String(opts.maxWidth));
  if (opts.maxHeight != null) args.push("--max-height", String(opts.maxHeight));
  if (opts.overflow) args.push("--overflow", opts.overflow);
  return args;
}

function runCellRender(args: string[]): CellRenderResult {
  const bin = resolveCellRenderBin();
  if (!bin) return { ok: false, text: "", error: CELL_RENDER_MISSING_MESSAGE };
  const res = spawnSync(bin, args, { encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES });
  if (res.error) return { ok: false, text: "", error: res.error.message };
  const stdout = (res.stdout as string) ?? "";
  const stderr = ((res.stderr as string) ?? "").trim();
  if (res.status !== 0) {
    return { ok: false, text: stdout, error: stderr || `cell-render exited with status ${res.status}` };
  }
  return { ok: true, text: stdout.replace(/\n+$/, ""), error: stderr || undefined };
}

/** Render a Mermaid file (`.mmd`) to terminal cells. */
export function renderMermaidFile(path: string, opts: MermaidRenderOptions = {}): CellRenderResult {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(abs)) return { ok: false, text: "", error: `file not found: ${path}` };
  return runCellRender(mermaidArgs(abs, opts));
}

/** Render inline Mermaid source by staging it through a temp file. */
export function renderMermaidSource(source: string, opts: MermaidRenderOptions = {}): CellRenderResult {
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, text: "", error: "empty mermaid source" };
  if (!resolveCellRenderBin()) return { ok: false, text: "", error: CELL_RENDER_MISSING_MESSAGE };
  const dir = mkdtempSync(join(tmpdir(), "sift-mermaid-"));
  const file = join(dir, "diagram.mmd");
  try {
    writeFileSync(file, `${trimmed}\n`, "utf8");
    const result = runCellRender(mermaidArgs(file, opts));
    // The renderer reports errors prefixed with the staged temp path; rewrite it
    // to "mermaid" so inline callers see a clean `mermaid:line:col: …` message.
    if (!result.ok && result.error) {
      result.error = result.error.split(`${file}:`).join("mermaid:").split(file).join("mermaid");
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Extract ```mermaid fenced blocks from a markdown string, in source order.
 * Returns the raw diagram bodies (fence markers and the `mermaid` info-string
 * stripped). Used to auto-render diagrams the assistant emits.
 */
export function extractMermaidBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const fence = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*mermaid[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(markdown)) !== null) {
    const body = match[3].trim();
    if (body) blocks.push(body);
  }
  return blocks;
}

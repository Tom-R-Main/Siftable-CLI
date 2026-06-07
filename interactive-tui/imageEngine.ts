/**
 * Native image validation / metadata.
 *
 * Pattern matches fsEngine/composerPolicy: Zig handles byte-level probing under
 * Bun FFI; TypeScript fallback keeps tests and degraded local dev usable.
 */
import { existsSync } from "node:fs";

export interface ImageProbeOptions {
  maxBytes?: number;
  maxPixels?: number;
}

export interface ImageProbeResult {
  mime: string;
  width: number;
  height: number;
  bytes: number;
  source: "zig" | "ts";
}

export interface NormalizedImageResult extends ImageProbeResult {
  data: Uint8Array;
  normalized: boolean;
  original?: ImageProbeResult;
}

export interface RawRgbaFrame {
  width: number;
  height: number;
  stride?: number;
  columns: number;
  rows: number;
  invert?: boolean;
}

export interface RawRgbaAnsiResult {
  ansi: string;
  columns: number;
  rows: number;
  source: "zig" | "ts";
}

export interface TuiImageAnsiOptions extends ImageProbeOptions {
  columns?: number;
  rows?: number;
  invert?: boolean;
}

export interface TuiImageAnsiResult extends RawRgbaAnsiResult {
  image: NormalizedImageResult;
  rawWidth: number;
  rawHeight: number;
}

export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_IMAGE_PIXELS = 4096 * 4096;
const DEFAULT_NORMALIZE_MAX_SIDE = 2048;
const DEFAULT_RENDER_COLUMNS = 48;

const STATUS_OK = 0;
const STATUS_INVALID_ARGS = 1;
const STATUS_UNSUPPORTED = 2;
const STATUS_TOO_LARGE = 3;
const STATUS_MALFORMED = 4;
const STATUS_OUTPUT_TOO_SMALL = 5;
const RENDER_FLAG_INVERT = 0x1;
const DENSITY_RAMP = " .:-=+*#%@";

const MIME_BY_CODE: Record<number, string> = {
  1: "image/png",
  2: "image/jpeg",
  3: "image/gif",
  4: "image/webp",
  5: "image/bmp",
};

let native:
  | {
      sift_image_probe: (
        bytes: Uint8Array,
        len: number,
        maxBytes: number,
        maxPixels: number,
        out: Uint32Array,
      ) => number;
      sift_image_render_density_ansi: (
        bytes: Uint8Array,
        len: number,
        options: Uint32Array,
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
  const { default: nativeLibraryPath } = require("./native/image_engine") as { default: string };
  if (!existsSync(nativeLibraryPath)) {
    native = null;
    return native;
  }
  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
  const lib = dlopen(nativeLibraryPath, {
    sift_image_probe: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
    sift_image_render_density_ansi: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32,
    },
  });
  native = lib.symbols as typeof native;
  return native;
}

export function probeImage(bytes: Uint8Array, options: ImageProbeOptions = {}): ImageProbeResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_IMAGE_PIXELS;
  const symbols = nativeSymbols();
  if (symbols) {
    const out = new Uint32Array(4);
    const status = symbols.sift_image_probe(bytes, bytes.byteLength, maxBytes, maxPixels, out);
    if (status === STATUS_OK) {
      return {
        mime: MIME_BY_CODE[out[0]] ?? "application/octet-stream",
        width: out[1],
        height: out[2],
        bytes: out[3],
        source: "zig",
      };
    }
    throw new Error(statusMessage(status));
  }
  return probeImageFallback(bytes, maxBytes, maxPixels);
}

export function nativeImageProbeAvailable(): boolean {
  return nativeSymbols() !== null;
}

export function renderRawRgbaToAnsi(raw: Uint8Array, frame: RawRgbaFrame): RawRgbaAnsiResult {
  const width = uint32(frame.width, "image render: invalid width");
  const height = uint32(frame.height, "image render: invalid height");
  const stride = uint32(frame.stride ?? width * 4, "image render: invalid stride");
  const columns = uint32(frame.columns, "image render: invalid columns");
  const rows = uint32(frame.rows, "image render: invalid rows");
  const flags = frame.invert ? RENDER_FLAG_INVERT : 0;
  const requiredBytes = (height - 1) * stride + width * 4;
  if (!raw.byteLength || stride < width * 4 || raw.byteLength < requiredBytes) {
    throw new Error("image render: invalid raw RGBA frame");
  }

  const symbols = nativeSymbols();
  if (symbols) {
    const options = Uint32Array.from([width, height, stride, columns, rows, flags]);
    const written = new Uint32Array(1);
    const needed = new Uint32Array(1);
    let out = new Uint8Array(Math.max(32, (columns + 1) * rows));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const status = symbols.sift_image_render_density_ansi(raw, raw.byteLength, options, out, out.byteLength, written, needed);
      if (status === STATUS_OK) {
        return { ansi: new TextDecoder().decode(out.subarray(0, written[0])), columns, rows, source: "zig" };
      }
      if (status !== STATUS_OUTPUT_TOO_SMALL) throw new Error(statusMessage(status));
      out = new Uint8Array(Math.max(out.byteLength * 2, needed[0]));
    }
    throw new Error("image render: native output did not fit after buffer growth");
  }

  return { ansi: renderRawRgbaToAnsiFallback(raw, { width, height, stride, columns, rows, invert: frame.invert }), columns, rows, source: "ts" };
}

/**
 * Normalize images before sending them to a model. This matches the product
 * pattern in Codex/opencode-style CLIs: reject malformed/unsupported media, but
 * downscale/re-encode valid oversized images before giving up.
 */
export async function normalizeImageForModel(
  bytes: Uint8Array,
  options: ImageProbeOptions = {}
): Promise<NormalizedImageResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_IMAGE_PIXELS;
  const original = probeImage(bytes, { maxBytes: 0, maxPixels: 0 });
  if ((maxBytes <= 0 || original.bytes <= maxBytes) && (maxPixels <= 0 || original.width * original.height <= maxPixels)) {
    return { ...original, data: bytes, normalized: false };
  }

  const sharp = await loadSharp();
  if (!sharp) {
    throw new Error("image paste: image too large and sharp is unavailable for downscaling");
  }

  const pixelScale = maxPixels > 0 ? Math.min(1, Math.sqrt(maxPixels / Math.max(1, original.width * original.height))) : 1;
  const sideScale = Math.min(1, DEFAULT_NORMALIZE_MAX_SIDE / Math.max(original.width, original.height));
  const baseScale = Math.min(pixelScale, sideScale);
  const baseWidth = Math.max(1, Math.floor(original.width * baseScale));
  const baseHeight = Math.max(1, Math.floor(original.height * baseScale));

  const scales = [1, 0.75, 0.5, 0.33];
  const qualities = [85, 75, 65, 55, 45, 35];
  let lastError: Error | null = null;

  for (const scale of scales) {
    const width = Math.max(1, Math.floor(baseWidth * scale));
    const height = Math.max(1, Math.floor(baseHeight * scale));
    for (const quality of qualities) {
      try {
        const output = await sharp(Buffer.from(bytes))
          .rotate()
          .resize({ width, height, fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality, mozjpeg: true })
          .toBuffer();
        const info = probeImage(output, { maxBytes, maxPixels });
        return { ...info, data: output, normalized: true, original };
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
  }

  throw lastError ?? new Error("image paste: image too large after downscaling");
}

export async function renderImageAsAnsiForTui(
  bytes: Uint8Array,
  options: TuiImageAnsiOptions = {}
): Promise<TuiImageAnsiResult> {
  const image = await normalizeImageForModel(bytes, options);
  const sharp = await loadSharp();
  if (!sharp) throw new Error("image render: sharp is unavailable for raw pixel extraction");

  const decoded = await sharp(Buffer.from(image.data)).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rawWidth = decoded.info.width;
  const rawHeight = decoded.info.height;
  const columns = uint32(options.columns ?? Math.min(DEFAULT_RENDER_COLUMNS, rawWidth), "image render: invalid columns");
  const defaultRows = Math.max(1, Math.round(columns * (rawHeight / Math.max(1, rawWidth)) * 0.5));
  const rows = uint32(options.rows ?? defaultRows, "image render: invalid rows");
  const rendered = renderRawRgbaToAnsi(decoded.data, {
    width: rawWidth,
    height: rawHeight,
    stride: rawWidth * 4,
    columns,
    rows,
    invert: options.invert,
  });

  return { ...rendered, image, rawWidth, rawHeight };
}

type SharpPipeline = {
  rotate: () => SharpPipeline;
  resize: (options: { width: number; height: number; fit: "inside"; withoutEnlargement: boolean }) => SharpPipeline;
  flatten: (options: { background: string }) => SharpPipeline;
  ensureAlpha: () => SharpPipeline;
  raw: () => SharpPipeline;
  jpeg: (options: { quality: number; mozjpeg: boolean }) => SharpPipeline;
  toBuffer: {
    (): Promise<Buffer>;
    (options: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }>;
  };
};

type SharpFactory = (input?: Buffer | Uint8Array) => SharpPipeline;

async function loadSharp(): Promise<SharpFactory | null> {
  try {
    const mod = await import("sharp");
    return ((mod as unknown as { default?: SharpFactory }).default ?? mod) as SharpFactory;
  } catch {
    return null;
  }
}

function probeImageFallback(bytes: Uint8Array, maxBytes: number, maxPixels: number): ImageProbeResult {
  if (!bytes.byteLength) throw new Error("image paste: empty image payload");
  if (maxBytes > 0 && bytes.byteLength > maxBytes) throw new Error(statusMessage(STATUS_TOO_LARGE));

  const info = parsePng(bytes) ?? parseJpeg(bytes) ?? parseGif(bytes) ?? parseWebp(bytes) ?? parseBmp(bytes);
  if (!info) throw new Error(statusMessage(STATUS_UNSUPPORTED));
  if (!info.width || !info.height) throw new Error(statusMessage(STATUS_MALFORMED));
  if (maxPixels > 0 && info.width * info.height > maxPixels) throw new Error(statusMessage(STATUS_TOO_LARGE));
  return { ...info, bytes: bytes.byteLength, source: "ts" };
}

function statusMessage(status: number): string {
  switch (status) {
    case STATUS_INVALID_ARGS:
      return "image paste: invalid image payload";
    case STATUS_UNSUPPORTED:
      return "image paste: unsupported image type";
    case STATUS_TOO_LARGE:
      return "image paste: image too large";
    case STATUS_MALFORMED:
      return "image paste: malformed image";
    case STATUS_OUTPUT_TOO_SMALL:
      return "image render: output buffer too small";
    default:
      return `image paste: native status ${status}`;
  }
}

function uint32(value: number, message: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 0xffffffff || Math.floor(value) !== value) throw new Error(message);
  return value;
}

function renderRawRgbaToAnsiFallback(raw: Uint8Array, frame: Required<Pick<RawRgbaFrame, "width" | "height" | "stride" | "columns" | "rows">> & Pick<RawRgbaFrame, "invert">): string {
  let ansi = "";
  for (let row = 0; row < frame.rows; row += 1) {
    for (let col = 0; col < frame.columns; col += 1) {
      ansi += densityGlyph(averageCellLuma(raw, frame, col, row), frame.invert === true);
    }
    ansi += "\n";
  }
  return ansi;
}

function averageCellLuma(raw: Uint8Array, frame: Required<Pick<RawRgbaFrame, "width" | "height" | "stride" | "columns" | "rows">>, col: number, row: number): number {
  let x0 = Math.floor((col * frame.width) / frame.columns);
  let x1 = Math.floor(((col + 1) * frame.width) / frame.columns);
  let y0 = Math.floor((row * frame.height) / frame.rows);
  let y1 = Math.floor(((row + 1) * frame.height) / frame.rows);
  if (x1 <= x0) x1 = Math.min(frame.width, x0 + 1);
  if (y1 <= y0) y1 = Math.min(frame.height, y0 + 1);
  x0 = Math.min(x0, frame.width - 1);
  y0 = Math.min(y0, frame.height - 1);

  let total = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = y * frame.stride + x * 4;
      const luma = Math.floor((299 * raw[offset] + 587 * raw[offset + 1] + 114 * raw[offset + 2]) / 1000);
      total += Math.floor((luma * raw[offset + 3]) / 255);
      count += 1;
    }
  }
  return count > 0 ? Math.floor(total / count) : 0;
}

function densityGlyph(luma: number, invert: boolean): string {
  const tone = invert ? 255 - Math.min(luma, 255) : Math.min(luma, 255);
  const index = Math.floor((tone * (DENSITY_RAMP.length - 1) + 127) / 255);
  return DENSITY_RAMP[index];
}

function eqAscii(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.byteLength) return false;
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

function be16(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function be32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function le16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function le24(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
}

function le32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

function parsePng(bytes: Uint8Array) {
  if (bytes.byteLength < 24) return null;
  if (bytes[0] !== 0x89 || !eqAscii(bytes, 1, "PNG\r\n\x1a\n") || !eqAscii(bytes, 12, "IHDR")) return null;
  return { mime: "image/png", width: be32(bytes, 16), height: be32(bytes, 20) };
}

function parseGif(bytes: Uint8Array) {
  if (bytes.byteLength < 10 || (!eqAscii(bytes, 0, "GIF87a") && !eqAscii(bytes, 0, "GIF89a"))) return null;
  return { mime: "image/gif", width: le16(bytes, 6), height: le16(bytes, 8) };
}

function parseBmp(bytes: Uint8Array) {
  if (bytes.byteLength < 26 || !eqAscii(bytes, 0, "BM")) return null;
  return { mime: "image/bmp", width: le32(bytes, 18), height: le32(bytes, 22) };
}

function parseJpeg(bytes: Uint8Array) {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < bytes.byteLength) {
    while (i < bytes.byteLength && bytes[i] !== 0xff) i++;
    while (i < bytes.byteLength && bytes[i] === 0xff) i++;
    if (i >= bytes.byteLength) return null;
    const marker = bytes[i++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 2 > bytes.byteLength) return null;
    const len = be16(bytes, i);
    if (len < 2 || i + len > bytes.byteLength) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (len < 7) return null;
      return { mime: "image/jpeg", width: be16(bytes, i + 5), height: be16(bytes, i + 3) };
    }
    i += len;
  }
  return null;
}

function parseWebp(bytes: Uint8Array) {
  if (bytes.byteLength < 30 || !eqAscii(bytes, 0, "RIFF") || !eqAscii(bytes, 8, "WEBP")) return null;
  let i = 12;
  while (i + 8 <= bytes.byteLength) {
    const size = le32(bytes, i + 4);
    const data = i + 8;
    if (data + size > bytes.byteLength) return null;
    if (eqAscii(bytes, i, "VP8X") && size >= 10) {
      return { mime: "image/webp", width: le24(bytes, data + 4) + 1, height: le24(bytes, data + 7) + 1 };
    }
    if (eqAscii(bytes, i, "VP8 ") && size >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
      return { mime: "image/webp", width: le16(bytes, data + 6) & 0x3fff, height: le16(bytes, data + 8) & 0x3fff };
    }
    if (eqAscii(bytes, i, "VP8L") && size >= 5 && bytes[data] === 0x2f) {
      const b0 = bytes[data + 1], b1 = bytes[data + 2], b2 = bytes[data + 3], b3 = bytes[data + 4];
      return { mime: "image/webp", width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + ((b3 << 6) | (b2 >> 2) | ((b1 & 0xc0) << 6)) };
    }
    i = data + size + (size & 1);
  }
  return null;
}

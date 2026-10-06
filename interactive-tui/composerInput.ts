/**
 * Composer input shapes and the pure helpers the TUI uses to build chat
 * input from typed text, pasted text and image attachments.
 */
import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { ChatInput, ChatInputPart } from "./controlClient";
import type { PasteAnalysis } from "./composerPolicy";

export type PasteTextAttachment = { type: "text"; id: number; label: string; text: string; analysis: PasteAnalysis };
export type ImageAttachment = {
  type: "image";
  id: number;
  label: string;
  mime: string;
  dataUrl: string;
  bytes: number;
  width: number;
  height: number;
  source: string;
  validatedBy: "zig" | "ts";
};
export type ComposerAttachment = PasteTextAttachment | ImageAttachment;
export type QueuedPrompt = { sendInput: ChatInput; displayText: string; shellCommand?: string };

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export function appendTextPart(parts: ChatInputPart[], text: string) {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last?.type === "text") last.text += text;
  else parts.push({ type: "text", text });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatContextTokens(tokens: number): string {
  if (tokens < 1000) return `~${tokens} ctx`;
  return `~${(tokens / 1000).toFixed(1)}k ctx`;
}

export function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

export function imageMimeFromPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      return "image/png";
  }
}

export function imagePathFromPastedText(text: string): string | null {
  const trimmed = text.trim().replace(/^file:\/\//, "");
  if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) return null;
  if (!IMAGE_EXTENSIONS.has(extname(trimmed).toLowerCase())) return null;
  try {
    if (!existsSync(trimmed)) return null;
    const stat = statSync(trimmed);
    return stat.isFile() ? trimmed : null;
  } catch {
    return null;
  }
}

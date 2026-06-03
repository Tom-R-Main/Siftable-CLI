/**
 * Clipboard helpers for the interactive TUI.
 *
 * Pattern lifted from MIT-licensed opencode:
 *   packages/opencode/src/cli/cmd/tui/util/clipboard.ts
 *
 * Writes OSC52 first so terminals/tmux/SSH can copy locally, then falls back to
 * native platform clipboard commands.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ClipboardContent {
  data: string;
  mime: string;
}

function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) return;
  const base64 = Buffer.from(text).toString("base64");
  const osc52 = `\x1b]52;c;${base64}\x07`;
  const passthrough = process.env.TMUX || process.env.STY;
  const sequence = passthrough ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52;
  process.stdout.write(sequence);
}

function writeWithStdin(cmd: string[], text: string): boolean {
  try {
    const proc = spawnSync(cmd[0], cmd.slice(1), { input: text, encoding: "utf8" });
    return proc.status === 0;
  } catch {
    return false;
  }
}

function writeMacOsascript(text: string): boolean {
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    const proc = spawnSync("osascript", ["-e", `set the clipboard to "${escaped}"`], { encoding: "utf8" });
    return proc.status === 0;
  } catch {
    return false;
  }
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  writeOsc52(text);

  if (process.platform === "darwin") {
    return writeWithStdin(["pbcopy"], text) || writeMacOsascript(text);
  }

  if (process.platform === "win32") {
    return writeWithStdin(
      [
        "powershell.exe",
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
      ],
      text
    );
  }

  return (
    writeWithStdin(["wl-copy"], text) ||
    writeWithStdin(["xclip", "-selection", "clipboard"], text) ||
    writeWithStdin(["xsel", "--clipboard", "--input"], text)
  );
}

export async function readClipboardContent(): Promise<ClipboardContent | undefined> {
  const image = readClipboardImage();
  if (image) return image;
  const text = readClipboardText();
  return text ? { data: text, mime: "text/plain" } : undefined;
}

function readClipboardImage(): ClipboardContent | undefined {
  if (process.platform === "darwin") return readMacClipboardImage();
  if (process.platform === "win32" || process.env.WSL_DISTRO_NAME) return readWindowsClipboardImage();
  return readLinuxClipboardImage();
}

function readMacClipboardImage(): ClipboardContent | undefined {
  const dir = mkdtempSync(join(tmpdir(), "sift-clipboard-"));
  const path = join(dir, "clipboard.png");
  try {
    const proc = spawnSync(
      "osascript",
      [
        "-e",
        'set imageData to the clipboard as "PNGf"',
        "-e",
        `set fileRef to open for access POSIX file "${path}" with write permission`,
        "-e",
        "set eof fileRef to 0",
        "-e",
        "write imageData to fileRef",
        "-e",
        "close access fileRef",
      ],
      { encoding: "utf8" }
    );
    if (proc.status !== 0) return undefined;
    const bytes = readFileSync(path);
    if (!bytes.length) return undefined;
    return { data: bytes.toString("base64"), mime: "image/png" };
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readWindowsClipboardImage(): ClipboardContent | undefined {
  try {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }";
    const proc = spawnSync("powershell.exe", ["-NonInteractive", "-NoProfile", "-Command", script], {
      encoding: "utf8",
    });
    const base64 = proc.stdout?.trim();
    if (proc.status !== 0 || !base64) return undefined;
    const bytes = Buffer.from(base64, "base64");
    return bytes.length ? { data: bytes.toString("base64"), mime: "image/png" } : undefined;
  } catch {
    return undefined;
  }
}

function readLinuxClipboardImage(): ClipboardContent | undefined {
  for (const cmd of [
    ["wl-paste", "-t", "image/png"],
    ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
  ]) {
    try {
      const proc = spawnSync(cmd[0], cmd.slice(1));
      if (proc.status === 0 && proc.stdout?.byteLength) {
        return { data: Buffer.from(proc.stdout).toString("base64"), mime: "image/png" };
      }
    } catch {
      /* try next clipboard backend */
    }
  }
  return undefined;
}

function readClipboardText(): string | undefined {
  try {
    if (process.platform === "darwin") {
      const proc = spawnSync("pbpaste", [], { encoding: "utf8" });
      return proc.status === 0 ? proc.stdout : undefined;
    }
    if (process.platform === "win32") {
      const proc = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard"], { encoding: "utf8" });
      return proc.status === 0 ? proc.stdout : undefined;
    }
    for (const cmd of [
      ["wl-paste", "-n"],
      ["xclip", "-selection", "clipboard", "-o"],
      ["xsel", "--clipboard", "--output"],
    ]) {
      const proc = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
      if (proc.status === 0 && proc.stdout) return proc.stdout;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

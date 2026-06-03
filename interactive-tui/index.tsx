/**
 * sift interactive — terminal copilot TUI on @opentui/solid.
 *
 * Fine-grained Solid reactivity (only changed nodes redraw → no flicker) +
 * native <markdown streaming>. A0 runs the OpenFunction brain IN-PROCESS via
 * LocalControlClient (selected by SIFT_LOCAL_BRAIN); the daemon HTTP/SSE
 * ControlClient path is retained for the future hostless mode. Both transports
 * implement ControlTransport, so the UI below is transport-agnostic.
 *
 * QoL layer (agent-CLI muscle memory — readline + chat + command palette):
 *   Esc            stop the in-flight response (pause); when idle, clear draft
 *   Ctrl+C         interrupt / clear draft / quit when idle
 *   ^⇧C            copy latest response   paste directly / bracketed paste
 *   Ctrl+A/E       line start / end       ←/→  char     Home/End  line ends
 *   Ctrl+U/K       kill to start / end    Ctrl+W  delete word     ⌥←/→  word
 *   ↑/↓            prompt history         Shift+Enter  newline
 *   /              command palette (Tab-complete)   @  (todo) entity ref
 *   !cmd           run a shell command, drop output into the transcript
 *   Enter while busy → queue the message; it runs when the turn finishes
 *
 * Launched by the oclif `sift interactive` command, which resolves the token
 * and sets SIFT_LOCAL_BRAIN=1 + SIFT_PAT/SIFT_API_URL + EXECUTERM_OPENFUNCTION_PATH.
 */
import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { SyntaxStyle, type KeyEvent, type PasteEvent, type TextareaRenderable } from "@opentui/core";
import { createSignal, For, Show, Switch, Match, onMount, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import {
  ControlClient,
  eventTextDelta,
  doneFallbackText,
  type ChatInput,
  type ChatInputPart,
  type ControlTransport,
  type RunningAgent,
  type SseEvent,
} from "./controlClient";
import { LocalControlClient } from "./localControlClient";
import { copyTextToClipboard, readClipboardContent } from "./clipboard";
import { analyzePaste, type PasteAnalysis } from "./composerPolicy";
import { normalizeImageForModel } from "./imageEngine";
import { serializeConversation } from "./transcript";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

const theme = {
  bg: "#000000",
  bgMuted: "#070707",
  border: "#2F2F2F",
  text: "#F5F5F5",
  muted: "#9CA3AF",
  accent: "#1D9BF0",
  accentStrong: "#5CB9FF",
  user: "#8DDDB6",
  shell: "#C7A0FF",
  tool: "#7FA8C9",
  transcriptSelection: "#13283A",
};

/** Pull a salient arg out of a tool call for a one-line narration. */
function toolArgPreview(args?: Record<string, unknown>): string {
  if (!args) return "";
  const keys = ["path", "file", "query", "command", "cmd", "title", "id", "name"];
  const pick = (v: unknown) => (typeof v === "string" && v ? v : "");
  for (const k of keys) {
    const v = pick(args[k]);
    if (v) return `${k}=${v.length > 44 ? v.slice(0, 44) + "…" : v}`;
  }
  const first = Object.entries(args)[0];
  if (first && typeof first[1] === "string") return `${first[0]}=${String(first[1]).slice(0, 44)}`;
  return "";
}

// Minimal SyntaxStyle (code-block coloring); markdown structure parses regardless.
const syntaxStyle = SyntaxStyle.fromTheme([]);

// ── Transport seam ─────────────────────────────────────────────────────────
// The ONLY place that differs between in-process (A0) and daemon (future)
// modes. SIFT_LOCAL_BRAIN ⇒ run the OpenFunction brain in this process.
const LOCAL = Boolean(process.env.SIFT_LOCAL_BRAIN);
let baseUrl: string;
let client: ControlTransport;
if (LOCAL) {
  client = new LocalControlClient();
  baseUrl = "in-process (local brain)";
} else {
  baseUrl = (
    process.env.EXECUTERM_CONTROL_URL ||
    (process.env.EXECUTERM_DAEMON_PORT
      ? `http://127.0.0.1:${process.env.EXECUTERM_DAEMON_PORT}`
      : "")
  ).replace(/\/$/, "");
  if (!baseUrl) {
    console.error("Set SIFT_LOCAL_BRAIN=1 (local) or EXECUTERM_CONTROL_URL (daemon).");
    process.exit(1);
  }
  client = new ControlClient(baseUrl, process.env.EXECUTERM_DASHBOARD_TOKEN);
}

type Msg = { role: "you" | "assistant" | "system" | "shell" | "tool"; text: string };
type PasteTextAttachment = { type: "text"; id: number; label: string; text: string; analysis: PasteAnalysis };
type ImageAttachment = {
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
type ComposerAttachment = PasteTextAttachment | ImageAttachment;
type QueuedPrompt = { sendInput: ChatInput; displayText: string };

const COMMANDS = [
  { name: "help", desc: "show commands" },
  { name: "hotkeys", desc: "show keyboard shortcuts" },
  { name: "status", desc: "model, cwd, agents, auth" },
  { name: "copy", desc: "copy response/transcript — /copy [last|all]" },
  { name: "clear", desc: "clear the conversation" },
  { name: "model", desc: "switch model — /model <id>" },
  { name: "login", desc: "log in to Siftable (opens browser)" },
  { name: "key", desc: "add a model provider key — /key <provider> <key>" },
  { name: "quit", desc: "exit" },
];

const HOTKEYS = [
  "Esc            stop the response · clear the draft when idle",
  "^C             interrupt · clear draft · quit when idle",
  "^⇧C            copy the latest assistant response",
  "⌘A             select composer; empty draft selects transcript (terminal may eat ⌘A)",
  "/copy all      copy the whole transcript — works in any terminal",
  "^D             quit when the draft is empty",
  "←/→  ^A/^E     move by char · line start/end      Home/End",
  "^U / ^K        delete to line start / end",
  "^W  ⌥←/⌥→      delete word · move by word",
  "↑/↓            prompt history       Shift+Enter  newline",
  "/  Tab         command palette · complete",
  "/copy all       copy the full transcript",
  "!cmd           run a shell command into the transcript",
  "Enter (busy)   queue the message; runs when the turn finishes",
].join("\n");

const WORD = /\w/;
const MAX_COMPOSER_LINES = 12;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

function appendTextPart(parts: ChatInputPart[], text: string) {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last?.type === "text") last.text += text;
  else parts.push({ type: "text", text });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function imageMimeFromPath(path: string): string {
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

function imagePathFromPastedText(text: string): string | null {
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

function App() {
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const [messages, setMessages] = createStore<Msg[]>([
    {
      role: "system",
      text: "sift interactive — ask about your work · type / for commands · ? or /hotkeys for keys · /quit to exit",
    },
  ]);
  const [input, setInput] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  const [status, setStatus] = createSignal("connecting…");
  const [agents, setAgents] = createSignal<RunningAgent[]>([]);
  const [model, setModel] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [queued, setQueued] = createSignal<QueuedPrompt[]>([]);
  const [awaitingLogin, setAwaitingLogin] = createSignal(false);
  const [slashSel, setSlashSel] = createSignal(0);
  const [transcriptSelected, setTranscriptSelected] = createSignal(false);

  let abortController: AbortController | null = null;
  let inputRef: TextareaRenderable | null = null;
  const history: string[] = [];
  const attachments = new Map<string, ComposerAttachment>();
  let attachmentSeq = 0;
  let histIndex = 0;

  const push = (m: Msg) => setMessages(messages.length, m);
  const quit = () => {
    if (!renderer.isDestroyed) renderer.destroy();
  };

  const pasteChipLabel = (attachment: Omit<PasteTextAttachment, "label">) =>
    `[pasted text #${attachment.id} · ${attachment.analysis.chars} chars · ${attachment.analysis.lines} lines]`;

  const imageChipLabel = (attachment: Omit<ImageAttachment, "label">) =>
    `[Image ${attachment.id} · ${attachment.mime.replace(/^image\//, "")} · ${attachment.width}×${attachment.height} · ${formatBytes(attachment.bytes)}]`;

  const buildChatInput = (text: string): ChatInput => {
    const parts: ChatInputPart[] = [];
    let i = 0;
    while (i < text.length) {
      let nextLabel = "";
      let nextAt = -1;
      for (const label of attachments.keys()) {
        const at = text.indexOf(label, i);
        if (at >= 0 && (nextAt < 0 || at < nextAt)) {
          nextAt = at;
          nextLabel = label;
        }
      }
      if (nextAt < 0) {
        appendTextPart(parts, text.slice(i));
        break;
      }
      appendTextPart(parts, text.slice(i, nextAt));
      const attachment = attachments.get(nextLabel);
      if (attachment?.type === "text") {
        appendTextPart(
          parts,
          `<pasted_text id="${attachment.id}" chars="${attachment.analysis.chars}" lines="${attachment.analysis.lines}">\n${attachment.text}\n</pasted_text>`
        );
      } else if (attachment?.type === "image") {
        appendTextPart(
          parts,
          `<image id="${attachment.id}" source="${attachment.source}" mime="${attachment.mime}" width="${attachment.width}" height="${attachment.height}">`
        );
        parts.push({ type: "image", mime: attachment.mime, dataUrl: attachment.dataUrl, detail: "auto" });
        appendTextPart(parts, `</image>`);
      } else {
        appendTextPart(parts, nextLabel);
      }
      i = nextAt + nextLabel.length;
    }
    if (!parts.some((p) => p.type === "image")) return parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return parts.filter((p) => p.type !== "text" || p.text.length > 0);
  };

  const clearUsedPasteChips = (text: string) => {
    for (const attachment of attachments.values()) {
      if (text.includes(attachment.label)) attachments.delete(attachment.label);
    }
  };

  const attachImage = async (input: { mime: string; data: string; source: string }) => {
    if (!inputRef) return;
    const bytes = Buffer.from(input.data, "base64");
    const info = await normalizeImageForModel(bytes);
    const attachmentBase = {
      type: "image" as const,
      id: ++attachmentSeq,
      mime: info.mime,
      dataUrl: `data:${info.mime};base64,${Buffer.from(info.data).toString("base64")}`,
      bytes: info.bytes,
      width: info.width,
      height: info.height,
      source: input.source,
      validatedBy: info.source,
    };
    const label = imageChipLabel(attachmentBase);
    attachments.set(label, { ...attachmentBase, label });
    inputRef.insertText(`${label} `);
    setStatus(
      `image ${info.normalized ? "downscaled and attached" : "attached"} (${attachmentBase.mime}, ${attachmentBase.width}×${attachmentBase.height}, ${formatBytes(attachmentBase.bytes)}, ${attachmentBase.validatedBy})`
    );
  };

  const tryAttachImage = async (input: { mime: string; data: string; source: string }) => {
    try {
      await attachImage(input);
      return true;
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const attachImagePath = async (path: string) => {
    const mime = imageMimeFromPath(path);
    const bytes = readFileSync(path);
    return tryAttachImage({ mime, data: bytes.toString("base64"), source: basename(path) });
  };

  // --- input model (text + cursor) -----------------------------------------
  const setText = (next: string, cur?: number) => {
    setTranscriptSelected(false);
    setInput(next);
    const nextCursor = Math.max(0, Math.min(cur ?? next.length, next.length));
    setCursor(nextCursor);
    setSlashSel(0); // any edit resets the slash-menu highlight to the top match
    if (inputRef && inputRef.plainText !== next) {
      inputRef.editBuffer.setText(next);
      inputRef.cursorOffset = nextCursor;
    }
  };
  const insert = (s: string) => {
    if (inputRef) {
      inputRef.insertText(s);
      setInput(inputRef.plainText);
      setCursor(inputRef.cursorOffset);
    } else {
      const t = input();
      const c = cursor();
      setText(t.slice(0, c) + s + t.slice(c), c + s.length);
    }
  };
  const backspace = () => {
    const t = input();
    const c = cursor();
    if (c > 0) setText(t.slice(0, c - 1) + t.slice(c), c - 1);
  };
  const delForward = () => {
    const t = input();
    const c = cursor();
    if (c < t.length) setText(t.slice(0, c) + t.slice(c + 1), c);
  };
  const killToStart = () => setText(input().slice(cursor()), 0);
  const killToEnd = () => setText(input().slice(0, cursor()), cursor());
  const wordStart = (t: string, c: number) => {
    let i = c;
    while (i > 0 && !WORD.test(t[i - 1])) i--;
    while (i > 0 && WORD.test(t[i - 1])) i--;
    return i;
  };
  const wordEnd = (t: string, c: number) => {
    let i = c;
    while (i < t.length && !WORD.test(t[i])) i++;
    while (i < t.length && WORD.test(t[i])) i++;
    return i;
  };
  const deleteWordBack = () => {
    const t = input();
    const c = cursor();
    const i = wordStart(t, c);
    setText(t.slice(0, i) + t.slice(c), i);
  };

  const latestAssistantText = () => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].text.trim()) return messages[i].text.trim();
    }
    return "";
  };
  // Single source of truth for "copy the conversation": only you↔siftable
  // turns, never system/shell/tool chrome. Serialized from the message objects,
  // not rendered cells. See transcript.ts + interactive.transcript.test.ts.
  const conversationText = () => serializeConversation(messages);

  async function copyText(text: string): Promise<string> {
    if (!text.trim()) return "nothing to copy yet.";
    return (await copyTextToClipboard(text)) ? `copied ${text.length} chars.` : "copy failed: no clipboard command available.";
  }

  async function copyLatestAssistant(): Promise<void> {
    push({ role: "system", text: await copyText(latestAssistantText()) });
  }

  async function copyCurrentSelection(): Promise<boolean> {
    if (transcriptSelected()) {
      const text = conversationText();
      if (!text) return false;
      const ok = await copyTextToClipboard(text);
      setStatus(ok ? `copied ${text.length} transcript chars` : "copy failed");
      return ok;
    }
    const text = renderer.getSelection()?.getSelectedText().trim() ?? "";
    if (!text) return false;
    const ok = await copyTextToClipboard(text);
    setStatus(ok ? `copied ${text.length} selected chars` : "copy failed");
    return ok;
  }

  function selectAllForContext() {
    renderer.clearSelection();
    if (inputRef?.plainText) {
      inputRef.selectAll();
      setTranscriptSelected(false);
      setStatus(`selected ${inputRef.plainText.length} composer chars`);
      return;
    }

    const text = conversationText();
    if (!text) {
      setStatus("nothing to select yet");
      return;
    }
    setTranscriptSelected(true);
    setStatus(`selected transcript (${text.length} chars)`);
  }

  // Slash-command suggestions: show + filter while typing the command name.
  const slashMatches = () => {
    const v = input();
    if (!v.startsWith("/") || v.includes(" ")) return [];
    const q = v.slice(1).toLowerCase();
    return COMMANDS.filter((c) => c.name.startsWith(q));
  };
  const slashSelClamped = () => Math.min(slashSel(), Math.max(0, slashMatches().length - 1));

  async function refreshState() {
    try {
      const s = await client.state();
      setAgents(s.context?.runningAgents ?? []);
      if (s.model?.model) setModel(s.model.model);
      if (awaitingLogin() && s.authStatus === "authenticated") {
        setAwaitingLogin(false);
        push({ role: "system", text: "✓ Logged in to Siftable." });
      }
      if (!busy()) {
        // Degraded states are first-class: surface unauth distinctly from ready.
        if (s.authStatus === "unauthenticated") setStatus("not signed in — run `sift auth login`");
        else setStatus("ready");
      }
    } catch {
      setStatus(LOCAL ? "brain unavailable" : "daemon unreachable");
    }
  }

  // --- Enter dispatch: slash / shell / queue-while-busy / send --------------
  function onEnter() {
    const text = input().trim();
    if (!text) return;
    setTranscriptSelected(false);
    setText("");
    history.push(text);
    histIndex = history.length;

    if (text.startsWith("/")) {
      void handleSlash(text);
      return;
    }
    if (text.startsWith("!")) {
      void runShell(text.slice(1).trim());
      return;
    }
    if (busy()) {
      setQueued((q) => [...q, { sendInput: buildChatInput(text), displayText: text }]);
      clearUsedPasteChips(text);
      push({ role: "system", text: `↳ queued (${queued().length}) — runs when this turn finishes` });
      return;
    }
    const sendInput = buildChatInput(text);
    clearUsedPasteChips(text);
    void submitOne(sendInput, text);
  }

  async function runShell(cmd: string) {
    if (!cmd) return;
    push({ role: "shell", text: `$ ${cmd}` });
    if (typeof Bun === "undefined") {
      push({ role: "system", text: "shell unavailable (no Bun runtime)" });
      return;
    }
    try {
      const proc = Bun.spawnSync(["bash", "-lc", cmd], {
        cwd: process.env.SIFT_USER_CWD || process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = new TextDecoder().decode(proc.stdout).trimEnd();
      const errOut = new TextDecoder().decode(proc.stderr).trimEnd();
      const body = [out, errOut].filter(Boolean).join("\n") || "(no output)";
      const clipped = body.length > 4000 ? body.slice(0, 4000) + "\n… (truncated)" : body;
      push({ role: "shell", text: clipped + (proc.exitCode ? `\n[exit ${proc.exitCode}]` : "") });
    } catch (err) {
      push({ role: "system", text: `shell error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  async function submitOne(input: ChatInput, displayText = typeof input === "string" ? input : input.map((p) => (p.type === "text" ? p.text : "[image]")).join("")) {
    push({ role: "you", text: displayText });
    setBusy(true);
    setStatus("thinking… (Esc to stop)");
    abortController = new AbortController();
    // Lazy assistant bubble: text segments and tool-step lines interleave in
    // event order. A tool call closes the current text bubble so the next text
    // starts a fresh one below the step.
    let assistantIdx: number | null = null;
    let lastToolIdx: number | null = null;
    let got = false;
    let done: SseEvent | null = null;
    const ensureAssistant = () => {
      if (assistantIdx === null) {
        assistantIdx = messages.length;
        push({ role: "assistant", text: "" });
      }
      return assistantIdx;
    };
    try {
      await client.send(
        input,
        (e) => {
          const delta = eventTextDelta(e);
          if (delta) {
            if (!got) setStatus("responding… (Esc to stop)");
            got = true;
            setMessages(ensureAssistant(), "text", (t) => t + delta);
          } else if (e.type === "tool_call" && e.toolCall) {
            const arg = toolArgPreview(e.toolCall.args);
            lastToolIdx = messages.length;
            push({ role: "tool", text: `⚙ ${e.toolCall.name}${arg ? ` ${arg}` : ""}` });
            assistantIdx = null; // next text opens a fresh bubble below this step
            setStatus(`⚙ ${e.toolCall.name}… (Esc to stop)`);
          } else if (e.type === "tool_result") {
            if (lastToolIdx !== null) {
              const ok = e.toolResult?.success !== false;
              setMessages(lastToolIdx, "text", (t) => t.replace(/^⚙/, ok ? "✓" : "✗"));
            }
            setStatus("working… (Esc to stop)");
          } else if (e.type === "error") {
            setMessages(ensureAssistant(), "text", (t) => `${t}\n\n[error: ${e.error ?? "unknown"}]`);
          } else if (e.type === "done") {
            done = e;
          }
        },
        abortController.signal
      );
      if (!got) {
        const fallback = done ? doneFallbackText(done) : "";
        setMessages(ensureAssistant(), "text", fallback || "(no response)");
      }
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      setMessages(ensureAssistant(), "text", (t) =>
        aborted
          ? `${t}${t ? "  " : ""}⏸ paused`
          : `[error: ${err instanceof Error ? err.message : String(err)}]`
      );
    } finally {
      abortController = null;
      setBusy(false);
      setStatus("ready");
      // Drain one queued message, if any.
      const q = queued();
      if (q.length) {
        setQueued(q.slice(1));
        void submitOne(q[0].sendInput, q[0].displayText);
      }
    }
  }

  async function handleSlash(cmd: string) {
    const parts = cmd.slice(1).split(/\s+/);
    const name = parts[0]?.toLowerCase();
    switch (name) {
      case "help":
        push({
          role: "system",
          text: "Commands: /help · /hotkeys · /status · /copy [last|all] · /clear · /model [id] · /login · /key <provider> <key> · /quit\nAlso: !<cmd> runs a shell command · Enter while busy queues a message.",
        });
        break;
      case "hotkeys":
      case "keys":
        push({ role: "system", text: HOTKEYS });
        break;
      case "status": {
        const cwd = process.env.SIFT_USER_CWD || (typeof process !== "undefined" ? process.cwd() : "?");
        const a = agents();
        push({
          role: "system",
          text:
            `model:   ${model() || "(unknown)"}\n` +
            `cwd:     ${cwd}\n` +
            `agents:  ${a.length ? a.map((x) => `${x.assignedAlias ?? x.agentType}·${x.state}`).join(", ") : "none"}\n` +
            `queued:  ${queued().length}\n` +
            `brain:   ${baseUrl}`,
        });
        break;
      }
      case "clear":
        setMessages([{ role: "system", text: "cleared." }]);
        break;
      case "copy": {
        const target = (parts[1] || "last").toLowerCase();
        const text = target === "all" || target === "transcript" ? conversationText() : latestAssistantText();
        push({ role: "system", text: await copyText(text) });
        break;
      }
      case "quit":
      case "exit":
      case "q":
        quit();
        break;
      case "model": {
        const id = parts.slice(1).join(" ").trim();
        if (!id) {
          push({ role: "system", text: `current model: ${model() || "(unknown)"}. Use /model <id> to switch.` });
          break;
        }
        try {
          const result = await client.config({ model: id });
          setModel(result.model);
          push({ role: "system", text: `model → ${result.provider}/${result.model}` });
        } catch (err) {
          push({ role: "system", text: `/model failed: ${err instanceof Error ? err.message : String(err)}` });
        }
        break;
      }
      case "login": {
        try {
          const { verificationUri, userCode } = await client.login();
          setAwaitingLogin(true);
          push({
            role: "system",
            text:
              `Opening your browser to log in to Siftable…\n` +
              `If it doesn't open, visit: ${verificationUri}\n` +
              `Verification code: ${userCode}\n` +
              `I'll confirm here once you're signed in.`,
          });
        } catch (err) {
          push({ role: "system", text: `/login: ${err instanceof Error ? err.message : String(err)}` });
        }
        break;
      }
      case "key": {
        const rest = parts.slice(1);
        if (rest.length >= 2) {
          const provider = rest[0];
          const key = rest.slice(1).join(" ");
          try {
            await client.config({ provider, apiKey: key });
            push({ role: "system", text: `stored ${provider} API key for the model brain.` });
          } catch (err) {
            push({ role: "system", text: `/key failed: ${err instanceof Error ? err.message : String(err)}` });
          }
        } else {
          push({ role: "system", text: "usage: /key <provider> <key>  (e.g. /key openrouter sk-…)" });
        }
        break;
      }
      default:
        push({ role: "system", text: `unknown command: ${cmd}  (try /help)` });
    }
  }

  useKeyboard(
    (key: KeyEvent) => {
      const isCmd = Boolean(key.meta || (key as KeyEvent & { super?: boolean }).super);
      const hasSelection = transcriptSelected() || Boolean(renderer.getSelection()?.getSelectedText().trim());

      // Cmd+A mirrors opencode's composer select-all when the composer has text.
      // With an empty composer, select the conversation payload only, excluding
      // header/footer/chrome. Terminal-level Cmd+A cannot be scoped by the app;
      // this path applies when the terminal forwards the chord to OpenTUI.
      if (isCmd && key.name === "a") {
        key.preventDefault?.();
        key.stopPropagation?.();
        selectAllForContext();
        return;
      }

      // Copy latest response fallback. Ctrl+Shift+C covers Windows/Linux
      // terminal convention; Cmd+C only works in terminals that preserve meta.
      if ((isCmd && key.name === "c") || (key.ctrl && key.shift && key.name === "c")) {
        key.preventDefault?.();
        key.stopPropagation?.();
        if (hasSelection) void copyCurrentSelection();
        else void copyLatestAssistant();
        return;
      }

      // Ctrl+C: Claude Code-style interrupt/clear/exit, never copy.
      if (key.ctrl && key.name === "c") {
        key.preventDefault?.();
        key.stopPropagation?.();
        if (busy() && abortController) {
          abortController.abort();
          setStatus("paused");
        } else if (input()) {
          setText("");
        } else if (transcriptSelected()) {
          setTranscriptSelected(false);
        } else {
          quit();
        }
        return;
      }

      // macOS terminals can drop the Cmd modifier and deliver Cmd+C as a bare
      // printable "c". If a transcript selection exists, treat that as copy and
      // keep the selection visible; otherwise a normal "c" types normally.
      if (hasSelection && key.name === "c" && key.sequence === "c" && !key.ctrl && !key.meta && !key.shift) {
        key.preventDefault?.();
        key.stopPropagation?.();
        void copyCurrentSelection();
        return;
      }
      if (key.ctrl && key.name === "d" && !input()) {
        key.preventDefault?.();
        key.stopPropagation?.();
        quit();
      }

      // Esc: stop the in-flight response; when idle, clear the draft.
      if (key.name === "escape") {
        key.preventDefault?.();
        key.stopPropagation?.();
        if (busy() && abortController) {
          abortController.abort();
          setStatus("paused");
        } else if (input()) {
          setText("");
        } else if (transcriptSelected()) {
          setTranscriptSelected(false);
        }
        return;
      }

      // Slash menu open: ↑/↓ navigate, Enter/Tab fill the selected command.
      const sm = slashMatches();
      if (sm.length) {
        if (key.name === "up") {
          key.preventDefault?.();
          key.stopPropagation?.();
          return setSlashSel((s) => Math.max(0, s - 1));
        }
        if (key.name === "down") {
          key.preventDefault?.();
          key.stopPropagation?.();
          return setSlashSel((s) => Math.min(sm.length - 1, s + 1));
        }
        const isNewlineChord = key.name === "linefeed" || (key.ctrl && (key.name === "j" || key.sequence === "\n"));
        const isEnter =
          !isNewlineChord &&
          (key.name === "return" || key.name === "enter" || key.sequence === "\r" || key.sequence === "\n");
        if ((isEnter && !key.shift) || key.name === "tab") {
          key.preventDefault?.();
          key.stopPropagation?.();
          setText(`/${sm[slashSelClamped()].name} `); // fill input; trailing space closes the menu
          return;
        }
      }

      // Submit / newline. Textarea owns normal editing, but this app owns the
      // chat-submit semantic: Enter sends, Shift+Enter inserts a newline.
      if (key.name === "return" || key.name === "enter" || key.name === "linefeed" || key.sequence === "\r" || key.sequence === "\n") {
        key.preventDefault?.();
        key.stopPropagation?.();
        if (key.shift || key.name === "linefeed" || (key.ctrl && (key.name === "j" || key.sequence === "\n"))) {
          inputRef?.newLine();
          if (inputRef) {
            setInput(inputRef.plainText);
            setCursor(inputRef.cursorOffset);
          }
        } else {
          onEnter();
        }
        return;
      }

      // Slash-completion (no menu, but a lone "/foo" prefix).
      if (key.name === "tab") {
        const m = slashMatches();
        if (m.length) {
          key.preventDefault?.();
          key.stopPropagation?.();
          setText(`/${m[0].name} `);
        }
        return;
      }

      // Prompt history.
      if (key.name === "up" && !input().includes("\n")) {
        if (history.length && histIndex > 0) {
          key.preventDefault?.();
          key.stopPropagation?.();
          histIndex -= 1;
          setText(history[histIndex]);
        }
        return;
      }
      if (key.name === "down" && !input().includes("\n")) {
        if (histIndex < history.length - 1) {
          key.preventDefault?.();
          key.stopPropagation?.();
          histIndex += 1;
          setText(history[histIndex]);
        } else {
          key.preventDefault?.();
          key.stopPropagation?.();
          histIndex = history.length;
          setText("");
        }
        return;
      }

      // `?` on an empty draft = quick hotkeys reference (matches the placeholder hint).
      if (key.sequence === "?" && !input()) {
        key.preventDefault?.();
        key.stopPropagation?.();
        push({ role: "system", text: HOTKEYS });
        return;
      }
    },
    {}
  );

  onMount(() => {
    void refreshState();
    const timer = setInterval(() => void refreshState(), 2000);
    onCleanup(() => clearInterval(timer));
  });

  const agentLabel = () =>
    agents().length
      ? `${agents().length} agent(s): ${agents()
          .map((a) => `${a.assignedAlias ?? a.agentType}·${a.state}`)
          .join("  ")}`
      : "no local agents";

  const composerMaxHeight = () => Math.min(MAX_COMPOSER_LINES, Math.max(4, Math.floor(terminal().height / 3)));

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.bg}>
      <box
        width="100%"
        height={3}
        borderStyle="single"
        borderColor={theme.border}
        backgroundColor={theme.bgMuted}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
      >
        <text fg={theme.accentStrong} selectable={false}>sift interactive</text>
        <text fg={theme.muted} selectable={false}>{agentLabel()}</text>
      </box>

      <scrollbox
        flexGrow={1}
        width="100%"
        paddingLeft={1}
        paddingRight={1}
        stickyScroll={true}
        stickyStart="bottom"
      >
        <For each={messages}>
          {(m) => (
            <box
              flexDirection="column"
              paddingTop={1}
              backgroundColor={transcriptSelected() && m.role !== "system" ? theme.transcriptSelection : theme.bg}
            >
              <Switch>
                <Match when={m.role === "system"}>
                  <text fg={theme.muted} selectable={false}>{m.text}</text>
                </Match>
                <Match when={m.role === "shell"}>
                  <text fg={theme.shell}>{m.text}</text>
                </Match>
                <Match when={m.role === "tool"}>
                  <text fg={theme.tool}>{m.text}</text>
                </Match>
                <Match when={m.role === "you"}>
                  <text fg={theme.user}>you</text>
                  <text fg={theme.text}>{m.text}</text>
                </Match>
                <Match when={m.role === "assistant"}>
                  <text fg={theme.accentStrong}>siftable</text>
                  <markdown
                    content={m.text || "…"}
                    streaming={true}
                    syntaxStyle={syntaxStyle}
                    internalBlockMode="top-level"
                    fg={theme.text}
                    bg={theme.bg}
                  />
                </Match>
              </Switch>
            </box>
          )}
        </For>
      </scrollbox>

      <Show when={slashMatches().length > 0}>
        <box
          flexDirection="column"
          flexShrink={0}
          height={slashMatches().length}
          paddingLeft={2}
          backgroundColor={theme.bgMuted}
        >
          <For each={slashMatches()}>
            {(c, i) => (
              <box
                width="100%"
                height={1}
                backgroundColor={i() === slashSelClamped() ? theme.border : theme.bgMuted}
                flexDirection="row"
              >
                <text fg={i() === slashSelClamped() ? theme.accentStrong : theme.muted} selectable={false}>
                  {`/${c.name}`.padEnd(9) + c.desc + (i() === slashSelClamped() ? "   ↵" : "")}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>

      <box
        width="100%"
        borderStyle="single"
        borderColor={theme.accent}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="row"
        alignItems="flex-start"
        flexShrink={0}
      >
        <text fg={theme.accent} selectable={false}>{busy() ? "… " : "› "}</text>
        <textarea
          width="100%"
          minHeight={1}
          maxHeight={composerMaxHeight()}
          wrapMode="word"
          placeholder="type a message  ( / commands · ! shell · ? keys )"
          placeholderColor={theme.muted}
          textColor={theme.text}
          focusedTextColor={theme.text}
          backgroundColor={theme.bg}
          focusedBackgroundColor={theme.bg}
          cursorColor={theme.accentStrong}
          // Match opencode's input_select_all binding (`super+a`) and support
          // terminals that report Cmd as `meta`; Ctrl+A remains line-start.
          // Also match opencode's input_newline binding:
          // shift+return, ctrl+return, alt+return, ctrl+j.
          // This must live on the focused textarea; otherwise OpenTUI may
          // consume the chord before the app-level useKeyboard handler sees it.
          keyBindings={[
            { name: "a", super: true, action: "select-all" },
            { name: "a", meta: true, action: "select-all" },
            { name: "return", shift: true, action: "newline" },
            { name: "return", ctrl: true, action: "newline" },
            { name: "return", meta: true, action: "newline" },
            { name: "j", ctrl: true, action: "newline" },
            { name: "linefeed", action: "newline" },
          ]}
          onContentChange={() => {
            if (!inputRef) return;
            setTranscriptSelected(false);
            setInput(inputRef.plainText);
            setCursor(inputRef.cursorOffset);
            setSlashSel(0);
          }}
          onCursorChange={() => {
            if (!inputRef) return;
            setCursor(inputRef.cursorOffset);
          }}
          onPaste={async (event: PasteEvent) => {
            let text = new TextDecoder().decode(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            event.preventDefault();
            event.stopPropagation();
            if (!inputRef) return;

            if (!text.trim()) {
              const content = await readClipboardContent();
              if (content?.mime.startsWith("image/")) {
                await tryAttachImage({ mime: content.mime, data: content.data, source: "clipboard" });
                setInput(inputRef.plainText);
                setCursor(inputRef.cursorOffset);
                return;
              }
              if (content?.mime === "text/plain") {
                text = content.data.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
              }
            }
            if (!text) return;

            const imagePath = imagePathFromPastedText(text);
            if (imagePath) {
              await attachImagePath(imagePath);
              setInput(inputRef.plainText);
              setCursor(inputRef.cursorOffset);
              return;
            }

            const remaining = Math.max(0, 8000 - inputRef.plainText.length);
            const analysis = analyzePaste(text);
            if (analysis.decision === "inline") {
              inputRef.insertText(text.slice(0, remaining));
            } else {
              const attachmentBase = { type: "text" as const, id: ++attachmentSeq, text, analysis };
              const label = pasteChipLabel(attachmentBase);
              attachments.set(label, { ...attachmentBase, label });
              inputRef.insertText(label.slice(0, remaining));
              setStatus(`${analysis.source}: pasted as chip (${analysis.chars} chars, ${analysis.lines} lines)`);
            }
            setInput(inputRef.plainText);
            setCursor(inputRef.cursorOffset);
          }}
          ref={(r: TextareaRenderable) => {
            inputRef = r;
            setTimeout(() => {
              if (!inputRef || inputRef.isDestroyed) return;
              inputRef.focus();
            }, 0);
          }}
        />
      </box>

      <box width="100%" height={1} paddingLeft={1} backgroundColor={theme.bgMuted}>
        <text fg={theme.muted} selectable={false}>
          {status() +
            (model() ? `  ·  ${model()}` : "") +
            (queued().length ? `  ·  ${queued().length} queued` : "")}
        </text>
      </box>
    </box>
  );
}

render(() => <App />, {
  exitOnCtrlC: false,
  useMouse: true,
  // Match opencode: ask terminals that support the Kitty keyboard protocol to
  // forward modified chords like Cmd+A/Cmd+C instead of degrading them into
  // terminal-level select-all or bare printable characters.
  useKittyKeyboard: {},
  targetFps: 30,
});

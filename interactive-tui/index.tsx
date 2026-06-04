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
 *   Ctrl+O         show/hide explorer diagnostics
 *   ^⇧C            copy latest response   paste directly / bracketed paste
 *   Ctrl+A/E       line start / end       ←/→  char     Home/End  line ends
 *   Ctrl+U/K       kill to start / end    Ctrl+W  delete word     ⌥←/→  word
 *   ↑/↓            prompt history         Shift+Enter  newline
 *   /              command palette (Tab-complete)   @  (todo) entity ref
 *   !cmd           run a shell command, drop output into the transcript
 *   Enter while busy → queue the message; it runs when the turn finishes
 *
 * Launched by the oclif `sift interactive` command, which resolves the token
 * and sets SIFT_LOCAL_BRAIN=1 + SIFT_PAT/SIFT_API_URL. The OpenFunction runtime
 * used by the local brain is vendored under interactive-tui/openfunction.
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
import {SiftClient} from "@siftable/mcp-server/dist/exfClient.js";
import {
  applyModelChoice,
  applyExplorerSettings,
  commandSuggestions,
  DEFAULT_EXPLORER_SETTINGS,
  EXPLORER_BUDGET_CHOICES,
  EXPLORER_MODE_CHOICES,
  explorerModelChoices,
  explorerSettingsSummary,
  runInteractiveCommand,
  INTERACTIVE_MODEL_CHOICES,
  type CommandMessage,
  type ExplorerSettings,
} from "./commands";
import { copyTextToClipboard, readClipboardContent } from "./clipboard";
import { analyzePaste, type PasteAnalysis } from "./composerPolicy";
import { setConfirmListener, resolveApproval, type ConfirmRequest, type ApprovalDecision } from "./confirmGate";
import { normalizeImageForModel } from "./imageEngine";
import {
  asExplorerActivityView,
  explorerToolCallText,
  formatExplorerActivityDetails,
  formatExplorerActivityLine,
  isExplorerToolName,
  toolCallLabel,
  clipOutput,
  gutterIndent,
} from "./toolView";
import { serializeConversation } from "./transcript";
import { getSessionCwd, getWorkspaceRoot, setSessionCwd } from "./navigation";
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

// Minimal SyntaxStyle (code-block coloring); markdown structure parses regardless.
const syntaxStyle = SyntaxStyle.fromTheme([]);

// ── Transport seam ─────────────────────────────────────────────────────────
// The ONLY place that differs between in-process (A0) and daemon (future)
// modes. SIFT_LOCAL_BRAIN ⇒ run the OpenFunction brain in this process.
const LOCAL = Boolean(process.env.SIFT_LOCAL_BRAIN);
let baseUrl: string;
let client: ControlTransport;
const apiClient = new SiftClient({
  apiUrl: process.env.SIFT_API_URL || process.env.EXF_API_URL || "https://siftable.io",
  pat: process.env.SIFT_PAT || process.env.EXF_PAT || process.env.SIFT_TOKEN || process.env.EXF_TOKEN || "",
  workspaceId: process.env.SIFT_WORKSPACE_ID || process.env.EXF_WORKSPACE_ID,
});
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

type Msg = {
  role: "you" | "assistant" | "system" | "shell" | "tool";
  text: string;
  out?: string;
  explorer?: boolean;
};
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

const COMMANDS = commandSuggestions();
const SLASH_COMMAND_COLUMN_WIDTH = Math.max(14, ...COMMANDS.map((command) => command.name.length + 5));

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

function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
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
  const [effort, setEffort] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [queued, setQueued] = createSignal<QueuedPrompt[]>([]);
  const [awaitingLogin, setAwaitingLogin] = createSignal(false);
  const [showExplorerDetails, setShowExplorerDetails] = createSignal(false);
  const [explorerSettings, setExplorerSettings] = createSignal<ExplorerSettings>({...DEFAULT_EXPLORER_SETTINGS});
  const [slashSel, setSlashSel] = createSignal(0);
  // Interactive model picker: stage "model" (↑/↓) → stage "effort" (←/→).
  const [picker, setPicker] = createSignal<
    { stage: "model" | "effort"; modelIdx: number; effortIdx: number } | null
  >(null);
  const [explorerPicker, setExplorerPicker] = createSignal<
    { stage: "menu" | "mode" | "model" | "budget"; rowIdx: number; modeIdx: number; modelIdx: number; budgetIdx: number } | null
  >(null);
  const [transcriptSelected, setTranscriptSelected] = createSignal(false);
  // A1 write/edit approval: set by the confirm gate while a mutation waits.
  const [confirm, setConfirm] = createSignal<ConfirmRequest | null>(null);

  let abortController: AbortController | null = null;
  let inputRef: TextareaRenderable | null = null;
  let latestExplorerReport = "";
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

  async function copyLatestExplorerReport(): Promise<void> {
    if (!latestExplorerReport) {
      setStatus("no explorer report to copy yet");
      return;
    }
    setStatus(await copyText(latestExplorerReport));
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
      setEffort(s.model?.effort ?? "");
      if (awaitingLogin() && s.authStatus === "authenticated") {
        setAwaitingLogin(false);
        push({ role: "system", text: "✓ Logged in to Siftable." });
      }
      if (!busy()) {
        // Degraded states are first-class: surface unauth distinctly from ready.
        if (s.authStatus === "unauthenticated") {
          setStatus(
            s.model?.provider === "codex"
              ? "not signed in to Codex — run `/codex login`"
              : "not signed in — run `sift auth login`",
          );
        } else setStatus("ready");
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
    const cdMatch = cmd.trim().match(/^cd(?:\s+(.+))?$/);
    if (cdMatch) {
      try {
        const result = setSessionCwd((cdMatch[1] || process.env.HOME || ".").trim());
        push({ role: "shell", text: `workdir → ${result.cwd}\nworkspace → ${result.workspaceRoot}` });
      } catch (err) {
        push({ role: "system", text: `cd error: ${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }
    if (typeof Bun === "undefined") {
      push({ role: "system", text: "shell unavailable (no Bun runtime)" });
      return;
    }
    try {
      const proc = Bun.spawnSync(["bash", "-lc", cmd], {
        cwd: getSessionCwd(),
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
    const toolIndexes = new Map<string, number[]>();
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
            const label = toolCallLabel(e.toolCall.detail, e.toolCall.args);
            const text = isExplorerToolName(e.toolCall.name)
              ? explorerToolCallText(e.toolCall.name, e.toolCall.detail)
              : `⚙ ${e.toolCall.name}${label ? `  ${label}` : ""}`;
            lastToolIdx = messages.length;
            const indexes = toolIndexes.get(e.toolCall.name) ?? [];
            indexes.push(lastToolIdx);
            toolIndexes.set(e.toolCall.name, indexes);
            push({ role: "tool", text });
            assistantIdx = null; // next text opens a fresh bubble below this step
            setStatus(`⚙ ${e.toolCall.name}… (Esc to stop)`);
          } else if (e.type === "tool_result") {
            const name = e.toolResult?.name ?? "";
            const matchingIndexes = toolIndexes.get(name);
            const toolIdx = matchingIndexes?.length ? matchingIndexes[matchingIndexes.length - 1] : lastToolIdx;
            if (toolIdx !== null && toolIdx !== undefined) {
              const ok = e.toolResult?.success !== false;
              const activity = asExplorerActivityView(e.toolResult?.explorerActivity);
              if (activity) {
                setMessages(toolIdx, "text", `${ok ? "✓" : "✗"} ${formatExplorerActivityLine(activity)}`);
                setMessages(toolIdx, "out", formatExplorerActivityDetails(activity));
                setMessages(toolIdx, "explorer", true);
                if (activity.rawReport) {
                  latestExplorerReport = activity.rawReport;
                }
              } else {
                setMessages(toolIdx, "text", (t) => t.replace(/^(⚙|◇)/, ok ? "✓" : "✗"));
                const preview = clipOutput(e.toolResult?.output ?? "");
                if (preview) setMessages(toolIdx, "out", preview);
              }
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

  function commandCtx() {
    return {
      client,
      apiClient,
      baseUrl,
      model,
      setModel,
      agents,
      queuedCount: () => queued().length,
      cwd: () => getSessionCwd(),
      setCwd: (p: string) => {
        setSessionCwd(p);
      },
      workspaceRoot: () => getWorkspaceRoot(),
      push,
      setMessages: (next: CommandMessage[]) => setMessages(next),
      quit,
      latestAssistantText,
      conversationText,
      copyText,
      setAwaitingLogin,
    };
  }

  function openModelPicker() {
    setText("");
    setExplorerPicker(null);
    // Open on the currently active model when we can match it.
    const cur = model();
    const found = INTERACTIVE_MODEL_CHOICES.findIndex((c) => c.model === cur || c.id === cur);
    setPicker({ stage: "model", modelIdx: Math.max(0, found), effortIdx: 0 });
  }

  function pickerEnterModel() {
    const p = picker();
    if (!p) return;
    const choice = INTERACTIVE_MODEL_CHOICES[p.modelIdx];
    const efforts = choice.reasoningEfforts ?? [];
    if (!efforts.length) {
      void confirmPicker(choice, undefined);
      return;
    }
    // Land on the model's default effort (or the middle of the range).
    const fallback = efforts[Math.floor(efforts.length / 2)];
    const di = Math.max(0, efforts.indexOf(choice.defaultEffort ?? fallback));
    setPicker({ ...p, stage: "effort", effortIdx: di });
  }

  async function confirmPicker(choice: (typeof INTERACTIVE_MODEL_CHOICES)[number], effort?: string) {
    setPicker(null);
    await applyModelChoice(commandCtx(), choice, effort);
  }

  function explorerPickerStateFor(settings = explorerSettings()) {
    const models = explorerModelChoices();
    return {
      stage: "menu" as const,
      rowIdx: 0,
      modeIdx: Math.max(0, EXPLORER_MODE_CHOICES.findIndex((choice) => choice.id === settings.mode)),
      modelIdx: Math.max(0, models.findIndex((choice) => choice.id === settings.modelId)),
      budgetIdx: Math.max(0, EXPLORER_BUDGET_CHOICES.findIndex((choice) => choice.id === settings.budget)),
    };
  }

  function openExplorerPicker() {
    setText("");
    setPicker(null);
    setExplorerPicker(explorerPickerStateFor());
  }

  function settingsFromExplorerPicker(p: NonNullable<ReturnType<typeof explorerPicker>>): ExplorerSettings {
    const model = explorerModelChoices()[p.modelIdx] ?? explorerModelChoices()[0];
    return {
      mode: EXPLORER_MODE_CHOICES[p.modeIdx]?.id ?? DEFAULT_EXPLORER_SETTINGS.mode,
      modelId: model?.id ?? DEFAULT_EXPLORER_SETTINGS.modelId,
      budget: EXPLORER_BUDGET_CHOICES[p.budgetIdx]?.id ?? DEFAULT_EXPLORER_SETTINGS.budget,
    };
  }

  function previewExplorerSettings(p: NonNullable<ReturnType<typeof explorerPicker>>): ExplorerSettings {
    return settingsFromExplorerPicker(p);
  }

  function applyExplorerPicker(p: NonNullable<ReturnType<typeof explorerPicker>>) {
    const next = settingsFromExplorerPicker(p);
    const result = applyExplorerSettings(next);
    if (result.ok) setExplorerSettings(next);
    push({ role: "system", text: result.message });
    setStatus(result.ok ? explorerSettingsSummary(next) : result.message);
    setExplorerPicker(null);
  }

  async function handleSlash(cmd: string) {
    // Bare `/model` (no id) opens the interactive picker instead of dumping a
    // list — selection (model + reasoning effort) happens with the arrow keys.
    const bare = cmd.slice(1).trim().toLowerCase();
    if (bare === "model" || bare === "models") {
      openModelPicker();
      return;
    }
    if (bare === "explorer" || bare === "explore") {
      openExplorerPicker();
      return;
    }
    await runInteractiveCommand(commandCtx(), cmd);
  }

  useKeyboard(
    (key: KeyEvent) => {
      // Approval overlay owns the keyboard while open: y/Enter allow once,
      // a always-allow this action, b bypass all (when offered), n/Esc deny.
      // Swallow every key so nothing leaks to the composer and no other action
      // (including abort) fires until the user answers.
      const cf = confirm();
      if (cf) {
        key.preventDefault?.();
        key.stopPropagation?.();
        const isEnter =
          key.name === "return" || key.name === "enter" || key.sequence === "\r" || key.sequence === "\n";
        const k = (n: string) => key.name === n || key.sequence === n || key.sequence === n.toUpperCase();
        let decision: ApprovalDecision | null = null;
        if (k("y") || isEnter) decision = "allow";
        else if (k("a") && cf.allowAlways !== false) decision = "always";
        else if (k("b") && cf.allowBypass !== false) decision = "bypass";
        else if (k("n") || key.name === "escape") decision = "deny";
        if (decision) {
          resolveApproval(cf.id, decision);
          setConfirm(null);
        }
        return;
      }

      // Model picker owns the keyboard while open: ↑/↓ choose the model, Enter
      // advances to reasoning effort, ←/→ choose effort, Enter confirms, Esc
      // steps back / closes. Swallow every key so nothing leaks to the composer.
      const pk = picker();
      if (pk) {
        key.preventDefault?.();
        key.stopPropagation?.();
        const isEnter =
          key.name === "return" || key.name === "enter" || key.sequence === "\r" || key.sequence === "\n";
        if (key.name === "escape") {
          if (pk.stage === "effort") setPicker({ ...pk, stage: "model" });
          else setPicker(null);
          return;
        }
        if (pk.stage === "model") {
          if (key.name === "up") setPicker({ ...pk, modelIdx: Math.max(0, pk.modelIdx - 1) });
          else if (key.name === "down")
            setPicker({ ...pk, modelIdx: Math.min(INTERACTIVE_MODEL_CHOICES.length - 1, pk.modelIdx + 1) });
          else if (isEnter) pickerEnterModel();
          return;
        }
        // effort stage
        const efforts = INTERACTIVE_MODEL_CHOICES[pk.modelIdx].reasoningEfforts ?? [];
        if (key.name === "left") setPicker({ ...pk, effortIdx: Math.max(0, pk.effortIdx - 1) });
        else if (key.name === "right")
          setPicker({ ...pk, effortIdx: Math.min(efforts.length - 1, pk.effortIdx + 1) });
        else if (isEnter) void confirmPicker(INTERACTIVE_MODEL_CHOICES[pk.modelIdx], efforts[pk.effortIdx]);
        return;
      }

      const ep = explorerPicker();
      if (ep) {
        key.preventDefault?.();
        key.stopPropagation?.();
        const isEnter =
          key.name === "return" || key.name === "enter" || key.sequence === "\r" || key.sequence === "\n";
        const menuRows = 5;
        const models = explorerModelChoices();
        if (key.name === "escape") {
          if (ep.stage === "menu") setExplorerPicker(null);
          else setExplorerPicker({ ...ep, stage: "menu" });
          return;
        }
        if (ep.stage === "menu") {
          if (key.name === "up") setExplorerPicker({ ...ep, rowIdx: Math.max(0, ep.rowIdx - 1) });
          else if (key.name === "down") setExplorerPicker({ ...ep, rowIdx: Math.min(menuRows - 1, ep.rowIdx + 1) });
          else if (key.name === "left" || key.name === "right") {
            const delta = key.name === "right" ? 1 : -1;
            if (ep.rowIdx === 0) setExplorerPicker({ ...ep, modeIdx: wrapIndex(ep.modeIdx + delta, EXPLORER_MODE_CHOICES.length) });
            else if (ep.rowIdx === 1) setExplorerPicker({ ...ep, modelIdx: wrapIndex(ep.modelIdx + delta, models.length) });
            else if (ep.rowIdx === 2) setExplorerPicker({ ...ep, budgetIdx: wrapIndex(ep.budgetIdx + delta, EXPLORER_BUDGET_CHOICES.length) });
          } else if (isEnter) {
            if (ep.rowIdx === 0) setExplorerPicker({ ...ep, stage: "mode" });
            else if (ep.rowIdx === 1) setExplorerPicker({ ...ep, stage: "model" });
            else if (ep.rowIdx === 2) setExplorerPicker({ ...ep, stage: "budget" });
            else if (ep.rowIdx === 3) applyExplorerPicker(ep);
            else if (ep.rowIdx === 4) {
              const reset = explorerPickerStateFor(DEFAULT_EXPLORER_SETTINGS);
              setExplorerSettings({...DEFAULT_EXPLORER_SETTINGS});
              const result = applyExplorerSettings(DEFAULT_EXPLORER_SETTINGS);
              push({ role: "system", text: result.message });
              setExplorerPicker(reset);
            }
          }
          return;
        }
        if (ep.stage === "mode") {
          if (key.name === "up") setExplorerPicker({ ...ep, modeIdx: Math.max(0, ep.modeIdx - 1) });
          else if (key.name === "down") setExplorerPicker({ ...ep, modeIdx: Math.min(EXPLORER_MODE_CHOICES.length - 1, ep.modeIdx + 1) });
          else if (isEnter) setExplorerPicker({ ...ep, stage: "menu" });
          return;
        }
        if (ep.stage === "model") {
          if (key.name === "up") setExplorerPicker({ ...ep, modelIdx: Math.max(0, ep.modelIdx - 1) });
          else if (key.name === "down") setExplorerPicker({ ...ep, modelIdx: Math.min(models.length - 1, ep.modelIdx + 1) });
          else if (isEnter) setExplorerPicker({ ...ep, stage: "menu" });
          return;
        }
        if (ep.stage === "budget") {
          if (key.name === "up") setExplorerPicker({ ...ep, budgetIdx: Math.max(0, ep.budgetIdx - 1) });
          else if (key.name === "down") setExplorerPicker({ ...ep, budgetIdx: Math.min(EXPLORER_BUDGET_CHOICES.length - 1, ep.budgetIdx + 1) });
          else if (isEnter) setExplorerPicker({ ...ep, stage: "menu" });
          return;
        }
      }

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

      if (key.ctrl && key.name === "o") {
        key.preventDefault?.();
        key.stopPropagation?.();
        setShowExplorerDetails((show) => {
          const next = !show;
          setStatus(next ? "showing explorer diagnostics" : "hiding explorer diagnostics");
          return next;
        });
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
      if (
        !busy() &&
        !input() &&
        latestExplorerReport &&
        key.name === "c" &&
        key.sequence === "c" &&
        !key.ctrl &&
        !key.meta &&
        !key.shift
      ) {
        key.preventDefault?.();
        key.stopPropagation?.();
        void copyLatestExplorerReport();
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
        void handleSlash("/hotkeys");
        return;
      }
    },
    {}
  );

  onMount(() => {
    void refreshState();
    // Route brain write/edit approval requests into the confirm overlay.
    setConfirmListener((req) => setConfirm(req));
    onCleanup(() => setConfirmListener(null));
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
                  <Show when={m.out && (!m.explorer || showExplorerDetails())}>
                    <text fg={theme.muted} selectable={false}>{gutterIndent(m.out!)}</text>
                  </Show>
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

      <Show when={confirm()}>
        {(c) => (
          <box
            flexDirection="column"
            flexShrink={0}
            borderStyle="single"
            borderColor={theme.accentStrong}
            backgroundColor={theme.bgMuted}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={theme.accentStrong} selectable={false}>
              {c().kind === "command" ? "Approve command?" : c().kind === "write" ? "Approve write?" : "Approve edit?"}
            </text>
            <text fg={theme.text} selectable={false}>{c().path}</text>
            <Show when={c().detail}>
              <text fg={theme.muted} selectable={false}>{c().detail}</text>
            </Show>
            <text fg={theme.muted} selectable={false}>
              {`y allow once · ${c().allowAlways === false ? "" : "a always allow this · "}${c().allowBypass === false ? "" : "b bypass all · "}n/Esc deny`}
            </text>
          </box>
        )}
      </Show>

      <Show when={picker()}>
        {(p) => {
          const choice = () => INTERACTIVE_MODEL_CHOICES[p().modelIdx];
          const efforts = () => choice().reasoningEfforts ?? [];
          return (
            <box
              flexDirection="column"
              flexShrink={0}
              borderStyle="single"
              borderColor={theme.accent}
              backgroundColor={theme.bgMuted}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={theme.accentStrong} selectable={false}>
                {p().stage === "model"
                  ? "Select model    ↑/↓ navigate · Enter → reasoning · Esc cancel"
                  : "Reasoning effort    ←/→ adjust · Enter confirm · Esc back"}
              </text>
              <For each={INTERACTIVE_MODEL_CHOICES}>
                {(c, i) => (
                  <box
                    width="100%"
                    height={1}
                    backgroundColor={i() === p().modelIdx ? theme.border : theme.bgMuted}
                    flexDirection="row"
                  >
                    <text fg={i() === p().modelIdx ? theme.accentStrong : theme.muted} selectable={false}>
                      {(i() === p().modelIdx ? "› " : "  ") +
                        c.label.padEnd(26) +
                        c.description +
                        (c.model === model() || c.id === model() ? "  · current" : "")}
                    </text>
                  </box>
                )}
              </For>
              <Show when={p().stage === "effort"}>
                <box flexDirection="row" paddingTop={1}>
                  <text fg={theme.muted} selectable={false}>{"reasoning:  "}</text>
                  <For each={efforts()}>
                    {(e, i) => (
                      <text
                        fg={i() === p().effortIdx ? theme.accentStrong : theme.muted}
                        selectable={false}
                      >
                        {(i() === p().effortIdx ? `[ ${e} ]` : `  ${e}  `)}
                      </text>
                    )}
                  </For>
                </box>
              </Show>
            </box>
          );
        }}
      </Show>

      <Show when={explorerPicker()}>
        {(p) => {
          const models = explorerModelChoices();
          const preview = () => previewExplorerSettings(p());
          const rows = () => [
            {label: "Mode", value: EXPLORER_MODE_CHOICES[p().modeIdx]?.label ?? "-", desc: EXPLORER_MODE_CHOICES[p().modeIdx]?.description ?? ""},
            {label: "Scout model", value: models[p().modelIdx]?.label ?? "-", desc: models[p().modelIdx]?.description ?? ""},
            {label: "Budget", value: EXPLORER_BUDGET_CHOICES[p().budgetIdx]?.label ?? "-", desc: EXPLORER_BUDGET_CHOICES[p().budgetIdx]?.description ?? ""},
            {label: "Apply for next turn", value: "", desc: explorerSettingsSummary(preview())},
            {label: "Reset", value: "", desc: explorerSettingsSummary(DEFAULT_EXPLORER_SETTINGS)},
          ];
          const title = () => {
            if (p().stage === "mode") return "Explorer mode    ↑/↓ choose · Enter save · Esc back";
            if (p().stage === "model") return "Explorer scout model    ↑/↓ choose · Enter save · Esc back";
            if (p().stage === "budget") return "Explorer budget    ↑/↓ choose · Enter save · Esc back";
            return "Explorer    ↑/↓ navigate · ←/→ change · Enter select/apply · Esc close";
          };
          return (
            <box
              flexDirection="column"
              flexShrink={0}
              borderStyle="single"
              borderColor={theme.accent}
              backgroundColor={theme.bgMuted}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={theme.accentStrong} selectable={false}>{title()}</text>
              <Show when={p().stage === "menu"}>
                <For each={rows()}>
                  {(row, i) => (
                    <box width="100%" height={1} backgroundColor={i() === p().rowIdx ? theme.border : theme.bgMuted} flexDirection="row">
                      <text fg={i() === p().rowIdx ? theme.accentStrong : theme.muted} selectable={false}>
                        {(i() === p().rowIdx ? "› " : "  ") +
                          row.label.padEnd(20) +
                          (row.value ? `${row.value.padEnd(30)} ` : "".padEnd(31)) +
                          row.desc}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
              <Show when={p().stage === "mode"}>
                <For each={EXPLORER_MODE_CHOICES}>
                  {(choice, i) => (
                    <box width="100%" height={1} backgroundColor={i() === p().modeIdx ? theme.border : theme.bgMuted} flexDirection="row">
                      <text fg={i() === p().modeIdx ? theme.accentStrong : theme.muted} selectable={false}>
                        {(i() === p().modeIdx ? "› " : "  ") + choice.label.padEnd(22) + choice.description}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
              <Show when={p().stage === "model"}>
                <For each={models}>
                  {(choice, i) => (
                    <box width="100%" height={1} backgroundColor={i() === p().modelIdx ? theme.border : theme.bgMuted} flexDirection="row">
                      <text fg={i() === p().modelIdx ? theme.accentStrong : theme.muted} selectable={false}>
                        {(i() === p().modelIdx ? "› " : "  ") + choice.label.padEnd(34) + choice.description}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
              <Show when={p().stage === "budget"}>
                <For each={EXPLORER_BUDGET_CHOICES}>
                  {(choice, i) => (
                    <box width="100%" height={1} backgroundColor={i() === p().budgetIdx ? theme.border : theme.bgMuted} flexDirection="row">
                      <text fg={i() === p().budgetIdx ? theme.accentStrong : theme.muted} selectable={false}>
                        {(i() === p().budgetIdx ? "› " : "  ") + choice.label.padEnd(22) + choice.description}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
          );
        }}
      </Show>

      <Show when={!picker() && !explorerPicker() && slashMatches().length > 0}>
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
                <text
                  width={SLASH_COMMAND_COLUMN_WIDTH}
                  fg={i() === slashSelClamped() ? theme.accentStrong : theme.muted}
                  selectable={false}
                >
                  {`/${c.name}`.padEnd(SLASH_COMMAND_COLUMN_WIDTH)}
                </text>
                <text fg={i() === slashSelClamped() ? theme.accentStrong : theme.muted} selectable={false}>
                  {c.desc + (i() === slashSelClamped() ? "   ↵" : "")}
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
            (effort() ? `  ·  ${effort()}` : "") +
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

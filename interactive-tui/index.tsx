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
import { type KeyEvent, type PasteEvent, type TextareaRenderable } from "@opentui/core";
import { createSignal, createMemo, createEffect, For, Show, Switch, Match, onMount, onCleanup } from "solid-js";
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
import { isExplicitCopyChord } from "./keybindings";
import { play as playSound, initSounds, setSoundsEnabled, soundsEnabled, disposeSounds } from "./audio";
import { analyzePaste, type PasteAnalysis } from "./composerPolicy";
import { estimateTokens } from "./threadEngine";
import { setConfirmListener, resolveApproval, type ConfirmRequest, type ApprovalDecision } from "./confirmGate";
import { normalizeImageForModel } from "./imageEngine";
import { extractMermaidBlocks, renderMermaidSource, resolveCellRenderBin } from "./cellRender";
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
import {
  theme,
  buildSyntaxStyle,
  applyScheme,
  saveScheme,
  loadSavedScheme,
  currentSchemeName,
  schemeIndexOf,
  SCHEMES,
  type SchemeName,
} from "./theme";
import { ApprovalOverlay } from "./views";
import {createCrewFromTemplate, listCrewDefinitions, type SiftCrewDefinition} from "./crewRegistry";

// The markdown/code highlight theme is derived from the active palette inside
// App (createMemo), so it rebuilds when the user swaps color schemes.

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

// Phase 1 of the thread-engine rollout: a live context-size meter in the status
// bar, driven by the Zig token estimator. Gated until the compaction planner and
// rollout persistence land; off by default.
const COMPACTION_ENABLED = process.env.SIFT_CONTEXT_COMPACTION !== "0";

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
type CrewCreateDraft = {
  scope: "project" | "user";
  templateId: string;
  id: string;
  name: string;
  description: string;
  fieldIdx: number;
};

const COMMANDS = commandSuggestions();
const SLASH_COMMAND_COLUMN_WIDTH = Math.max(14, ...COMMANDS.map((command) => command.name.length + 5));

const WORD = /\w/;
const MAX_COMPOSER_LINES = 12;
const THEME_WINDOW = 7; // visible rows in the appearance picker (keeps it short)
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

function formatContextTokens(tokens: number): string {
  if (tokens < 1000) return `~${tokens} ctx`;
  return `~${(tokens / 1000).toFixed(1)}k ctx`;
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
  // Empty by design: the empty state renders a centered hero (see showHero)
  // instead of the old single welcome line that left a large void below it.
  const [messages, setMessages] = createStore<Msg[]>([]);
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
  // Most recent rendered diagram (full natural size) + the pannable viewer overlay.
  const [lastDiagram, setLastDiagram] = createSignal<string | null>(null);
  const [viewer, setViewer] = createSignal<{ lines: string[]; w: number; h: number; x: number; y: number } | null>(null);
  // Interactive model picker: stage "model" (↑/↓) → stage "effort" (←/→).
  const [picker, setPicker] = createSignal<
    { stage: "model" | "effort"; modelIdx: number; effortIdx: number } | null
  >(null);
  const [explorerPicker, setExplorerPicker] = createSignal<
    { stage: "menu" | "mode" | "model" | "budget"; rowIdx: number; modeIdx: number; modelIdx: number; budgetIdx: number } | null
  >(null);
  const [crewPicker, setCrewPicker] = createSignal<
    { stage: "library" | "createScope" | "createForm"; rowIdx: number; createIdx: number; crews: SiftCrewDefinition[]; draft: CrewCreateDraft } | null
  >(null);
  // Settings → Appearance: ↑/↓ live-previews a color scheme, Enter saves, Esc
  // reverts to the scheme that was active when the picker opened.
  const [themePicker, setThemePicker] = createSignal<{ idx: number; original: SchemeName } | null>(null);
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

  // Live estimate of the conversation's token footprint (Zig-backed). A proxy
  // for "how full is the context" until per-model windows + the planner land in
  // Phase 2. Recomputes only when the transcript changes, and re-estimates only
  // the messages that actually changed: a per-index cache keyed by content
  // lengths keeps a long thread O(n) cheap checks + O(changed) estimations
  // instead of re-encoding every message on every new turn.
  const tokenCache: number[] = [];
  const tokenCacheKey: string[] = [];
  const contextTokens = createMemo(() => {
    if (!COMPACTION_ENABLED) return 0;
    let total = 0;
    for (let i = 0; i < messages.length; i += 1) {
      const m = messages[i]!;
      const key = `${m.text.length}:${m.out?.length ?? 0}`;
      if (tokenCacheKey[i] !== key) {
        tokenCacheKey[i] = key;
        tokenCache[i] = estimateTokens(m.text) + (m.out ? estimateTokens(m.out) : 0);
      }
      total += tokenCache[i]!;
    }
    if (tokenCache.length > messages.length) {
      tokenCache.length = messages.length;
      tokenCacheKey.length = messages.length;
    }
    return total;
  });

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
    playSound("confirm");
    setBusy(true);
    setStatus("thinking… (Esc to stop)");
    const turnStart = messages.length;
    abortController = new AbortController();
    let firstTool = true;
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
            // The "sift" sound, once per turn, when work starts churning.
            if (firstTool) {
              firstTool = false;
              playSound("process");
            }
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
            got = true;
            playSound("block");
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
      playSound("notify"); // turn complete
      autoRenderMermaid(turnStart);
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      playSound(aborted ? "panelClose" : "block");
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

  // After a completed turn, render any ```mermaid blocks the assistant emitted as
  // terminal-cell diagrams below the reply. The markdown source stays visible;
  // this adds the rendered view. Opt out with SIFT_MERMAID_AUTORENDER=0, and skip
  // silently when the renderer isn't installed or the source fails to parse.
  function autoRenderMermaid(turnStart: number) {
    if (process.env.SIFT_MERMAID_AUTORENDER === "0") return;
    if (!resolveCellRenderBin()) return;
    const seen = new Set<string>();
    for (let i = turnStart; i < messages.length; i += 1) {
      const m = messages[i];
      if (m.role !== "assistant" || !m.text) continue;
      for (const block of extractMermaidBlocks(m.text)) {
        if (seen.has(block)) continue;
        seen.add(block);
        // Render at natural size so the full diagram is available to /view; the
        // inline message is clipped to the viewport width with a pan hint.
        const result = renderMermaidSource(block, { color: "none" });
        if (result.ok && result.text.trim()) showDiagramInline(result.text);
      }
    }
  }

  // Store the full diagram for /view and push an inline message: the whole thing
  // if it fits, otherwise a viewport-width-clipped preview plus a pan hint.
  function showDiagramInline(fullText: string) {
    const text = fullText.replace(/\n+$/, "");
    setLastDiagram(text);
    const lines = text.split("\n");
    const w = lines.reduce((max, l) => Math.max(max, l.length), 0);
    const h = lines.length;
    const maxCols = Math.max(20, terminal().width - 4);
    if (w <= maxCols) {
      push({ role: "system", text });
      return;
    }
    const clipped = lines.map((l) => (l.length > maxCols ? l.slice(0, maxCols) : l)).join("\n");
    push({ role: "system", text: `${clipped}\n… ${w}×${h} clipped — /view to pan (arrows / hjkl).` });
  }

  /** Open the pannable full-screen viewer on the most recent diagram. */
  function openDiagramViewer(): boolean {
    const text = lastDiagram();
    if (!text) return false;
    const lines = text.split("\n");
    const w = lines.reduce((max, l) => Math.max(max, l.length), 0);
    setViewer({ lines, w, h: lines.length, x: 0, y: 0 });
    return true;
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
      submit: (sendText: string, displayText?: string) => {
        const sendInput = buildChatInput(sendText);
        if (busy()) {
          setQueued((q) => [...q, { sendInput, displayText: displayText ?? sendText }]);
          push({ role: "system", text: `↳ queued (${queued().length}) — runs when this turn finishes` });
          return;
        }
        void submitOne(sendInput, displayText ?? sendText);
      },
      quit,
      latestAssistantText,
      conversationText,
      latestExplorerReport: () => latestExplorerReport,
      copyText,
      setAwaitingLogin,
      showDiagram: (fullText: string) => showDiagramInline(fullText),
      viewLastDiagram: () => openDiagramViewer(),
    };
  }

  function openModelPicker() {
    playSound("panelOpen");
    setText("");
    setExplorerPicker(null);
    setCrewPicker(null);
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
    playSound("panelOpen");
    setText("");
    setPicker(null);
    setCrewPicker(null);
    setExplorerPicker(explorerPickerStateFor());
  }

  function crewPickerState() {
    const crews = listCrewDefinitions({cwd: getSessionCwd(), workspaceRoot: getWorkspaceRoot() || undefined});
    return {
      stage: "library" as const,
      rowIdx: 0,
      createIdx: 0,
      crews,
      draft: defaultCrewDraft("project", crews),
    };
  }

  function openCrewPicker() {
    playSound("panelOpen");
    setText("");
    setPicker(null);
    setExplorerPicker(null);
    setCrewPicker(crewPickerState());
  }

  function openThemePicker() {
    setText("");
    setPicker(null);
    setExplorerPicker(null);
    setCrewPicker(null);
    setThemePicker({ idx: schemeIndexOf(currentSchemeName()), original: currentSchemeName() });
    playSound("panelOpen");
  }

  // Live-preview the scheme at `idx` (recolors the whole UI immediately).
  function previewThemeAt(idx: number) {
    const next = SCHEMES[Math.max(0, Math.min(SCHEMES.length - 1, idx))];
    applyScheme(next.name);
    setThemePicker((tp) => (tp ? { ...tp, idx } : tp));
    playSound("tap");
  }

  function uniqueProjectCrewId(base: string, crews: SiftCrewDefinition[]): string {
    const used = new Set(crews.map((crew) => crew.id));
    if (!used.has(base)) return base;
    for (let i = 2; i < 100; i += 1) {
      const candidate = `${base}-${i}`;
      if (!used.has(candidate)) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  function slugFromCrewName(name: string): string {
    return name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "my-crew";
  }

  function defaultCrewDraft(scope: "project" | "user", crews: SiftCrewDefinition[]): CrewCreateDraft {
    const base = scope === "project" ? "my-crew" : "personal-crew";
    return {
      scope,
      templateId: "repo-investigation",
      id: uniqueProjectCrewId(base, crews),
      name: scope === "project" ? "My Crew" : "Personal Crew",
      description: "",
      fieldIdx: 0,
    };
  }

  function fillCrewRunCommand(crew: SiftCrewDefinition) {
    setCrewPicker(null);
    setText(`/crew run ${crew.id} `);
    setStatus(`type the request for ${crew.name}, then Enter`);
  }

  function updateCrewDraft(patch: Partial<CrewCreateDraft>) {
    const cp = crewPicker();
    if (!cp) return;
    setCrewPicker({ ...cp, draft: { ...cp.draft, ...patch } });
  }

  function editCrewDraftText(key: KeyEvent, field: "name" | "id" | "description") {
    const cp = crewPicker();
    if (!cp) return;
    const current = cp.draft[field];
    if (key.name === "backspace" || key.sequence === "\x7f") {
      const next = current.slice(0, -1);
      updateCrewDraft(field === "name" && cp.draft.id === slugFromCrewName(current)
        ? {name: next, id: slugFromCrewName(next)}
        : {[field]: next});
      return;
    }
    const s = key.sequence;
    if (!s || s.length !== 1 || s < " " || key.ctrl || key.meta) return;
    const next = field === "id" ? `${current}${s}`.toLowerCase().replace(/[^a-z0-9-]/g, "-") : `${current}${s}`;
    updateCrewDraft(field === "name" && cp.draft.id === slugFromCrewName(current)
      ? {name: next, id: slugFromCrewName(next)}
      : {[field]: next});
  }

  function saveCrewDraft() {
    const cp = crewPicker();
    if (!cp) return;
    try {
      const crew = createCrewFromTemplate({
        cwd: getSessionCwd(),
        workspaceRoot: getWorkspaceRoot() || undefined,
        id: cp.draft.id,
        scope: cp.draft.scope,
        templateId: cp.draft.templateId,
        name: cp.draft.name,
        description: cp.draft.description,
      });
      const crews = listCrewDefinitions({cwd: getSessionCwd(), workspaceRoot: getWorkspaceRoot() || undefined});
      const rowIdx = Math.max(1, crews.findIndex((item) => item.id === crew.id) + 1);
      setCrewPicker({
        stage: "library",
        rowIdx,
        createIdx: 0,
        crews,
        draft: defaultCrewDraft("project", crews),
      });
      push({role: "system", text: `Created crew ${crew.name} (${crew.id})`});
      setStatus(`created crew ${crew.id}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
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
    if (bare === "crew" || bare === "crews") {
      openCrewPicker();
      return;
    }
    if (bare === "theme" || bare === "themes" || bare === "appearance") {
      openThemePicker();
      return;
    }
    if (bare === "sounds" || bare === "sound" || bare.startsWith("sounds ") || bare.startsWith("sound ")) {
      const arg = bare.split(/\s+/)[1];
      const next = arg === "on" ? true : arg === "off" ? false : !soundsEnabled();
      const audible = await setSoundsEnabled(next);
      push({
        role: "system",
        text: next
          ? audible
            ? "sounds: on"
            : "sounds: on — but no audio device is available here (e.g. over SSH)"
          : "sounds: off",
      });
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

      // Diagram viewer owns the keyboard while open: arrows / hjkl pan, PgUp/PgDn
      // page vertically, Home/End jump horizontally, Esc or q closes.
      const vw = viewer();
      if (vw) {
        key.preventDefault?.();
        key.stopPropagation?.();
        const k = (n: string) => key.name === n || key.sequence === n;
        if (key.name === "escape" || k("q")) {
          setViewer(null);
          return;
        }
        const cols = Math.max(10, terminal().width - 2);
        const rows = Math.max(5, terminal().height - 4);
        const maxX = Math.max(0, vw.w - cols);
        const maxY = Math.max(0, vw.h - rows);
        const step = 4;
        let { x, y } = vw;
        if (key.name === "left" || k("h")) x -= step;
        else if (key.name === "right" || k("l")) x += step;
        else if (key.name === "up" || k("k")) y -= step;
        else if (key.name === "down" || k("j")) y += step;
        else if (key.name === "pageup") y -= rows - 1;
        else if (key.name === "pagedown") y += rows - 1;
        else if (key.name === "home" || k("0")) x = 0;
        else if (key.name === "end" || k("$")) x = maxX;
        else return;
        setViewer({ ...vw, x: Math.max(0, Math.min(maxX, x)), y: Math.max(0, Math.min(maxY, y)) });
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

      // Appearance picker owns the keyboard while open: ↑/↓ (or ←/→) live-preview
      // a scheme, Enter saves it, Esc reverts to the scheme that was active on open.
      const tp = themePicker();
      if (tp) {
        key.preventDefault?.();
        key.stopPropagation?.();
        const isEnter =
          key.name === "return" || key.name === "enter" || key.sequence === "\r" || key.sequence === "\n";
        if (key.name === "escape") {
          applyScheme(tp.original);
          setThemePicker(null);
          playSound("panelClose");
        } else if (key.name === "up" || key.name === "left") {
          previewThemeAt(Math.max(0, tp.idx - 1));
        } else if (key.name === "down" || key.name === "right") {
          previewThemeAt(Math.min(SCHEMES.length - 1, tp.idx + 1));
        } else if (isEnter) {
          const chosen = SCHEMES[tp.idx];
          applyScheme(chosen.name);
          saveScheme(chosen.name);
          setThemePicker(null);
          playSound("toggleOn");
          push({ role: "system", text: `appearance: ${chosen.label} — ${chosen.description}` });
        }
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

      const cp = crewPicker();
      if (cp) {
        key.preventDefault?.();
        key.stopPropagation?.();
        const isEnter =
          key.name === "return" || key.name === "enter" || key.sequence === "\r" || key.sequence === "\n";
        if (key.name === "escape") {
          if (cp.stage === "createForm") setCrewPicker({ ...cp, stage: "createScope" });
          else if (cp.stage === "createScope") setCrewPicker({ ...cp, stage: "library" });
          else setCrewPicker(null);
          return;
        }
        if (cp.stage === "library") {
          const rowCount = cp.crews.length + 1;
          if (key.name === "up") setCrewPicker({ ...cp, rowIdx: Math.max(0, cp.rowIdx - 1) });
          else if (key.name === "down") setCrewPicker({ ...cp, rowIdx: Math.min(rowCount - 1, cp.rowIdx + 1) });
          else if (isEnter) {
            if (cp.rowIdx === 0) setCrewPicker({ ...cp, stage: "createScope", createIdx: 0 });
            else {
              const crew = cp.crews[cp.rowIdx - 1];
              if (crew) fillCrewRunCommand(crew);
            }
          }
          return;
        }
        if (cp.stage === "createScope") {
          const createRows = 2;
          if (key.name === "up") setCrewPicker({ ...cp, createIdx: Math.max(0, cp.createIdx - 1) });
          else if (key.name === "down") setCrewPicker({ ...cp, createIdx: Math.min(createRows - 1, cp.createIdx + 1) });
          else if (isEnter) {
            const scope = cp.createIdx === 0 ? "project" : "user";
            setCrewPicker({ ...cp, stage: "createForm", draft: defaultCrewDraft(scope, cp.crews) });
          }
          return;
        }
        const fieldCount = 4;
        if (key.name === "up") updateCrewDraft({fieldIdx: Math.max(0, cp.draft.fieldIdx - 1)});
        else if (key.name === "down") updateCrewDraft({fieldIdx: Math.min(fieldCount - 1, cp.draft.fieldIdx + 1)});
        else if (isEnter) {
          if (cp.draft.fieldIdx < fieldCount - 1) updateCrewDraft({fieldIdx: cp.draft.fieldIdx + 1});
          else saveCrewDraft();
        } else if (cp.draft.fieldIdx === 0) editCrewDraftText(key, "name");
        else if (cp.draft.fieldIdx === 1) editCrewDraftText(key, "id");
        else if (cp.draft.fieldIdx === 2) editCrewDraftText(key, "description");
        return;
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
      // A bare "c" is intentionally NOT a copy chord — it types (see keybindings.ts).
      if (isExplicitCopyChord(key)) {
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

      // A bare "c" is never copy: it types normally so a message can start with
      // "c" on a blank composer. Copy is explicit — the chords above or /copy
      // (use `/copy explorer` for the latest explorer report).
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
    // Restore the user's saved color scheme (default Sieve) before first paint.
    applyScheme(loadSavedScheme());
    // Restore the saved sound preference (off by default); loads the kit if on.
    void initSounds();
    onCleanup(() => disposeSounds());
    void refreshState();
    // Route brain write/edit approval requests into the confirm overlay.
    setConfirmListener((req) => {
      playSound("notify"); // a decision is waiting on you
      setConfirm(req);
    });
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

  // Empty state → centered hero. The ascii wordmark only renders when the
  // terminal is wide enough to hold it without clipping; otherwise we fall back
  // to a plain styled wordmark (handles narrow panes / the Dock split-view).
  const showHero = () => messages.length === 0;
  const heroWide = () => terminal().width >= 72; // "block" wordmark is ~68 cols

  // Markdown highlight theme, rebuilt whenever the active palette changes so
  // assistant replies recolor along with the chrome on a scheme swap.
  const syntaxStyle = createMemo(() => buildSyntaxStyle({ ...theme }));

  // ── Motion ────────────────────────────────────────────────────────────────
  // Two interval-driven animations, each running ONLY while it's visible, so
  // idle CPU stays at zero (opentui re-renders only when these signals change).
  const SPINNER = ["◐", "◓", "◑", "◒"]; // quarter-circle rotation — on "sift" theme
  const [spin, setSpin] = createSignal(0);
  const spinner = () => SPINNER[spin() % SPINNER.length];
  createEffect(() => {
    if (!busy()) {
      setSpin(0);
      return;
    }
    const id = setInterval(() => setSpin((s) => s + 1), 120);
    onCleanup(() => clearInterval(id));
  });

  // Empty-state "sifting" strip: a dim mesh of dots that drifts each tick,
  // evoking sand through a sieve. Runs only while the hero is shown.
  const SIFT_WIDTH = 34;
  const [sift, setSift] = createSignal(0);
  const siftRow = (offset: number) => {
    const t = sift() + offset;
    let s = "";
    for (let i = 0; i < SIFT_WIDTH; i += 1) s += (i + t) % 3 === 0 ? "·" : " ";
    return s;
  };
  createEffect(() => {
    if (!showHero()) return;
    const id = setInterval(() => setSift((t) => t + 1), 170);
    onCleanup(() => clearInterval(id));
  });

  // Role-threaded gutter bar — a 1-col color thread down the left of each turn.
  const gutterColor = (role: Msg["role"]) =>
    role === "you"
      ? theme.user
      : role === "assistant"
        ? theme.roleAssistant
        : role === "shell"
          ? theme.shell
          : role === "tool"
            ? theme.tool
            : theme.border;

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
        <box flexDirection="row" alignItems="center">
          <text fg={theme.signal} selectable={false}>◇ </text>
          <text fg={theme.accentStrong} selectable={false}>siftable</text>
        </box>
        <box flexDirection="row" alignItems="center">
          <text fg={busy() ? theme.warn : theme.ok} selectable={false}>{busy() ? spinner() + " " : "● "}</text>
          <text fg={theme.muted} selectable={false}>{agentLabel()}</text>
        </box>
      </box>

      <Show when={showHero()}>
        <box
          flexGrow={1}
          width="100%"
          flexDirection="column"
          justifyContent="center"
          alignItems="center"
          backgroundColor={theme.bg}
        >
          <Show
            when={heroWide()}
            fallback={<text fg={theme.signalText} selectable={false}>◇  siftable</text>}
          >
            <ascii_font text="siftable" font="block" color={theme.signal} />
          </Show>
          <box paddingTop={1} flexDirection="column" alignItems="center">
            <text fg={theme.dim} selectable={false}>{siftRow(0)}</text>
            <text fg={theme.dim} selectable={false}>{siftRow(1)}</text>
          </box>
          <box paddingTop={1}>
            <text fg={theme.muted} selectable={false}>sift the signal from your work</text>
          </box>
          <box paddingTop={2} flexDirection="column" alignItems="flex-start">
            <text fg={theme.dim} selectable={false}>{"›  what's in flight right now?"}</text>
            <text fg={theme.dim} selectable={false}>{"›  summarize my week"}</text>
            <text fg={theme.dim} selectable={false}>{"›  / commands    ! shell    ? keys"}</text>
          </box>
        </box>
      </Show>

      <Show when={!showHero()}>
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
              flexDirection="row"
              paddingTop={1}
              backgroundColor={transcriptSelected() && m.role !== "system" ? theme.transcriptSelection : theme.bg}
            >
              <box width={1} flexShrink={0} backgroundColor={gutterColor(m.role)} />
              <box flexDirection="column" flexGrow={1} paddingLeft={1}>
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
                    syntaxStyle={syntaxStyle()}
                    internalBlockMode="top-level"
                    fg={theme.text}
                    bg={theme.bg}
                  />
                </Match>
              </Switch>
              </box>
            </box>
          )}
        </For>
      </scrollbox>
      </Show>

      <Show when={confirm()}>
        {(c) => <ApprovalOverlay request={c()} theme={theme} />}
      </Show>

      <Show when={viewer()}>
        {(v) => {
          const cols = () => Math.max(10, terminal().width - 2);
          const rows = () => Math.max(5, terminal().height - 4);
          const visible = () => v().lines.slice(v().y, v().y + rows()).map((l) => l.slice(v().x, v().x + cols()));
          return (
            <box
              position="absolute"
              top={0}
              left={0}
              width="100%"
              height="100%"
              zIndex={100}
              flexDirection="column"
              backgroundColor={theme.bg}
            >
              <box width="100%" paddingLeft={1} paddingRight={1} backgroundColor={theme.bgMuted} flexDirection="row" justifyContent="space-between">
                <text fg={theme.accentStrong} selectable={false}>◇ diagram viewer</text>
                <text fg={theme.muted} selectable={false}>{`${v().w}×${v().h}  ·  ${v().x},${v().y}`}</text>
              </box>
              <box flexGrow={1} flexDirection="column" paddingLeft={1}>
                <For each={visible()}>{(line) => <text fg={theme.text} selectable={false}>{line || " "}</text>}</For>
              </box>
              <box width="100%" paddingLeft={1} backgroundColor={theme.bgMuted}>
                <text fg={theme.muted} selectable={false}>↑↓←→ / hjkl pan · PgUp/PgDn · Home/End · esc to close</text>
              </box>
            </box>
          );
        }}
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

      <Show when={themePicker()}>
        {(p) => {
          // Window the list so 10+ schemes never push the composer off a short
          // terminal: show THEME_WINDOW rows centred on the selection.
          const total = SCHEMES.length;
          const start = () => Math.max(0, Math.min(p().idx - Math.floor(THEME_WINDOW / 2), Math.max(0, total - THEME_WINDOW)));
          const view = () => SCHEMES.slice(start(), start() + THEME_WINDOW).map((s, j) => ({ s, i: start() + j }));
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
                {`Appearance  (${p().idx + 1}/${total})   ↑/↓ preview · Enter save · Esc cancel`}
              </text>
              <For each={view()}>
                {(row) => (
                  <box
                    width="100%"
                    height={1}
                    backgroundColor={row.i === p().idx ? theme.border : theme.bgMuted}
                    flexDirection="row"
                  >
                    {/* Each row is painted in its own scheme's colors so the list
                        previews the palette at a glance. */}
                    <text fg={row.s.colors.signalText} selectable={false}>
                      {(row.i === p().idx ? "› " : "  ") + row.s.label.padEnd(11)}
                    </text>
                    <text fg={row.s.colors.signal} selectable={false}>{"█"}</text>
                    <text fg={row.s.colors.roleAssistant} selectable={false}>{"█"}</text>
                    <text fg={row.s.colors.ok} selectable={false}>{"█"}</text>
                    <text fg={row.s.colors.warn} selectable={false}>{"█"}</text>
                    <text fg={row.s.colors.err} selectable={false}>{"█ "}</text>
                    <text fg={row.i === p().idx ? row.s.colors.muted : theme.dim} selectable={false}>
                      {row.s.description + (row.s.name === p().original ? "  · current" : "")}
                    </text>
                  </box>
                )}
              </For>
              <text fg={theme.dim} selectable={false}>
                {(start() > 0 ? "↑ more" : "      ") + (start() + THEME_WINDOW < total ? "   ↓ more" : "")}
              </text>
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

      <Show when={crewPicker()}>
        {(p) => {
          const createRows = [
            {scope: "project", title: "Project crew", meta: ".siftable/crews/", desc: "shared with this repo"},
            {scope: "user", title: "Personal crew", meta: "~/.siftable/crews/", desc: "available across repos"},
          ];
          const formRows = () => [
            {label: "Name", value: p().draft.name || "(type a name)", desc: "human-readable label"},
            {label: "Identifier", value: p().draft.id || "(required)", desc: "lowercase id used by /crew run"},
            {label: "Description", value: p().draft.description || "(use template default)", desc: "optional"},
            {label: "Save crew", value: "", desc: `${p().draft.scope} · ${p().draft.templateId}`},
          ];
          const selectedCrew = () => p().rowIdx > 0 ? p().crews[p().rowIdx - 1] : null;
          const title = () => p().stage === "createScope"
            ? "Create crew    ↑/↓ choose scope · Enter continue · Esc back"
            : p().stage === "createForm"
              ? "Create crew    type to edit · ↑/↓ fields · Enter next/save · Esc back"
            : "Crews    ↑/↓ navigate · Enter select · Esc close";
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
              <Show when={p().stage === "library"}>
                <text fg={theme.muted} selectable={false}>
                  Select a crew. Enter fills the composer with a run command.
                </text>
                <box width="100%" height={1} backgroundColor={p().rowIdx === 0 ? theme.border : theme.bgMuted} flexDirection="row">
                  <text fg={p().rowIdx === 0 ? theme.accentStrong : theme.muted} selectable={false}>
                    {(p().rowIdx === 0 ? "› " : "  ") + "Create new crew"}
                  </text>
                </box>
                <For each={p().crews}>
                  {(crew, i) => {
                    const selected = () => i() + 1 === p().rowIdx;
                    return (
                      <box width="100%" height={1} backgroundColor={selected() ? theme.border : theme.bgMuted} flexDirection="row">
                        <text fg={selected() ? theme.accentStrong : theme.muted} selectable={false}>
                          {(selected() ? "› " : "  ") + crew.name}
                        </text>
                      </box>
                    );
                  }}
                </For>
                <box flexDirection="column" paddingTop={1}>
                  <Show
                    when={selectedCrew()}
                    fallback={
                      <>
                        <text fg={theme.muted} selectable={false}>Create a project or personal crew from a starter template.</text>
                        <text fg={theme.muted} selectable={false}>Project crews live in .siftable/crews/. Personal crews live in ~/.siftable/crews/.</text>
                      </>
                    }
                  >
                    {(crew) => (
                      <>
                        <text fg={theme.muted} selectable={false}>{`${crew().scope} · ${crew().id}`}</text>
                        <text fg={theme.muted} selectable={false}>{`${crew().tasks.length} tasks · ${crew().process}`}</text>
                        <text fg={theme.muted} selectable={false}>{crew().description}</text>
                      </>
                    )}
                  </Show>
                </box>
              </Show>
              <Show when={p().stage === "createScope"}>
                <text fg={theme.muted} selectable={false}>
                  Choose where this crew definition should live.
                </text>
                <For each={createRows}>
                  {(row, i) => (
                    <box width="100%" height={1} backgroundColor={i() === p().createIdx ? theme.border : theme.bgMuted} flexDirection="row">
                      <text fg={i() === p().createIdx ? theme.accentStrong : theme.muted} selectable={false}>
                        {(i() === p().createIdx ? "› " : "  ") +
                          row.title.padEnd(24) +
                          row.meta.padEnd(28) +
                          row.desc}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
              <Show when={p().stage === "createForm"}>
                <For each={formRows()}>
                  {(row, i) => (
                    <box width="100%" height={1} backgroundColor={i() === p().draft.fieldIdx ? theme.border : theme.bgMuted} flexDirection="row">
                      <text fg={i() === p().draft.fieldIdx ? theme.accentStrong : theme.muted} selectable={false}>
                        {(i() === p().draft.fieldIdx ? "› " : "  ") +
                          row.label.padEnd(14) +
                          (row.value ? row.value.slice(0, 42).padEnd(44) : "".padEnd(44)) +
                          row.desc}
                      </text>
                    </box>
                  )}
                </For>
                <box flexDirection="column" paddingTop={1}>
                  <text fg={theme.muted} selectable={false}>Template: Repo Investigation</text>
                  <text fg={theme.muted} selectable={false}>Creates mapper, verifier, and summarizer tasks.</text>
                </box>
              </Show>
            </box>
          );
        }}
      </Show>

      <Show when={!picker() && !explorerPicker() && !crewPicker() && !themePicker() && slashMatches().length > 0}>
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
        borderColor={busy() ? theme.warn : theme.borderActive}
        backgroundColor={theme.bgMuted}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="row"
        alignItems="flex-start"
        flexShrink={0}
      >
        <text fg={busy() ? theme.warn : theme.signal} selectable={false}>{busy() ? spinner() + " " : "› "}</text>
        <textarea
          width="100%"
          minHeight={1}
          maxHeight={composerMaxHeight()}
          wrapMode="word"
          placeholder="type a message  ( / commands · ! shell · ? keys )"
          placeholderColor={theme.dim}
          textColor={theme.text}
          focusedTextColor={theme.text}
          backgroundColor={theme.bgMuted}
          focusedBackgroundColor={theme.bgMuted}
          cursorColor={theme.signalText}
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

      <box
        width="100%"
        height={1}
        paddingLeft={1}
        backgroundColor={theme.bgMuted}
        flexDirection="row"
        alignItems="center"
      >
        <text fg={busy() ? theme.warn : theme.ok} selectable={false}>{busy() ? spinner() + " " : "● "}</text>
        <text fg={theme.text} selectable={false}>{status()}</text>
        <Show when={model()}>
          <text fg={theme.dim} selectable={false}>{"   ·   "}</text>
          <text fg={theme.muted} selectable={false}>{model()}</text>
        </Show>
        <Show when={effort()}>
          <text fg={theme.dim} selectable={false}>{"   ·   "}</text>
          <text fg={theme.muted} selectable={false}>{effort()}</text>
        </Show>
        <Show when={queued().length > 0}>
          <text fg={theme.dim} selectable={false}>{"   ·   "}</text>
          <text fg={theme.signal} selectable={false}>{`${queued().length} queued`}</text>
        </Show>
        <Show when={COMPACTION_ENABLED && contextTokens() > 0}>
          <text fg={theme.dim} selectable={false}>{"   ·   "}</text>
          <text fg={theme.muted} selectable={false}>{formatContextTokens(contextTokens())}</text>
        </Show>
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

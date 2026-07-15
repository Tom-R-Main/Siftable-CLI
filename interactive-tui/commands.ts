import {randomUUID} from "node:crypto";
import {homedir} from "node:os";
import {existsSync, readFileSync, rmSync} from "node:fs";
import {isAbsolute, join} from "node:path";
import {rolloutPathForKey} from "./threadEngine";
import {SiftClient} from "@siftable/mcp-server/dist/exfClient.js";
import {doneFallbackText, eventTextDelta, type CompactionReport, type ControlTransport, type RunningAgent} from "./controlClient";
import {collectDailyReviewContext, collectGitRecapSummary, collectLocalGitSummary, type DailyReviewContext} from "../dist/lib/daily-review-context.js";
import {requestApproval} from "./confirmGate";
import {loadPrefs, savePrefs} from "./prefs";
import {listCollabSessions, type CollabBranchSnapshot, type CollabSessionSnapshot} from "./collabEngine";
import {runSiftCrew} from "./crewAdapter";
import {
  extractMermaidBlocks,
  renderMermaidFile,
  renderMermaidSource,
  type CellRenderResult,
  type MermaidRenderOptions,
} from "./cellRender";
import {discoverSkills, formatSkillsList, loadSkill} from "./skillsEngine";
import {renderSkillPreflight} from "./skillPreflight";
import {planAgentWork, buildAgentWorkGraph, resolveWorkItemRef, type RawWorkItem} from "./planning/agentWork";
import {loadPlanOverlay, addDeclaredEdges, type DeclaredEdge} from "./planning/planStore";
import {
  createCrewFromTemplate,
  crewStoragePath,
  getCrewDefinition,
  listCrewDefinitions,
  renderCrewTaskTemplate,
  type CrewScope,
  type SiftCrewDefinition,
} from "./crewRegistry";
import type {
  ChildSessionRecord,
  ChildSessionView,
  MergeChildOptions,
  MergeChildResult,
  RebaseChildResult,
  ReviewChildOptions,
  ReviewChildResult,
  SendBackChildResult,
  SpawnChildInput,
  SpawnChildResult,
} from "./childSessionController";
import type {MergePacket} from "./mergeGate";
import type {ParentMergeView} from "./mergeView";
import type {WorkBoardItem, WorkBoardData} from "./workHubOverlay";

export type CommandMessage = { role: "you" | "assistant" | "system" | "shell" | "tool"; text: string };

/**
 * mergeMaster child-session actions exposed to slash commands. The TUI backs
 * these with a real childSessionController + sessionContext (worktree spawn, cwd
 * + transcript swap); tests back them with a fake. Keeping the surface here lets
 * /spawn·/children·/enter·/leave·/ready stay pure handlers over the context.
 */
export interface ChildSessionActions {
  list: () => ChildSessionView[];
  /** Stable id of the active child, or null when the parent is active. */
  activeChildId: () => number | null;
  spawn: (input: SpawnChildInput) => SpawnChildResult;
  enter: (sessionId: number) => {ok: boolean; reason?: string; session?: ChildSessionRecord};
  leave: () => {ok: boolean; reason?: string};
  /** Run the lane-D ready-to-merge gate on a child (sets its status). */
  review: (sessionId: number, opts?: ReviewChildOptions) => ReviewChildResult;
  /** Read-only dashboard of every child's mergeability (lane E). */
  mergeView: () => ParentMergeView;
  /** Land a ready child onto the base via squash-merge (lane E). */
  merge: (sessionId: number, opts?: MergeChildOptions) => MergeChildResult;
  /** Replay a child onto the moved base; re-gate on success (lane F). */
  rebase: (sessionId: number) => RebaseChildResult;
  /** Resume a reviewed child, posting instructions into its thread (lane F). */
  sendBack: (sessionId: number, instruction: string) => SendBackChildResult;
  /** Reject a reviewed child (terminal, worktree + branch kept) (lane F). */
  reject: (sessionId: number, reason?: string) => {ok: boolean; reason?: string};
}

export interface InteractiveCommandContext {
  client: ControlTransport;
  apiClient: SiftClient;
  baseUrl: string;
  model: () => string;
  setModel: (model: string) => void;
  agents: () => RunningAgent[];
  queuedCount: () => number;
  cwd: () => string;
  /** Change the working directory used to resolve relative tool paths. */
  setCwd: (path: string) => void;
  /** Writable root for write/edit tools (repo root); empty if writes are off. */
  workspaceRoot: () => string;
  push: (message: CommandMessage) => void;
  setMessages: (messages: CommandMessage[]) => void;
  /** Start an agent turn (queues if the agent is busy). `displayText` is what the
   * transcript shows; `sendText` is what the model receives. */
  submit: (sendText: string, displayText?: string) => void;
  /** Show a rendered diagram inline (clipped to the viewport) and store it for /view. */
  showDiagram: (fullText: string) => void;
  /** Open the most recent diagram in the pannable viewer; false if none yet. */
  viewLastDiagram: () => boolean;
  quit: () => void;
  latestAssistantText: () => string;
  conversationText: () => string;
  latestExplorerReport: () => string;
  copyText: (text: string) => Promise<string>;
  setAwaitingLogin: (value: boolean) => void;
  /** Force a context compaction on the active session's agent (/compact). */
  compactThread: () => Promise<CompactionReport>;
  /** mergeMaster child-session control (/spawn · /children · /enter · /leave). */
  sessions: ChildSessionActions;
}

export interface InteractiveCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  hidden?: boolean;
  run: (ctx: InteractiveCommandContext, args: string[]) => Promise<void> | void;
}

export interface InteractiveModelChoice {
  id: string;
  provider: string;
  model: string;
  label: string;
  description: string;
  aliases?: string[];
  auth?: "codex" | "api-key" | "anthropic";
  /** Environment variable required by a first-party provider adapter. */
  requiredEnv?: string;
  /** Short setup hint shown when the provider key is missing. */
  keyHint?: string;
  /**
   * Reasoning-effort levels this model supports, low→high. Drives the picker's
   * second stage. Omit (or leave empty) for models with no configurable
   * reasoning — the picker then confirms on Enter with no effort step.
   */
  reasoningEfforts?: string[];
  /** Effort pre-selected in the picker; falls back to the middle of the list. */
  defaultEffort?: string;
}

export type ExplorerModeSetting = "auto" | "off" | "deterministic" | "scout" | "fanout" | "warpgrep";
export type ExplorerBudgetSetting = "cheap" | "normal" | "deep";

export interface ExplorerSettings {
  mode: ExplorerModeSetting;
  modelId: string;
  budget: ExplorerBudgetSetting;
}

export interface ExplorerModeChoice {
  id: ExplorerModeSetting;
  label: string;
  description: string;
}

export interface ExplorerBudgetChoice {
  id: ExplorerBudgetSetting;
  label: string;
  description: string;
}

// GPT-5.6 Codex models add `max`; older gpt-5.x OpenRouter models expose
// low/med/high/xhigh. Anthropic and Gemini expose low/med/high (mapped to
// thinking budgets on the Anthropic path).
const GPT56_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const GPT5_EFFORTS = ["low", "medium", "high", "xhigh"];
const CLAUDE_EFFORTS = ["low", "medium", "high"];
const GLM_EFFORTS = ["high", "xhigh"];

// Ordered by tier, not by when each was added: flagship brains first (best for
// the main chat loop), then fast/scout models (Explorer defaults live here),
// then specialized models that aren't general chat brains. Pickers iterate this
// array directly and resolve by id/alias, so order is presentation-only.
export const INTERACTIVE_MODEL_CHOICES: InteractiveModelChoice[] = [
  // ── Flagship brains (reasoning-first) ──
  {
    id: "codex/gpt-5.6-sol",
    provider: "codex",
    model: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    description: "ChatGPT/Codex account · flagship for complex work",
    aliases: ["gpt-5.6", "sol", "gpt-5.6-sol", "codex", "gpt", "chatgpt"],
    auth: "codex",
    reasoningEfforts: GPT56_EFFORTS,
    defaultEffort: "medium",
  },
  {
    id: "codex/gpt-5.6-terra",
    provider: "codex",
    model: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    description: "ChatGPT/Codex account · balanced for everyday work",
    aliases: ["terra", "gpt-5.6-terra"],
    auth: "codex",
    reasoningEfforts: GPT56_EFFORTS,
    defaultEffort: "medium",
  },
  {
    id: "codex/gpt-5.6-luna",
    provider: "codex",
    model: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    description: "ChatGPT/Codex account · fast, low-cost, high-volume",
    aliases: ["luna", "gpt-5.6-luna"],
    auth: "codex",
    reasoningEfforts: GPT56_EFFORTS,
    defaultEffort: "medium",
  },
  {
    // Door A: Opus via OpenRouter — rides the OpenRouter `reasoning` wiring.
    id: "openrouter/anthropic/claude-opus-4.8",
    provider: "openrouter",
    model: "anthropic/claude-opus-4.8",
    label: "Claude Opus 4.8",
    description: "OpenRouter · 💸 premium",
    aliases: ["opus", "claude-opus", "claude-opus-4.8"],
    auth: "api-key",
    reasoningEfforts: CLAUDE_EFFORTS,
    defaultEffort: "high",
  },
  {
    // Door B: Opus via the direct Anthropic API (extended thinking, no
    // OpenRouter margin). Requires ANTHROPIC_API_KEY.
    id: "anthropic/claude-opus-4-8",
    provider: "anthropic",
    model: "claude-opus-4-8",
    label: "Claude Opus 4.8 (Anthropic)",
    description: "direct Anthropic API · thinking · 💸💸",
    aliases: ["opus-direct", "claude-api", "anthropic-opus"],
    auth: "anthropic",
    requiredEnv: "ANTHROPIC_API_KEY",
    keyHint: "/key anthropic <key>",
    reasoningEfforts: CLAUDE_EFFORTS,
    defaultEffort: "high",
  },
  {
    id: "openrouter/anthropic/claude-sonnet-4.6",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    label: "Claude Sonnet 4.6",
    description: "OpenRouter",
    aliases: ["claude", "sonnet", "claude-sonnet-4.6"],
    auth: "api-key",
    reasoningEfforts: CLAUDE_EFFORTS,
    defaultEffort: "medium",
  },
  {
    id: "openrouter/x-ai/grok-4.5",
    provider: "openrouter",
    model: "x-ai/grok-4.5",
    label: "Grok 4.5",
    description: "OpenRouter · balanced agentic coding",
    aliases: [
      "grok",
      "grok-4.5",
      "grok-4-5",
      "grok-45",
      "x-ai/grok-4.5",
      "x-ai/grok-4-5",
      "openrouter:x-ai/grok-4.5",
      "openrouter:x-ai/grok-4-5",
    ],
    auth: "api-key",
    reasoningEfforts: CLAUDE_EFFORTS,
    defaultEffort: "medium",
  },
  {
    id: "openrouter/moonshotai/kimi-k2.7-code",
    provider: "openrouter",
    model: "moonshotai/kimi-k2.7-code",
    label: "Kimi K2.7 Code",
    description: "OpenRouter · coding-focused",
    aliases: ["kimi-code", "kimi-k2.7-code", "k2.7-code", "moonshotai/kimi-k2.7-code"],
    auth: "api-key",
  },
  {
    id: "openrouter/z-ai/glm-5.2",
    provider: "openrouter",
    model: "z-ai/glm-5.2",
    label: "GLM 5.2",
    description: "OpenRouter · 1M-context coding/reasoning",
    aliases: ["glm", "glm-5.2", "glm-5", "glm-5.1", "glm-5-turbo", "z-ai/glm-5.2"],
    auth: "api-key",
    reasoningEfforts: GLM_EFFORTS,
    defaultEffort: "high",
  },
  // ── Fast / scout models (cheap, low-latency; Explorer defaults live here) ──
  {
    id: "openrouter/google/gemini-3.5-flash",
    provider: "openrouter",
    model: "google/gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    description: "OpenRouter default",
    aliases: ["gemini", "gemini-3.5-flash", "google/gemini-3.5-flash"],
    auth: "api-key",
    reasoningEfforts: CLAUDE_EFFORTS,
    defaultEffort: "medium",
  },
  {
    id: "openrouter/google/gemini-3.1-flash-lite",
    provider: "openrouter",
    model: "google/gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    description: "OpenRouter · cheap scout",
    aliases: ["flash-lite", "gemini-lite", "gemini-3.1-flash-lite", "google/gemini-3.1-flash-lite"],
    auth: "api-key",
    reasoningEfforts: CLAUDE_EFFORTS,
    defaultEffort: "low",
  },
  {
    id: "gemini/gemini-3.1-flash-lite",
    provider: "gemini",
    model: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite (AI Studio)",
    description: "Google AI Studio · cheap scout",
    aliases: ["aistudio", "ai-studio", "gemini-direct", "gemini-lite-direct"],
    auth: "api-key",
    requiredEnv: "GEMINI_API_KEY",
    keyHint: "/key gemini <key>",
    reasoningEfforts: CLAUDE_EFFORTS,
    defaultEffort: "low",
  },
  {
    id: "openrouter/anthropic/claude-haiku-4.5",
    provider: "openrouter",
    model: "anthropic/claude-haiku-4.5",
    label: "Claude Haiku 4.5",
    description: "OpenRouter · fast scout",
    aliases: ["haiku", "haiku-4.5", "claude-haiku", "anthropic/claude-haiku-4.5"],
    auth: "api-key",
    reasoningEfforts: CLAUDE_EFFORTS,
    defaultEffort: "low",
  },
  {
    id: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    label: "Claude Haiku 4.5 (Anthropic)",
    description: "direct Anthropic API · fast scout",
    aliases: ["haiku-direct", "anthropic-haiku", "claude-haiku-4-5"],
    auth: "anthropic",
    requiredEnv: "ANTHROPIC_API_KEY",
    keyHint: "/key anthropic <key>",
    reasoningEfforts: CLAUDE_EFFORTS,
    defaultEffort: "low",
  },
  {
    id: "openrouter/openai/gpt-5.4-mini",
    provider: "openrouter",
    model: "openai/gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    description: "OpenRouter · balanced scout",
    aliases: ["gpt-5.4-mini", "mini", "openai/gpt-5.4-mini"],
    auth: "api-key",
    reasoningEfforts: GPT5_EFFORTS,
    defaultEffort: "low",
  },
  {
    id: "openai/gpt-5.4-mini",
    provider: "openai",
    model: "gpt-5.4-mini",
    label: "GPT-5.4 Mini (OpenAI)",
    description: "direct OpenAI API · balanced scout",
    aliases: ["openai-mini", "gpt-5.4-mini-direct"],
    auth: "api-key",
    requiredEnv: "OPENAI_API_KEY",
    keyHint: "/key openai <key>",
    reasoningEfforts: GPT5_EFFORTS,
    defaultEffort: "low",
  },
  {
    id: "openrouter/openai/gpt-5.4-nano",
    provider: "openrouter",
    model: "openai/gpt-5.4-nano",
    label: "GPT-5.4 Nano",
    description: "OpenRouter · ultra cheap scout",
    aliases: ["gpt-5.4-nano", "nano", "openai/gpt-5.4-nano"],
    auth: "api-key",
    reasoningEfforts: GPT5_EFFORTS,
    defaultEffort: "low",
  },
  // ── Specialized (not general chat brains) ──
  {
    id: "openrouter/morph/morph-v3-large",
    provider: "openrouter",
    model: "morph/morph-v3-large",
    label: "Morph v3 Large",
    description: "OpenRouter · ⚡ apply-only (~700 tps, single-turn)",
    aliases: ["morph", "morph-v3-large", "morph/morph-v3-large"],
    auth: "api-key",
    // Fast-apply model — no reasoning axis (picker confirms on Enter). NOTE:
    // Morph's endpoint rejects system prompts / multi-turn ("Multi-turn
    // conversations are not supported", HTTP 400) and has no tool-calling, so it
    // is NOT usable as a chat brain or Explorer scout. It belongs on the
    // edit_file apply path. For Morph-powered code search use warp-grep, not this.
  },
];

export const EXPLORER_MODE_CHOICES: ExplorerModeChoice[] = [
  {id: "auto", label: "Auto", description: "recommended repo preflight"},
  {id: "off", label: "Off", description: "skip Explorer"},
  {id: "deterministic", label: "Deterministic only", description: "fastest, no scout model"},
  {id: "scout", label: "Scout", description: "one read-only model helper"},
  {id: "fanout", label: "Fan-out", description: "parallel read-only role scouts"},
  {id: "warpgrep", label: "Warp-grep", description: "Morph code-search subagent · fast, no index (MORPH_API_KEY)"},
];

/**
 * Whether a mode actually drives the user-selected scout LLM. Only `scout` and
 * `fanout` do — `off`/`deterministic` run no model, and `warpgrep` brings its
 * own (Morph, server-side). The Explorer overlay uses this to render the
 * "Scout model" row inert (and skip it in navigation) when it has no effect.
 */
export function modeUsesScoutModel(mode: ExplorerModeSetting | undefined): boolean {
  return mode === "scout" || mode === "fanout";
}

export const EXPLORER_BUDGET_CHOICES: ExplorerBudgetChoice[] = [
  {id: "cheap", label: "Cheap", description: "smaller model budget"},
  {id: "normal", label: "Normal", description: "balanced default"},
  {id: "deep", label: "Deep", description: "more reads and time"},
];

export const DEFAULT_EXPLORER_SETTINGS: ExplorerSettings = {
  mode: "auto",
  modelId: "openrouter/google/gemini-3.1-flash-lite",
  budget: "normal",
};

export function explorerModelChoices(): InteractiveModelChoice[] {
  return INTERACTIVE_MODEL_CHOICES.filter((choice) => choice.provider !== "codex");
}

export function explorerSettingsSummary(settings: ExplorerSettings): string {
  const model = explorerModelChoices().find((choice) => choice.id === settings.modelId);
  // Only surface the scout model when the mode actually uses it — otherwise it
  // reads as if (e.g.) warp-grep runs on Gemini, which it doesn't.
  const modelPart = modeUsesScoutModel(settings.mode)
    ? (model ? `model ${model.label}` : `model ${settings.modelId}`)
    : settings.mode === "warpgrep"
      ? "model Morph (built-in)"
      : "model —";
  return [
    `mode ${settings.mode}`,
    modelPart,
    `budget ${settings.budget}`,
  ].join(" · ");
}

/** Resolve a model choice by id/alias/label, or null. */
export function findModelChoice(raw: string): InteractiveModelChoice | null {
  return resolveModelChoice(raw);
}

const HOTKEYS = [
  "Esc            stop the response · clear the draft when idle",
  "^C             interrupt · clear draft · quit when idle",
  "^O             show/hide explorer diagnostics",
  "^⇧C            copy the latest assistant response",
  "⌘A             select composer; empty draft selects transcript (terminal may eat ⌘A)",
  "/copy all      copy the whole transcript — works in any terminal",
  "^D             quit when the draft is empty",
  "←/→  ^A/^E     move by char · line start/end      Home/End",
  "^U / ^K        delete to line start / end",
  "^W  ⌥←/⌥→      delete word · move by word",
  "↑/↓            prompt history       Shift+Enter  newline",
  "/  Tab         command palette · complete",
  "/copy all      copy the full transcript",
  "!cmd           run a shell command into the transcript",
  "Enter (busy)   queue the message; runs when the turn finishes",
].join("\n");

type ApiResponse = {data?: unknown; error?: string; statusCode: number};

function getData(response: ApiResponse): Record<string, unknown> {
  if (response.error) {
    throw new Error(`API error (${response.statusCode}): ${response.error}`);
  }
  return (response.data ?? {}) as Record<string, unknown>;
}

function listFrom(response: ApiResponse, key: string): Record<string, unknown>[] {
  return (getData(response)[key] ?? []) as Record<string, unknown>[];
}

function textArg(args: string[]): string {
  return args.join(" ").trim();
}

function parseCommandArgs(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (current) out.push(current);
  return out;
}

function modelChoiceText(choice: InteractiveModelChoice): string {
  return `${choice.id} ${choice.label} ${choice.provider} ${choice.model} ${(choice.aliases ?? []).join(" ")}`.toLowerCase();
}

function resolveModelChoice(raw: string): InteractiveModelChoice | null {
  const id = raw.trim().toLowerCase();
  if (!id) return null;
  return INTERACTIVE_MODEL_CHOICES.find((choice) => {
    const keys = [choice.id, choice.model, choice.label, choice.provider, ...(choice.aliases ?? [])];
    return keys.some((key) => key.toLowerCase() === id);
  }) ?? null;
}

export function modelSuggestions(query = ""): Array<{id: string; label: string; desc: string}> {
  const q = query.trim().toLowerCase();
  const choices = q
    ? INTERACTIVE_MODEL_CHOICES.filter((choice) => modelChoiceText(choice).includes(q))
    : INTERACTIVE_MODEL_CHOICES;
  return choices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    desc: `${choice.provider}/${choice.model} · ${choice.description}`,
  }));
}

function effortSuffix(effort?: string): string {
  return effort ? ` · reasoning ${effort}` : "";
}

function missingKeyMessage(choice: InteractiveModelChoice): string | null {
  if (!choice.requiredEnv || process.env[choice.requiredEnv]) return null;
  return `${choice.label} needs ${choice.requiredEnv}. Run: ${choice.keyHint ?? `/key ${choice.provider} <key>`} or /key vault ${choice.provider}`;
}

function providerKeyEnv(provider: string): string {
  return `${provider.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_API_KEY`;
}

function choiceKeyEnv(choice: InteractiveModelChoice): string | null {
  if (choice.provider === "codex") return null;
  return choice.requiredEnv ?? providerKeyEnv(choice.provider);
}

/**
 * Whether a provider string is one the model brain actually serves (i.e. appears
 * as a `.provider` in the catalog). Used to avoid switching the active brain to a
 * search-only provider like "morph" when we merely load its key for warp-grep.
 */
function isBrainProvider(provider: string): boolean {
  return INTERACTIVE_MODEL_CHOICES.some((choice) => choice.provider === provider);
}

function vaultEntryLabel(entry: Record<string, unknown>): string {
  return String(entry.name || entry.slug || entry.id || "vault entry");
}

function vaultEntryId(entry: Record<string, unknown>): string | null {
  const id = entry.id;
  return typeof id === "string" && id ? id : null;
}

function vaultEntrySearchText(entry: Record<string, unknown>): string {
  const tags = Array.isArray(entry.tags) ? entry.tags.map(String).join(" ") : "";
  return [
    entry.id,
    entry.name,
    entry.slug,
    entry.entryType,
    entry.category,
    entry.description,
    tags,
  ].filter(Boolean).join(" ").toLowerCase();
}

function scoreVaultKeyEntry(entry: Record<string, unknown>, provider: string, envVar: string): number {
  const text = vaultEntrySearchText(entry);
  let score = 0;
  if (text.includes(envVar.toLowerCase())) score += 10;
  if (text.includes(provider.toLowerCase())) score += 6;
  if (text.includes("api key") || text.includes("apikey")) score += 4;
  if (text.includes("credential") || text.includes("env_var")) score += 2;
  if (text.includes("ssh") || text.includes("certificate") || text.includes("password")) score -= 5;
  return score;
}

async function listVaultKeyCandidates(
  apiClient: SiftClient,
  provider: string,
  envVar: string,
): Promise<Record<string, unknown>[]> {
  const seen = new Set<string>();
  const candidates: Record<string, unknown>[] = [];
  const searches = [envVar, `${provider} api key`, provider];

  for (const search of searches) {
    const response = await apiClient.listVaultEntries({search, limit: 10});
    const entries = listFrom(response as ApiResponse, "entries");
    for (const entry of entries) {
      const key = String(entry.id || entry.slug || entry.name || JSON.stringify(entry));
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(entry);
    }
  }

  return candidates
    .map((entry) => ({entry, score: scoreVaultKeyEntry(entry, provider, envVar)}))
    .filter((item) => item.score > 0 && vaultEntryId(item.entry))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.entry);
}

function payloadRecord(data: Record<string, unknown>): Record<string, unknown> {
  const direct = data.payload;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  const entry = data.entry;
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const nested = (entry as Record<string, unknown>).payload;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
  }
  return data;
}

function secretFromPayload(payload: Record<string, unknown>, provider: string, envVar: string): string | null {
  const candidates = [
    envVar,
    envVar.toLowerCase(),
    envVar.replace(/_API_KEY$/, "_KEY"),
    `${provider.toUpperCase()}_KEY`,
    `${provider}ApiKey`,
    `${provider}_api_key`,
    "apiKey",
    "api_key",
    "key",
    "token",
    "value",
  ];
  for (const key of candidates) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const value of Object.values(payload)) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export async function hydrateProviderKeyFromVault(
  ctx: InteractiveCommandContext,
  provider: string,
  envVar = providerKeyEnv(provider),
): Promise<{ok: boolean; message: string}> {
  if (process.env[envVar]) return {ok: true, message: `${envVar} already set.`};
  if (typeof ctx.apiClient.listVaultEntries !== "function" || typeof ctx.apiClient.readVaultSecret !== "function") {
    return {ok: false, message: "Sift Vault is unavailable in this session."};
  }

  let entry: Record<string, unknown> | undefined;
  try {
    entry = (await listVaultKeyCandidates(ctx.apiClient, provider, envVar))[0];
  } catch (err) {
    return {ok: false, message: `Could not search Sift Vault metadata: ${err instanceof Error ? err.message : String(err)}`};
  }

  if (!entry) return {ok: false, message: `No Sift Vault entry found for ${envVar}.`};

  const id = vaultEntryId(entry);
  if (!id) return {ok: false, message: `Matched vault entry for ${envVar} has no id.`};
  const label = vaultEntryLabel(entry);
  const approval = await requestApproval({
    kind: "command",
    path: `vault read ${label}`,
    detail: `Use as ${envVar} for this sift interactive session. The secret will not be printed or written to disk.`,
    allowAlways: false,
    allowBypass: false,
  });
  if (approval === "deny") return {ok: false, message: `Vault key use denied for ${envVar}.`};

  try {
    const response = await ctx.apiClient.readVaultSecret(id);
    const payload = payloadRecord(getData(response as ApiResponse));
    const secret = secretFromPayload(payload, provider, envVar);
    if (!secret) return {ok: false, message: `Vault entry "${label}" did not contain a usable ${envVar} value.`};
    process.env[envVar] = secret;
    // Only register with the model brain for providers it actually serves.
    // A non-brain provider like "morph" (warp-grep only, read straight from
    // MORPH_API_KEY above) would otherwise switch the active brain provider to
    // an unknown one and break the next turn.
    if (isBrainProvider(provider)) {
      await ctx.client.config({provider, apiKey: secret});
    }
    return {ok: true, message: `Using Sift Vault entry "${label}" for ${envVar} this session.`};
  } catch (err) {
    return {ok: false, message: `Could not read Sift Vault entry "${label}": ${err instanceof Error ? err.message : String(err)}`};
  }
}

/**
 * Before running an explorer turn, make sure the provider key the active mode
 * needs is loaded — recovering it from Sift Vault (with an approval prompt) when
 * it's missing, instead of letting the turn dead-end on "key not set". Only
 * warp-grep mode has an out-of-band key (MORPH_API_KEY); scout/fanout key checks
 * already happen at apply time. Returns a user-facing message worth surfacing,
 * or null when nothing actionable happened (key already present).
 */
export async function ensureExplorerProviderKey(ctx: InteractiveCommandContext): Promise<string | null> {
  if (process.env.SIFT_EXPLORER_WARPGREP === "1" && !process.env.MORPH_API_KEY) {
    const res = await hydrateProviderKeyFromVault(ctx, "morph", "MORPH_API_KEY");
    return /already set/i.test(res.message) ? null : res.message;
  }
  return null;
}

export function applyExplorerSettings(settings: ExplorerSettings): {ok: boolean; message: string} {
  const model = explorerModelChoices().find((choice) => choice.id === settings.modelId);
  if (!model) return {ok: false, message: `Explorer model not found: ${settings.modelId}`};
  const keyMessage = missingKeyMessage(model);
  if (keyMessage) return {ok: false, message: keyMessage};

  process.env.SIFT_EXPLORER_BUDGET = settings.budget;
  process.env.SIFT_EXPLORER_THOROUGHNESS = settings.budget === "cheap" ? "quick" : settings.budget === "deep" ? "deep" : "medium";
  process.env.SIFT_EXPLORER_PROVIDER = model.provider;
  process.env.SIFT_EXPLORER_MODEL = model.model;
  process.env.SIFT_EXPLORER_SCOUT_PROVIDER = model.provider;
  process.env.SIFT_EXPLORER_SCOUT_MODEL = model.model;

  // Reset the warp-grep flag for every mode; only the warpgrep branch turns it on.
  process.env.SIFT_EXPLORER_WARPGREP = "0";
  if (settings.mode === "off") {
    process.env.SIFT_EXPLORER = "off";
    process.env.SIFT_EXPLORER_SCOUT = "0";
    process.env.SIFT_EXPLORER_FANOUT = "0";
  } else if (settings.mode === "scout") {
    process.env.SIFT_EXPLORER = "fast-context";
    process.env.SIFT_EXPLORER_SCOUT = "1";
    process.env.SIFT_EXPLORER_FANOUT = "0";
  } else if (settings.mode === "fanout") {
    process.env.SIFT_EXPLORER = "fast-context";
    process.env.SIFT_EXPLORER_SCOUT = "0";
    process.env.SIFT_EXPLORER_FANOUT = "1";
  } else if (settings.mode === "warpgrep") {
    process.env.SIFT_EXPLORER = "fast-context";
    process.env.SIFT_EXPLORER_SCOUT = "0";
    process.env.SIFT_EXPLORER_FANOUT = "0";
    process.env.SIFT_EXPLORER_WARPGREP = "1";
  } else if (settings.mode === "deterministic") {
    process.env.SIFT_EXPLORER = "deterministic";
    process.env.SIFT_EXPLORER_SCOUT = "0";
    process.env.SIFT_EXPLORER_FANOUT = "0";
  } else {
    process.env.SIFT_EXPLORER = "fast-context";
    process.env.SIFT_EXPLORER_SCOUT = "0";
    process.env.SIFT_EXPLORER_FANOUT = "0";
  }

  savePrefs({explorer: {mode: settings.mode, modelId: settings.modelId, budget: settings.budget}});
  return {ok: true, message: `Explorer -> ${explorerSettingsSummary(settings)}`};
}

/** Persist the selected brain model so it survives a restart. */
function persistModelChoice(choice: InteractiveModelChoice, effort?: string): void {
  savePrefs({model: {id: choice.id, ...(effort ? {effort} : {})}});
}

async function selectCodexModel(ctx: InteractiveCommandContext, choice: InteractiveModelChoice, effort?: string): Promise<void> {
  if (!ctx.client.codexStatus || !ctx.client.codexLogin) {
    ctx.push({role: "system", text: "Codex models are only available in local mode (`sift interactive`)."});
    return;
  }

  const status = await ctx.client.codexStatus();
  if (!status.installed) {
    ctx.push({role: "system", text: "Codex CLI not found. Install it (https://developers.openai.com/codex), then retry."});
    return;
  }

  const result = await ctx.client.config({provider: choice.provider, model: choice.model, ...(effort ? {effort} : {})});
  ctx.setModel(result.model);
  persistModelChoice(choice, effort);

  if (status.account) {
    ctx.push({
      role: "system",
      text: `model -> ${result.provider}/${result.model}${effortSuffix(effort)} — signed in as ${status.account.email ?? status.account.type}.`,
    });
    return;
  }

  const {verificationUri, userCode, completion} = await ctx.client.codexLogin();
  ctx.push({
    role: "system",
    text:
      `model -> ${result.provider}/${result.model}${effortSuffix(effort)}\n` +
      `Codex needs ChatGPT sign-in. Opening your browser...\n` +
      `If it doesn't open, visit: ${verificationUri}\n` +
      `Verification code: ${userCode}`,
  });
  completion?.then((loginResult) => {
    if (loginResult.success) {
      ctx.push({role: "system", text: `✓ Signed in to Codex${loginResult.email ? ` as ${loginResult.email}` : ""}.`});
    } else {
      ctx.push({role: "system", text: `Codex login failed${loginResult.error ? `: ${loginResult.error}` : "."}`});
    }
  });
}

/**
 * Apply a resolved model choice (+ optional reasoning effort). Routes Codex
 * through its sign-in flow and direct-Anthropic through the API-key gate; both
 * the `/model <id>` command and the interactive picker funnel through here.
 */
export async function applyModelChoice(
  ctx: InteractiveCommandContext,
  choice: InteractiveModelChoice,
  effort?: string,
  opts: {quiet?: boolean} = {},
): Promise<void> {
  if (choice.provider === "codex") {
    await selectCodexModel(ctx, choice, effort);
    return;
  }

  // First-party providers need their own key in-env. Gate selection with a
  // clear hint instead of letting the first turn fail with a raw adapter error.
  const envVar = choiceKeyEnv(choice);
  if (envVar && !process.env[envVar]) {
    const hydrated = await hydrateProviderKeyFromVault(ctx, choice.provider, envVar);
    if (hydrated.ok) {
      ctx.push({role: "system", text: hydrated.message});
    } else if (choice.requiredEnv) {
      ctx.push({role: "system", text: `${hydrated.message}\n${missingKeyMessage(choice)}`});
      return;
    }
  }

  const keyMessage = missingKeyMessage(choice);
  if (keyMessage) {
    ctx.push({role: "system", text: keyMessage});
    return;
  }

  try {
    const result = await ctx.client.config({provider: choice.provider, model: choice.model, ...(effort ? {effort} : {})});
    ctx.setModel(result.model);
    persistModelChoice(choice, effort);
    if (!opts.quiet) ctx.push({role: "system", text: `model -> ${result.provider}/${result.model}${effortSuffix(effort)}`});
  } catch (err) {
    ctx.push({role: "system", text: `/model failed: ${err instanceof Error ? err.message : String(err)}`});
  }
}

/**
 * Restore the model saved by a prior session (see persistModelChoice) at
 * startup, so the user's pick survives a restart even before they send a
 * message. This restores the *selection* only — it sets the brain to the saved
 * model/effort directly (including Codex) without triggering Codex sign-in or
 * vault key prompts at launch. Missing auth/keys surface in the status line and
 * on first use, exactly as they would for the default model.
 */
export async function restoreSavedModel(ctx: InteractiveCommandContext): Promise<void> {
  const saved = loadPrefs().model;
  if (!saved?.id) return;
  const choice = resolveModelChoice(saved.id);
  if (!choice) return;
  try {
    const result = await ctx.client.config({
      provider: choice.provider,
      model: choice.model,
      ...(saved.effort ? {effort: saved.effort} : {}),
    });
    ctx.setModel(result.model);
  } catch {
    /* best-effort — leave the brain default in place */
  }
}

async function selectModel(ctx: InteractiveCommandContext, raw: string, effort?: string): Promise<void> {
  const choice = resolveModelChoice(raw);
  if (choice) {
    await applyModelChoice(ctx, choice, effort);
    return;
  }

  try {
    const parsed = parseAdHocModel(raw);
    const result = await ctx.client.config({...parsed, ...(effort ? {effort} : {})});
    ctx.setModel(result.model);
    ctx.push({role: "system", text: `model -> ${result.provider}/${result.model}${effortSuffix(effort)}`});
  } catch (err) {
    ctx.push({role: "system", text: `/model failed: ${err instanceof Error ? err.message : String(err)}`});
  }
}

function normalizeAdHocOpenRouterModel(model: string): string {
  const lower = model.trim().toLowerCase();
  const glmLike =
    lower === "glm"
    || /^glm[-_.]/.test(lower)
    || lower.includes("z-ai/glm")
    || lower.includes("z.ai/glm")
    || lower.includes("/glm-")
    || lower.includes("/glm_")
    || lower.includes(":glm-")
    || lower.includes(":glm_");
  if (glmLike) return "z-ai/glm-5.2";
  return model;
}

function parseAdHocModel(raw: string): {provider?: string; model: string} {
  const id = raw.trim();
  if (id.startsWith("openrouter/")) return {provider: "openrouter", model: normalizeAdHocOpenRouterModel(id.slice("openrouter/".length))};
  if (id.startsWith("openai/")) return {provider: "openai", model: id.slice("openai/".length)};
  if (id.startsWith("gemini/")) return {provider: "gemini", model: id.slice("gemini/".length)};
  if (id.startsWith("anthropic/") && !id.includes(".")) return {provider: "anthropic", model: id.slice("anthropic/".length)};
  if (/^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i.test(id)) return {provider: "openrouter", model: normalizeAdHocOpenRouterModel(id)};
  const normalized = normalizeAdHocOpenRouterModel(id);
  if (normalized !== id) return {provider: "openrouter", model: normalized};
  return {model: id};
}

function splitList(raw: string): string[] {
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}

function flagValue(args: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  const index = args.findIndex((arg) => arg === flag || arg.startsWith(prefix));
  if (index === -1) return undefined;
  if (args[index].startsWith(prefix)) return args[index].slice(prefix.length);
  return args[index + 1]?.startsWith("--") ? undefined : args[index + 1];
}

function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      if (!arg.includes("=")) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function formatAgent(alias: unknown): string {
  if (!alias) return "-";
  if (typeof alias === "string") return alias;
  if (typeof alias === "object") {
    const record = alias as Record<string, unknown>;
    return String(record.alias ?? record.displayName ?? record.agentType ?? "-");
  }
  return String(alias);
}

function formatWorkLine(item: Record<string, unknown>): string {
  const owner = item.claimOwner ? ` · ${item.claimOwner}` : "";
  const agent = formatAgent(item.assignedAlias);
  return `- ${item.title ?? "(untitled)"} [${agent}]${owner}`;
}

function groupByStatus(items: Record<string, unknown>[]): string {
  const statuses = ["running", "claimed", "queued", "blocked", "needs_review"];
  const lines: string[] = [];
  for (const status of statuses) {
    const group = items.filter((item) => item.status === status);
    if (!group.length) continue;
    lines.push(`${status}`);
    lines.push(...group.map(formatWorkLine));
  }
  return lines.length ? lines.join("\n") : "No queued or active work items.";
}

/** Pull a list-of-strings off a work-item row, tolerating snake/camel + {text} shapes. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry : (entry as Record<string, unknown>)?.text))
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
}

/** Flatten a writeScope ({include:[…]} or a raw glob array) into its globs. */
function scopeGlobs(value: unknown): string[] {
  if (Array.isArray(value)) return stringList(value);
  if (value && typeof value === "object") {
    const include = (value as Record<string, unknown>).include;
    if (Array.isArray(include)) return stringList(include);
  }
  return [];
}

/** Normalize one API work-item row into the board's display shape. */
function normalizeWorkItem(row: Record<string, unknown>): WorkBoardItem {
  const blockers = stringList(row.blockers);
  const blockedReason = row.blockedReason ?? row.blocked_reason;
  if (!blockers.length && typeof blockedReason === "string" && blockedReason.trim()) blockers.push(blockedReason.trim());
  return {
    id: String(row.id ?? ""),
    title: String(row.title ?? "(untitled)"),
    status: String(row.status ?? "unknown"),
    agent: formatAgent(row.assignedAlias ?? row.assigned_alias),
    owner: row.claimOwner ? String(row.claimOwner) : row.claim_owner ? String(row.claim_owner) : null,
    prompt: (row.prompt ?? null) as string | null,
    writeScope: scopeGlobs(row.writeScope ?? row.write_scope),
    verification: stringList(row.verificationCommands ?? row.verification_commands),
    acceptance: stringList(row.acceptanceCriteria ?? row.acceptance_criteria),
    blockers,
  };
}

/**
 * Fetch the agent queue board in one place — agents (header fold) + work items
 * (rows), normalized for the overlay. Shared by `/queue` and the `/work` hub so
 * both read the same data (the extraction that keeps the hub modal-safe: it
 * renders these rows in-overlay instead of shelling out to a command).
 */
export async function loadWorkBoard(ctx: InteractiveCommandContext): Promise<WorkBoardData> {
  const [agentsResp, workResp] = await Promise.all([
    ctx.apiClient.listAgents({includeDisabled: true}),
    ctx.apiClient.listWorkItems({limit: 50}),
  ]);
  const agents = listFrom(agentsResp, "agents").map((agent) => ({
    alias: String(agent.alias ?? agent.displayName ?? agent.id ?? "agent"),
    status: String(agent.status ?? "unknown"),
  }));
  const items = listFrom(workResp, "workItems").map(normalizeWorkItem);
  return {agents, items};
}

/**
 * Code/test evidence for a free-text query against the repo covering the cwd.
 * Shared by `/proof` and the `/work` hub's per-item evidence view.
 */
async function searchCodeEvidence(
  ctx: InteractiveCommandContext,
  query: string,
  limit = 6,
): Promise<{results: Record<string, unknown>[]; testHints: Record<string, unknown>[]}> {
  const repos = listFrom(await ctx.apiClient.listCodeRepositories(), "repositories");
  const repo =
    repos.find((candidate) => typeof candidate.rootPath === "string" && ctx.cwd().startsWith(candidate.rootPath as string)) ??
    repos[0];
  const results = listFrom(
    await ctx.apiClient.searchCode({query, repositoryId: repo?.id as string | undefined, limit}),
    "results",
  );
  const testHints = results.filter((result) => String(result.filePath ?? "").match(/\.(test|spec|vitest)\./));
  return {results, testHints};
}

function formatEvidence(heading: string, results: Record<string, unknown>[], testHints: Record<string, unknown>[]): string {
  return [
    heading,
    results.length
      ? results.map((result) => `- ${result.filePath}:${result.startLine ?? "?"} ${result.symbolName ?? ""}`.trimEnd()).join("\n")
      : "No code search results.",
    testHints.length
      ? "\nTest evidence:\n" + testHints.map((result) => `- ${result.filePath}`).join("\n")
      : "\nTest evidence: not found in top results.",
  ].join("\n");
}

/**
 * Evidence for a *work item* (the hub's `v` action). Builds a better query than
 * a bare title by folding in the item's acceptance criteria and a prompt snippet,
 * so the search reflects what the item is actually meant to do.
 */
export async function workItemEvidence(ctx: InteractiveCommandContext, item: WorkBoardItem): Promise<string> {
  const query = [item.title, ...item.acceptance, (item.prompt ?? "").slice(0, 200)]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(". ");
  const {results, testHints} = await searchCodeEvidence(ctx, query, 6);
  return formatEvidence(`Evidence: ${item.title}`, results, testHints);
}

/** Structured input for a handoff work item — shared by /handoff and the /work hub. */
export interface HandoffWorkItemInput {
  title: string;
  agent: string;
  files: string[];
  acceptance: string[];
  verify?: string[];
}

/**
 * Create a work item from the live interactive context — the single payload
 * builder behind both the `/handoff` command and the `/work` hub's handoff form,
 * so neither drifts from the backend's expected shape (acceptanceCriteria as
 * `{text, met}` objects, idempotency key, transcript tail). Returns the
 * user-facing confirmation line.
 */
export async function createHandoffWorkItem(ctx: InteractiveCommandContext, input: HandoffWorkItemInput): Promise<string> {
  const payload = {
    title: input.title,
    prompt: `Handoff from sift interactive.\n\n${ctx.conversationText().slice(-4000)}`,
    assignedAlias: input.agent || "codex",
    inputContext: {
      cwd: ctx.cwd(),
      files: input.files,
      gitStatus: collectLocalGitSummary({cwd: ctx.cwd()}).status,
      transcriptTail: ctx.conversationText().slice(-4000),
    },
    acceptanceCriteria: input.acceptance.map((text) => ({text, met: false})),
    verificationCommands: input.verify ?? [],
  };
  const response = await ctx.apiClient.createWorkItem(payload, `interactive-${Date.now()}-${randomUUID()}`);
  const workItem = getData(response).workItem as Record<string, unknown> | undefined;
  return `Work item created: ${workItem?.id ?? "(unknown id)"} · ${input.title}`;
}

async function collectContext(ctx: InteractiveCommandContext, limit = 20): Promise<DailyReviewContext> {
  return collectDailyReviewContext(ctx.apiClient, {
    limit,
    cwd: ctx.cwd(),
  });
}

function summarizeFocus(context: DailyReviewContext): string {
  const sources = context.sources as Record<string, Record<string, unknown>>;
  const work = ((sources.workItems?.workItems ?? []) as Record<string, unknown>[]);
  const inProgress = ((sources.tasksInProgress?.tasks ?? []) as Record<string, unknown>[]);
  const open = ((sources.tasksOpenPhase?.tasks ?? []) as Record<string, unknown>[]);
  const calendar = ((sources.calendar?.events ?? []) as Record<string, unknown>[]);
  const gitStatus = context.localGit.status?.trim();
  const actions: string[] = [];

  const review = work.find((item) => item.status === "needs_review");
  if (review) actions.push(`Review agent work: ${review.title ?? review.id}`);
  const running = work.find((item) => item.status === "running" || item.status === "claimed");
  if (running) actions.push(`Unblock running work: ${running.title ?? running.id}`);
  const queued = work.find((item) => item.status === "queued");
  if (queued) actions.push(`Start or dispatch queued work: ${queued.title ?? queued.id}`);
  if (inProgress[0]) actions.push(`Advance active task: ${inProgress[0].title ?? inProgress[0].id}`);
  if (calendar[0]) actions.push(`Prepare for calendar item: ${calendar[0].title ?? calendar[0].id}`);
  if (gitStatus) actions.push("Resolve the current dirty git state before shipping.");
  if (open[0]) actions.push(`Pick next open task only if higher-priority work is clear: ${open[0].title ?? open[0].id}`);

  const unique = [...new Set(actions)].slice(0, 5);
  return [
    "Focus",
    ...unique.map((action, index) => `${index + 1}. ${action}`),
    context.coverage.unavailable.length ? `Unavailable: ${context.coverage.unavailable.map((s) => s.source).join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

function summarizeShip(ctx: InteractiveCommandContext): string {
  const gitSummary = collectLocalGitSummary({cwd: ctx.cwd()});
  const changed = gitSummary.status?.split("\n").filter(Boolean) ?? [];
  const packageHints = changed.some((line) => line.includes("packages/exf-cli"));
  const tests = [
    packageHints ? "npm run build --workspace @siftable/cli" : "npm run build --workspace exf-app",
    packageHints ? "npm test --workspace @siftable/cli -- --runInBand" : "npm test --workspace exf-app -- --runInBand",
  ];
  return [
    "Ship readiness",
    changed.length ? `Changed files: ${changed.length}` : "No git changes detected.",
    gitSummary.branch ? `Branch: ${gitSummary.branch}` : "",
    "Suggested checks:",
    ...tests.map((test) => `- ${test}`),
    "No tests were run. Run them explicitly before commit/push/deploy.",
  ].filter(Boolean).join("\n");
}

/** Human-readable result line(s) for a `/compact` run. */
function formatCompactionReport(report: CompactionReport): string {
  if (!report.ran) {
    return report.reason ? `Nothing to compact — ${report.reason}.` : "Nothing to compact.";
  }
  const before = report.beforeTokens ?? 0;
  const after = report.afterTokens ?? 0;
  const saved = Math.max(0, before - after);
  const pct = before > 0 ? Math.round((saved / before) * 100) : 0;
  const what: string[] = [];
  if (report.summarized) what.push("summarized older turns");
  if ((report.prunedMessages ?? 0) > 0) what.push(`pruned ${report.prunedMessages} tool output${report.prunedMessages === 1 ? "" : "s"}`);
  const action = what.length ? what.join(" + ") : "compacted";
  return `Compacted: ${action}.\n  context ~${before.toLocaleString()} → ~${after.toLocaleString()} tokens (−${saved.toLocaleString()}, ${pct}%).`;
}

function recap(ctx: InteractiveCommandContext, windowArg: string): string {
  const since = windowArg === "90d" || !windowArg ? "90 days ago" : windowArg;
  const summary = collectGitRecapSummary({cwd: ctx.cwd(), since});
  return [
    `Recap (${windowArg || "90d"})`,
    summary.commits || "No commit history found for that window.",
    summary.representativeFiles.length ? "\nRepresentative files:\n" + summary.representativeFiles.map((file) => `- ${file}`).join("\n") : "",
  ].filter(Boolean).join("\n");
}

function formatCollabBranch(branch: CollabBranchSnapshot): string {
  const worker = branch.worker ? ` · ${branch.worker}` : "";
  const error = branch.error ? ` · error: ${branch.error}` : "";
  return `  - #${branch.branchId} ${branch.role} · ${branch.status}${worker} · events ${branch.eventCount}${error}`;
}

function formatCollabSession(session: CollabSessionSnapshot): string {
  const counts = session.branches.reduce<Record<string, number>>((acc, branch) => {
    acc[branch.status] = (acc[branch.status] ?? 0) + 1;
    return acc;
  }, {});
  const status = Object.entries(counts).map(([key, value]) => `${key}:${value}`).join(" ");
  return [
    `session #${session.sessionId}${session.cancelled ? " · cancelled" : ""}`,
    `  root ${session.root}`,
    `  cwd  ${session.cwd}`,
    `  branches ${session.branches.length}/${session.maxBranches}${status ? ` · ${status}` : ""}`,
    ...session.branches.map(formatCollabBranch),
  ].join("\n");
}

function formatCollabSessions(sessions: CollabSessionSnapshot[]): string {
  if (!sessions.length) return "Collab sessions\nNo in-process collab sessions yet.";
  return ["Collab sessions", ...sessions.map(formatCollabSession)].join("\n\n");
}

async function runCrewSmoke(ctx: InteractiveCommandContext): Promise<string> {
  const root = ctx.workspaceRoot() || ctx.cwd();
  const result = await runSiftCrew({
    root,
    cwd: ctx.cwd(),
    name: "ui_smoke",
    process: "sequential",
    agents: [
      {id: "mapper", role: "Mapper", goal: "Produce a tiny deterministic map", prompt: "Map the current session."},
      {id: "checker", role: "Checker", prompt: "Check the map and summarize it."},
    ],
    tasks: [
      {id: "map", agent: "mapper", input: `Map cwd ${ctx.cwd()}`},
      {id: "check", agent: "checker", input: "Check the previous map output."},
    ],
    runTask: async ({task, input, priorResults, appendEvent}) => {
      appendEvent("crew_smoke_task", {taskId: task.id, priorResults: priorResults.length});
      if (task.id === "map") return `cwd=${ctx.cwd()}`;
      return `checked ${priorResults[0]?.output ?? input}`;
    },
    reduce: (results) => results.map((result) => `${result.taskId}:${result.status}`).join(", "),
  });
  return [
    "Crew smoke",
    `session: ${result.sessionId ?? "none"}`,
    `tasks:   ${result.output ?? "none"}`,
    ...result.taskResults.map((task) => `- ${task.taskId} [${task.agentId}] ${task.status}${task.error ? ` · ${task.error}` : ""}`),
  ].join("\n");
}

function registryOptions(ctx: InteractiveCommandContext) {
  return {cwd: ctx.cwd(), workspaceRoot: ctx.workspaceRoot() || undefined};
}

function parseCrewScope(raw: string | undefined): Exclude<CrewScope, "builtin"> {
  if (!raw || raw === "project") return "project";
  if (raw === "user" || raw === "personal") return "user";
  throw new Error("crew scope must be project or user");
}

function formatCrewDefinition(crew: SiftCrewDefinition): string {
  const location = crew.path ? `\npath:    ${crew.path}` : "";
  return [
    `${crew.name} (${crew.id})`,
    `scope:   ${crew.scope}`,
    `process: ${crew.process}`,
    `agents:  ${crew.agents.map((agent) => `${agent.id}:${agent.role}`).join(", ")}`,
    `tasks:   ${crew.tasks.map((task) => `${task.id}->${task.agent}${task.dependsOn?.length ? `[after ${task.dependsOn.join(",")}]` : ""}`).join(", ")}`,
    `about:   ${crew.description}${location}`,
  ].join("\n");
}

function formatCrewList(crews: SiftCrewDefinition[]): string {
  if (!crews.length) return "Crews\nNo crews found.";
  return [
    "Crews",
    ...crews.map((crew) => `- ${crew.id} · ${crew.scope} · ${crew.name} · ${crew.tasks.length} tasks · ${crew.process}`),
    "",
    "Create: /crew new <id> --scope project --template repo-investigation --name \"Name\"",
    "Run:    /crew run <id> <request>",
  ].join("\n");
}

async function runCrewDefinition(ctx: InteractiveCommandContext, crew: SiftCrewDefinition, request: string): Promise<string> {
  const root = ctx.workspaceRoot() || ctx.cwd();
  const tasks = crew.tasks.map((task) => ({
    ...task,
    input: renderCrewTaskTemplate(task.input, {input: request, cwd: ctx.cwd(), root}),
    dependsOn: task.dependsOn ? [...task.dependsOn] : undefined,
  }));
  const result = await runSiftCrew<string>({
    root,
    cwd: ctx.cwd(),
    name: crew.id,
    process: crew.process,
    agents: crew.agents,
    tasks,
    runTask: async ({agent, task, input, priorResults, appendEvent, heartbeat}) => {
      appendEvent("crew_agent_configured", {
        agentId: agent.id,
        role: agent.role,
        maxToolCalls: agent.maxToolCalls,
        maxElapsedMs: agent.maxElapsedMs,
      });
      const prompt = [
        `You are running as the Siftable crew agent "${agent.role}" (${agent.id}).`,
        agent.goal ? `Goal: ${agent.goal}` : "",
        "Follow this crew prompt:",
        agent.prompt,
        "",
        "Current Siftable session:",
        `- cwd: ${ctx.cwd()}`,
        `- root: ${root}`,
        `- model: ${ctx.model() || "(unknown)"}`,
        "",
        "Do not invoke /crew commands. Keep the answer scoped to this assigned crew task.",
        priorResults.length
          ? `\nPrior crew results:\n${priorResults.map((prior) => `- ${prior.taskId} (${prior.status}): ${prior.status === "failed" ? prior.error ?? "" : String(prior.output ?? "")}`).join("\n")}`
          : "",
        "",
        input,
      ].filter(Boolean).join("\n");
      let text = "";
      let fallback = "";
      let error: string | null = null;
      await ctx.client.send(prompt, (event) => {
        const delta = eventTextDelta(event);
        if (delta) text += delta;
        const recovered = doneFallbackText(event);
        if (recovered) fallback = recovered;
        if (event.type === "tool_call" && event.toolCall) {
          appendEvent("crew_model_tool_call", {taskId: task.id, tool: event.toolCall.name});
        } else if (event.type === "tool_result" && event.toolResult) {
          appendEvent("crew_model_tool_result", {taskId: task.id, tool: event.toolResult.name, success: event.toolResult.success !== false});
        } else if (event.type === "error") {
          error = event.error ?? "model error";
        }
      });
      if (error) throw new Error(error);
      heartbeat();
      const output = (text || fallback || "(no response)").trim();
      appendEvent("crew_model_response", {taskId: task.id, chars: output.length});
      return output;
    },
    reduce: (results) => {
      const final = [...results].reverse().find((task) => task.status === "completed" && task.output);
      return final?.output ?? results.map((task) => `${task.taskId}:${task.status}`).join(", ");
    },
  });
  return [
    `Crew ${crew.id}`,
    `session: ${result.sessionId ?? "none"}`,
    `tasks:   ${result.taskResults.map((task) => `${task.taskId}:${task.status}`).join(", ")}`,
    "",
    String(result.output ?? "").trim(),
  ].join("\n").trim();
}

async function runCrewCommand(ctx: InteractiveCommandContext, args: string[]): Promise<void> {
  const sub = (args[0] || "list").toLowerCase();
  const options = registryOptions(ctx);
  try {
    if (sub === "list" || sub === "ls") {
      ctx.push({role: "system", text: formatCrewList(listCrewDefinitions(options))});
      return;
    }
    if (sub === "show" || sub === "inspect") {
      const id = args[1];
      if (!id) {
        ctx.push({role: "system", text: "usage: /crew show <id>"});
        return;
      }
      const crew = getCrewDefinition(id, options);
      ctx.push({role: "system", text: crew ? formatCrewDefinition(crew) : `crew not found: ${id}`});
      return;
    }
    if (sub === "new" || sub === "create") {
      const id = args[1];
      if (!id) {
        ctx.push({
          role: "system",
          text: [
            "Create crew",
            "usage: /crew new <id> --scope project|user --template repo-investigation --name \"Name\"",
            `project path: ${crewStoragePath("project", options)}`,
            `user path:    ${crewStoragePath("user", options)}`,
          ].join("\n"),
        });
        return;
      }
      const crew = createCrewFromTemplate({
        ...options,
        id,
        templateId: flagValue(args, "--template") ?? "repo-investigation",
        scope: parseCrewScope(flagValue(args, "--scope")),
        name: flagValue(args, "--name"),
        description: flagValue(args, "--description"),
      });
      ctx.push({role: "system", text: [`Created crew ${crew.id}`, formatCrewDefinition(crew)].join("\n\n")});
      return;
    }
    if (sub === "run") {
      const id = args[1];
      const request = textArg(args.slice(2));
      if (!id || !request) {
        ctx.push({role: "system", text: "usage: /crew run <id> <request>"});
        return;
      }
      const crew = getCrewDefinition(id, options);
      if (!crew) {
        ctx.push({role: "system", text: `crew not found: ${id}`});
        return;
      }
      ctx.push({role: "system", text: `Running crew ${crew.id} (${crew.tasks.length} tasks, ${crew.process})...`});
      ctx.push({role: "system", text: await runCrewDefinition(ctx, crew, request)});
      return;
    }
    ctx.push({role: "system", text: "usage: /crew list | /crew show <id> | /crew new <id> | /crew run <id> <request>"});
  } catch (err) {
    ctx.push({role: "system", text: `/crew ${sub}: ${err instanceof Error ? err.message : String(err)}`});
  }
}

/**
 * Push a cell-render result as a system message. The renderer emits terminal
 * cells (Unicode box drawing / ASCII), which display verbatim in the opentui
 * `<text>` widget; on failure the precise `file:line:col` diagnostic is shown.
 */
function pushCellRender(ctx: InteractiveCommandContext, label: string, result: CellRenderResult): void {
  if (result.ok && result.text.trim()) {
    // Route through showDiagram so wide diagrams get a clipped preview + are
    // openable in the pannable /view overlay.
    ctx.showDiagram(result.text);
    return;
  }
  const detail = result.error?.trim() || "no output";
  ctx.push({role: "system", text: `${label}: ${detail}`});
}

/** Recognizes literal Mermaid source by its leading diagram header (supported subset). */
const MERMAID_HEADER_RE =
  /^\s*(flowchart|graph|sequenceDiagram|stateDiagram(-v2)?|classDiagram|erDiagram|mindmap|C4Context|C4Container|C4Component|architecture-beta|requirementDiagram|cardDiagram)\b/;

/**
 * Wrap a natural-language request as a diagram-generation instruction. Works on
 * any engine (codex or the OpenFunction brain) because the guidance travels in
 * the prompt — the reply's ```mermaid block is auto-rendered by the TUI.
 */
function mermaidRequestPrompt(request: string): string {
  return (
    "Draw a Mermaid diagram for the request below and reply with ONLY a ```mermaid fenced code block " +
    "(it will be auto-rendered in the terminal). Use the supported subset: flowchart/sequenceDiagram/" +
    "stateDiagram-v2/classDiagram/erDiagram/mindmap; node shapes [] () (()) {} only; no subgraph, style, " +
    "classDef, click, or <br/>; keep labels short.\n\nRequest: " +
    request
  );
}

/**
 * Wrap a natural-language objective as a planning instruction backed by the
 * `plan` skill. Engine-agnostic: the guidance travels in the prompt, the model
 * grounds itself in the four-lane Siftable map and replies with a plan card +
 * a ```mermaid flowchart (auto-rendered by the TUI). Read-only: it plans, it
 * does not mutate tasks or claim work.
 */
function planRequestPrompt(objective: string): string {
  return (
    "Use the `plan` skill to plan the objective below. Ground the plan in the Siftable map " +
    "(User Request → Siftable Assistant → Local Codebase / Sift Tasks / Notes & CRM / Agent Queue). " +
    "This is read-only planning: inspect and propose, do NOT edit files, mutate tasks, or claim work.\n\n" +
    "Reply with:\n" +
    "1. A short plan card (objective, critical path, biggest uncertainty, next approval point).\n" +
    "2. A ```mermaid flowchart TD of the plan graph (follow the mermaid skill's supported subset: " +
    "node shapes [] () (()) {} only; no subgraph/style/classDef/click/<br/>; keep labels short).\n" +
    "3. A structured plan: assumptions · context used · suggested sequence · parallelism · " +
    "critical path · risks · execution gates · verification.\n\n" +
    "Objective: " +
    objective
  );
}

/** Shared flag parsing for the `/mermaid` slash command. */
function mermaidOptionsFromArgs(args: string[]): MermaidRenderOptions {
  const truecolor = args.includes("--truecolor") || flagValue(args, "--color") === "truecolor";
  return {
    glyph: args.includes("--ascii") ? "ascii" : "unicode",
    color: truecolor ? "truecolor" : "none",
    maxWidth: 120,
    overflow: "clip",
  };
}

const interactiveCommandsBase: InteractiveCommand[] = [
  {
    name: "skills",
    description: "list available skills (or show one with /skills <name>)",
    usage: "[name]",
    run: (ctx, args) => {
      const skills = discoverSkills({projectRoot: ctx.workspaceRoot() || undefined, cwd: ctx.cwd()});
      const name = positionalArgs(args)[0];
      if (!name) {
        ctx.push({role: "system", text: formatSkillsList(skills)});
        return;
      }
      const loaded = loadSkill(name, skills);
      if (!loaded) {
        ctx.push({role: "system", text: `skill not found: ${name}\n\n${formatSkillsList(skills)}`});
        return;
      }
      const files = loaded.files.length ? `\n\nbundled: ${loaded.files.join(", ")}` : "";
      ctx.push({role: "system", text: `# ${loaded.info.name}  (${loaded.info.source})\n${loaded.info.path}\n\n${loaded.body}${files}`});
    },
  },
  {
    name: "preflight",
    description: "preview skill context for a prompt",
    usage: "<prompt>",
    run: async (ctx, args) => {
      const prompt = textArg(args);
      if (!prompt) {
        ctx.push({role: "system", text: "usage: /preflight <prompt>"});
        return;
      }
      const rendered = await renderSkillPreflight({
        userText: prompt,
        cwd: ctx.cwd(),
        workspaceRoot: ctx.workspaceRoot(),
        skills: discoverSkills({projectRoot: ctx.workspaceRoot() || undefined, cwd: ctx.cwd()}),
        apiClient: ctx.apiClient,
      });
      ctx.push({role: "system", text: rendered.text ? `${rendered.summary}\n\n${rendered.text}` : rendered.summary});
    },
  },
  {
    name: "mermaid",
    aliases: ["diagram"],
    description: "diagram something — ask the agent to draw it, or render a file / .mmd source",
    usage: "[request | file.mmd | mermaid source]",
    run: (ctx, args) => {
      const opts = mermaidOptionsFromArgs(args);
      const text = textArg(positionalArgs(args));

      // No args → render the ```mermaid blocks from the last assistant reply.
      if (!text) {
        const blocks = extractMermaidBlocks(ctx.latestAssistantText());
        if (blocks.length === 0) {
          ctx.push({
            role: "system",
            text: "usage: /mermaid <what to diagram>  ·  e.g. /mermaid our deploy pipeline  ·  or /mermaid <file.mmd>  ·  or /mermaid with no args to render the last reply's diagram",
          });
          return;
        }
        blocks.forEach((block, i) => {
          pushCellRender(ctx, blocks.length > 1 ? `mermaid #${i + 1}` : "mermaid", renderMermaidSource(block, opts));
        });
        return;
      }

      // A real file path → render it directly.
      const resolved = isAbsolute(text) ? text : join(ctx.cwd(), text);
      if (/\.mmd$/i.test(text) || existsSync(resolved)) {
        pushCellRender(ctx, "mermaid", renderMermaidFile(resolved, opts));
        return;
      }

      // Literal Mermaid source (starts with a supported header) → render directly.
      if (MERMAID_HEADER_RE.test(text)) {
        pushCellRender(ctx, "mermaid", renderMermaidSource(text, opts));
        return;
      }

      // Otherwise it's a natural-language request → ask the agent to draw it.
      // The agent replies with a ```mermaid block, which the TUI auto-renders.
      ctx.submit(mermaidRequestPrompt(text), `/mermaid ${text}`);
    },
  },
  {
    name: "view",
    description: "open the last diagram in a pannable full-screen viewer",
    run: (ctx) => {
      if (!ctx.viewLastDiagram()) {
        ctx.push({role: "system", text: "no diagram to view yet — render one with /mermaid first"});
      }
    },
  },
];

// ── child-session (/spawn · /children · /enter · /leave) helpers ─────────────

interface ParsedSpawn {
  title: string;
  accessMode: "read_only" | "read_write";
  writeScope?: string[];
  /** read_write explicitly opted out of a scope (unserialized). */
  rwAny: boolean;
  error?: string;
}

/**
 * Parse `/spawn <title> [--rw <globs> | --rw-any | --ro]`. The default is
 * read_write, which REQUIRES a scope (`--rw`) so Gate-A can serialize writers;
 * `--rw-any` is the explicit escape hatch that creates an unserialized writer,
 * and `--ro` makes a read-only child (no worktree write, no scope needed).
 */
function parseSpawnArgs(args: string[]): ParsedSpawn {
  const titleParts: string[] = [];
  const scope: string[] = [];
  let ro = false;
  let rwAny = false;
  let sawRw = false;
  let i = 0;
  while (i < args.length && !args[i].startsWith("--")) titleParts.push(args[i++]);
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--ro" || a === "--read-only") ro = true;
    else if (a === "--rw-any") rwAny = true;
    else if (a === "--rw" || a === "--read-write") {
      sawRw = true;
      while (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        scope.push(...args[++i].split(",").map((s) => s.trim()).filter(Boolean));
      }
    } else {
      return {title: titleParts.join(" ").trim(), accessMode: "read_write", rwAny: false, error: `unknown flag ${a}`};
    }
  }
  const title = titleParts.join(" ").trim();
  if (ro) return {title, accessMode: "read_only", rwAny: false};
  if (sawRw) {
    if (scope.length === 0) {
      return {title, accessMode: "read_write", rwAny: false, error: "--rw needs at least one path glob (or use --rw-any)"};
    }
    return {title, accessMode: "read_write", writeScope: scope, rwAny: false};
  }
  if (rwAny) return {title, accessMode: "read_write", rwAny: true};
  return {
    title,
    accessMode: "read_write",
    rwAny: false,
    error: "a write-capable child needs --rw <globs> (or --rw-any to skip serialization, or --ro for read-only)",
  };
}

const SPAWN_USAGE = "/spawn <title> [--rw <globs> | --rw-any | --ro]";

function spawnCommand(ctx: InteractiveCommandContext, args: string[]): void {
  const parsed = parseSpawnArgs(args);
  if (!parsed.title) {
    ctx.push({role: "system", text: SPAWN_USAGE});
    return;
  }
  if (parsed.error) {
    ctx.push({role: "system", text: `/spawn: ${parsed.error}\n${SPAWN_USAGE}`});
    return;
  }
  const res = ctx.sessions.spawn({
    title: parsed.title,
    accessMode: parsed.accessMode,
    writeScope: parsed.writeScope,
  });
  if (!res.ok) {
    const extra = res.blockedBy ? ` (blocked by child #${res.blockedBy})` : "";
    ctx.push({role: "system", text: `/spawn blocked: ${res.reason}${extra}`});
    return;
  }
  const s = res.session;
  const warn =
    s.accessMode === "read_write" && s.writeScope.length === 0
      ? "\n⚠ read_write with no scope (--rw-any): not serialized against other writers."
      : "";
  ctx.push({
    role: "system",
    text: `spawned child #${s.sessionId} · ${s.branch}\n  worktree: ${s.worktreePath}${warn}\n  /enter ${s.sessionId} to work in it`,
  });
}

function formatChildren(ctx: InteractiveCommandContext): string {
  const list = ctx.sessions.list();
  if (!list.length) return "No child branches. /spawn <title> --rw <globs> to start one; /branches to review.";
  const active = ctx.sessions.activeChildId();
  const rows = list.map((c: ChildSessionView) => {
    const marker = c.sessionId === active ? "▶" : " ";
    const scope = c.writeScope.length
      ? ` [${c.writeScope.join(", ")}]`
      : c.accessMode === "read_write"
        ? " [unscoped]"
        : " [ro]";
    return `${marker} #${c.sessionId}  ${c.status.padEnd(13)} ${c.branch}${scope}`;
  });
  return ["Child sessions (/enter <id> · /leave):", ...rows].join("\n");
}

function enterCommand(ctx: InteractiveCommandContext, args: string[]): void {
  const id = Number(args[0]);
  if (!args[0] || !Number.isInteger(id)) {
    ctx.push({role: "system", text: "/enter <session-id>  (see /children)"});
    return;
  }
  const res = ctx.sessions.enter(id);
  if (!res.ok || !res.session) {
    ctx.push({role: "system", text: `/enter: ${res.reason ?? "could not enter session"}`});
    return;
  }
  const s = res.session;
  ctx.push({
    role: "system",
    text: `entered child #${s.sessionId} · ${s.branch}\n  cwd → ${s.worktreePath}\n  /leave to return to the parent`,
  });
}

function leaveCommand(ctx: InteractiveCommandContext): void {
  const res = ctx.sessions.leave();
  if (!res.ok) {
    ctx.push({role: "system", text: `/leave: ${res.reason ?? "not in a child session"}`});
    return;
  }
  ctx.push({role: "system", text: "left child — back in the parent session."});
}

const READY_USAGE = "/ready [<session-id>] [--commit]";

/** Render a merge packet as a compact, human-readable status block. */
function formatPacket(p: MergePacket): string {
  const head = p.verdict === "ready_to_merge" ? "✓ ready to merge" : "✗ merge blocked";
  const stat = `${p.files.length} file(s), +${p.totalAdditions} −${p.totalDeletions}`;
  const drift = p.behindBy > 0 ? `, base +${p.behindBy} ahead` : "";
  const lines = [`#${p.childSessionId} ${p.childBranch} → ${p.baseBranch}: ${head}`, `  ${stat}${drift}`];
  for (const b of p.blockers) lines.push(`  • ${b}`);
  return lines.join("\n");
}

function resolveTargetChild(ctx: InteractiveCommandContext, raw: string | undefined): {id: number} | {error: string} {
  if (raw) {
    const id = Number(raw);
    if (!Number.isInteger(id)) return {error: `not a session id: ${raw}`};
    return {id};
  }
  const active = ctx.sessions.activeChildId();
  if (active == null) return {error: "no active child — pass a session id (see /children) or /enter one"};
  return {id: active};
}

function readyCommand(ctx: InteractiveCommandContext, args: string[]): void {
  const autoCommit = args.includes("--commit");
  const idArg = args.find((a) => !a.startsWith("--"));
  const target = resolveTargetChild(ctx, idArg);
  if ("error" in target) {
    ctx.push({role: "system", text: `/ready: ${target.error}\n${READY_USAGE}`});
    return;
  }
  const res = ctx.sessions.review(target.id, {autoCommit});
  if (!res.ok) {
    ctx.push({role: "system", text: `/ready: ${res.reason}`});
    return;
  }
  let text = formatPacket(res.packet);
  if (res.committed) text = `committed working changes first.\n${text}`;
  // If blocked solely because the tree is dirty, point at the one-step fix.
  if (res.packet.verdict === "merge_blocked" && res.packet.dirty && !autoCommit) {
    text += `\n  → run /ready ${target.id} --commit to commit + re-check`;
  }
  if (res.note) text += `\n  (${res.note})`;
  ctx.push({role: "system", text});
}

const MERGE_USAGE = '/merge [<session-id>] [--keep] [-m "message"]';

/**
 * Parse `/merge` args. `-m` consumes the next token as the message (quotes are
 * already stripped by parseCommandArgs, so a quoted phrase arrives as one token);
 * `--keep` retains the worktree+branch; the first remaining bare token is the id.
 * With no id, the command renders the dashboard rather than landing anything.
 */
export function parseMergeArgs(args: string[]): {id?: number; keep: boolean; message?: string; error?: string} {
  let keep = false;
  let message: string | undefined;
  let id: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === "--keep") {
      keep = true;
    } else if (tok === "-m" || tok === "--message") {
      message = args[++i]; // may be undefined if -m is trailing; harmless
    } else if (tok.startsWith("-")) {
      return {keep, message, error: `unknown flag: ${tok}`};
    } else if (id === undefined) {
      const n = Number(tok);
      if (!Number.isInteger(n)) return {keep, message, error: `not a session id: ${tok}`};
      id = n;
    }
  }
  return {id, keep, message};
}

/** Render the parent merge dashboard (ready-first, with counts + ready totals). */
function formatMergeView(view: ParentMergeView): string {
  if (view.rows.length === 0) return "No child branches yet. /spawn one, then /branches to review and land.";
  const rows = view.rows.map((r) => {
    const mark = r.verdict === "ready_to_merge" ? "✓" : r.verdict === "merge_blocked" ? "✗" : "·";
    const stat = r.verdict ? `${r.files} file(s), +${r.additions} −${r.deletions}` : r.status;
    const drift = r.behindBy > 0 ? `, base +${r.behindBy}` : "";
    const head = `${mark} #${r.sessionId} ${r.branch} → ${r.baseBranch}: ${stat}${drift}`;
    return r.blockers.length ? [head, ...r.blockers.map((b) => `    • ${b}`)].join("\n") : head;
  });
  const footer = `${view.readyCount} ready · ${view.blockedCount} blocked` +
    (view.readyCount > 0 ? `  (+${view.totalAdditions} −${view.totalDeletions} if all land)` : "");
  return ["Branches (/branches to open · /merge <id> to land · --keep to retain):", ...rows, footer].join("\n");
}

function mergeCommand(ctx: InteractiveCommandContext, args: string[]): void {
  const parsed = parseMergeArgs(args);
  if (parsed.error) {
    ctx.push({role: "system", text: `/merge: ${parsed.error}\n${MERGE_USAGE}`});
    return;
  }
  // No id → dashboard.
  if (parsed.id === undefined) {
    ctx.push({role: "system", text: formatMergeView(ctx.sessions.mergeView())});
    return;
  }
  const res = ctx.sessions.merge(parsed.id, {keep: parsed.keep, message: parsed.message});
  if (!res.ok) {
    let text = `/merge: ${res.reason}`;
    if (res.packet) text = `${formatPacket(res.packet)}\n  → ${res.reason}`;
    ctx.push({role: "system", text});
    return;
  }
  const sha = res.baseCommit.slice(0, 7);
  const tail = res.cleaned ? "worktree + branch removed" : "worktree + branch kept";
  const verb = res.merged ? "merged" : "already up-to-date";
  let text = `${verb} #${parsed.id} → ${res.packet.baseBranch} (${sha}) · ${tail}`;
  if (res.note) text += `\n  (${res.note})`;
  ctx.push({role: "system", text});
}

const REBASE_USAGE = "/rebase [<session-id>]";
const SENDBACK_USAGE = '/sendback [<session-id>] <instructions>';
const REJECT_USAGE = "/reject [<session-id>] [reason]";

function rebaseCommand(ctx: InteractiveCommandContext, args: string[]): void {
  const target = resolveTargetChild(ctx, args.find((a) => !a.startsWith("-")));
  if ("error" in target) {
    ctx.push({role: "system", text: `/rebase: ${target.error}\n${REBASE_USAGE}`});
    return;
  }
  const res = ctx.sessions.rebase(target.id);
  if (!res.ok) {
    let text = `/rebase: ${res.reason}`;
    if (res.conflicts?.length) text += `\n  conflicts: ${res.conflicts.join(", ")}\n  → /sendback ${target.id} <how to resolve>`;
    ctx.push({role: "system", text});
    return;
  }
  const verb = res.rebased ? "rebased" : "already current";
  const tail = res.verdict === "ready_to_merge" ? "→ ready to merge" : `→ ${res.verdict}`;
  ctx.push({role: "system", text: `${verb} #${target.id} onto base (${res.headCommit.slice(0, 7)}) ${tail}`});
}

function sendBackCommand(ctx: InteractiveCommandContext, args: string[]): void {
  // First bare token may be the id; the rest is the free-text instruction. With
  // an active child and no leading id, the whole arg string is the instruction.
  const active = ctx.sessions.activeChildId();
  let idArg: string | undefined;
  let rest = args;
  if (args[0] !== undefined && Number.isInteger(Number(args[0]))) {
    idArg = args[0];
    rest = args.slice(1);
  } else if (active == null) {
    ctx.push({role: "system", text: `/sendback: no active child — pass a session id\n${SENDBACK_USAGE}`});
    return;
  }
  const target = resolveTargetChild(ctx, idArg);
  if ("error" in target) {
    ctx.push({role: "system", text: `/sendback: ${target.error}\n${SENDBACK_USAGE}`});
    return;
  }
  const instruction = rest.join(" ").trim();
  if (!instruction) {
    ctx.push({role: "system", text: `/sendback: needs instructions to post to the child\n${SENDBACK_USAGE}`});
    return;
  }
  const res = ctx.sessions.sendBack(target.id, instruction);
  if (!res.ok) {
    ctx.push({role: "system", text: `/sendback: ${res.reason}`});
    return;
  }
  const posted = res.posted ? "instructions posted to its thread" : "instructions not persisted (thread off)";
  ctx.push({role: "system", text: `sent #${target.id} back to work (running) · ${posted}`});
}

function rejectCommand(ctx: InteractiveCommandContext, args: string[]): void {
  const idArg = args.find((a) => !a.startsWith("-"));
  const target = resolveTargetChild(ctx, idArg);
  if ("error" in target) {
    ctx.push({role: "system", text: `/reject: ${target.error}\n${REJECT_USAGE}`});
    return;
  }
  // Anything after the id is a free-text reason (recorded, worktree retained).
  const reason = args.filter((a) => a !== idArg && !a.startsWith("-")).join(" ").trim() || undefined;
  const res = ctx.sessions.reject(target.id, reason);
  if (!res.ok) {
    ctx.push({role: "system", text: `/reject: ${res.reason}`});
    return;
  }
  ctx.push({role: "system", text: `rejected #${target.id} (terminal) · worktree + branch kept for inspection`});
}

export const interactiveCommands: InteractiveCommand[] = [
  ...interactiveCommandsBase,
  {
    name: "help",
    description: "show commands",
    run: (ctx) => {
      const sections = commandGroups().map((group) => {
        const lines = group.commands
          .map((cmd) => `  /${cmd.name}${cmd.usage ? ` ${cmd.usage}` : ""} · ${cmd.description}`);
        return `${group.title}:\n${lines.join("\n")}`;
      });
      ctx.push({
        role: "system",
        text: `Commands:\n\n${sections.join("\n\n")}\n\nAlso: !<cmd> runs a shell command · Enter while busy queues a message.`,
      });
    },
  },
  {name: "hotkeys", aliases: ["keys"], description: "show keyboard shortcuts", run: (ctx) => ctx.push({role: "system", text: HOTKEYS})},
  {
    name: "status",
    description: "model, scope, agents, auth",
    run: (ctx) => {
      const agents = ctx.agents();
      const root = ctx.workspaceRoot();
      // Report the real boundary, not a fictional jail: reads are broad,
      // writes are confined to the repo root and approval-gated (codex runs
      // workspace-write and asks on escalation; the brain's write tools prompt).
      const writeScope = root ? `${root} (approval-gated)` : "disabled (no workspace root)";
      ctx.push({
        role: "system",
        text:
          `model:   ${ctx.model() || "(unknown)"}\n` +
          `workdir: ${ctx.cwd()}\n` +
          `root:    ${ctx.workspaceRoot() || "(none)"}\n` +
          `read:    repo + machine-wide, read-only\n` +
          `write:   ${writeScope}\n` +
          `agents:  ${agents.length ? agents.map((x) => `${x.assignedAlias ?? x.agentType}·${x.state}`).join(", ") : "none"}\n` +
          `queued:  ${ctx.queuedCount()}\n` +
          `brain:   ${ctx.baseUrl}`,
      });
    },
  },
  {
    name: "cwd",
    description: "show or change the working directory",
    usage: "[path]",
    run: (ctx, args) => {
      const target = args.join(" ").trim();
      if (!target) {
        ctx.push({role: "system", text: `workdir: ${ctx.cwd()}\nroot:    ${ctx.workspaceRoot() || "(none)"}`});
        return;
      }
      try {
        ctx.setCwd(target);
        ctx.push({role: "system", text: `workdir → ${ctx.cwd()}\nroot → ${ctx.workspaceRoot() || "(none)"}`});
      } catch (err) {
        ctx.push({role: "system", text: `/cwd: ${err instanceof Error ? err.message : String(err)}`});
      }
    },
  },
  {
    name: "copy",
    description: "copy response/transcript",
    usage: "[last|all|explorer]",
    run: async (ctx, args) => {
      const target = (args[0] || "last").toLowerCase();
      const text =
        target === "all" || target === "transcript"
          ? ctx.conversationText()
          : target === "explorer"
            ? ctx.latestExplorerReport()
            : ctx.latestAssistantText();
      ctx.push({role: "system", text: await ctx.copyText(text)});
    },
  },
  {
    name: "branches",
    aliases: ["b"],
    description: "review child branches and land the ready ones",
    run: (ctx) => ctx.push({role: "system", text: formatMergeView(ctx.sessions.mergeView())}),
  },
  {
    name: "spawn",
    description: "start a child branch in its own worktree",
    usage: "<title> [--rw <globs> | --rw-any | --ro]",
    run: (ctx, args) => spawnCommand(ctx, args),
  },
  {
    // Folded into /branches; kept as a typeable + scriptable alias (hidden from
    // /help and the slash palette). Same for /enter, /leave, /ready below.
    name: "children",
    aliases: ["kids"],
    hidden: true,
    description: "list mergeMaster child sessions",
    run: (ctx) => ctx.push({role: "system", text: formatChildren(ctx)}),
  },
  {
    name: "enter",
    hidden: true,
    description: "enter a child session by id (worktree cwd + its own thread)",
    usage: "<session-id>",
    run: (ctx, args) => enterCommand(ctx, args),
  },
  {
    name: "leave",
    hidden: true,
    description: "leave the active child session, back to the parent",
    run: (ctx) => leaveCommand(ctx),
  },
  {
    name: "ready",
    hidden: true,
    description: "run the ready-to-merge gate on a child (sets ready/blocked)",
    usage: "[<session-id>] [--commit]",
    run: (ctx, args) => readyCommand(ctx, args),
  },
  {
    name: "merge",
    description: "land a ready child onto the base (squash-merge), or show the merge view",
    usage: '[<session-id>] [--keep] [-m "message"]',
    run: (ctx, args) => mergeCommand(ctx, args),
  },
  {
    name: "rebase",
    description: "replay a blocked child onto the moved base (auto-aborts on conflict)",
    usage: "[<session-id>]",
    run: (ctx, args) => rebaseCommand(ctx, args),
  },
  {
    name: "sendback",
    description: "send a reviewed child back to work with instructions",
    usage: "[<session-id>] <instructions>",
    run: (ctx, args) => sendBackCommand(ctx, args),
  },
  {
    name: "reject",
    description: "reject a reviewed child (terminal, but keeps its worktree for inspection)",
    usage: "[<session-id>] [reason]",
    run: (ctx, args) => rejectCommand(ctx, args),
  },
  {name: "clear", description: "clear the conversation", run: (ctx) => ctx.setMessages([{role: "system", text: "cleared."}])},
  {
    name: "threads",
    description: "show or clear the persisted conversation for this workspace",
    usage: "/threads [clear]",
    run: (ctx, args) => {
      if (process.env.SIFT_CONTEXT_COMPACTION === "0") {
        ctx.push({role: "system", text: "Thread persistence is off. Set SIFT_CONTEXT_COMPACTION=1 to enable resume."});
        return;
      }
      const key = ctx.workspaceRoot() || ctx.cwd();
      const path = rolloutPathForKey(homedir(), key);
      if (args[0] === "clear") {
        if (existsSync(path)) rmSync(path);
        ctx.push({role: "system", text: `Cleared persisted thread for ${key}.`});
        return;
      }
      if (!existsSync(path)) {
        ctx.push({role: "system", text: `No persisted thread yet for ${key}. It will be saved as you chat.`});
        return;
      }
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      const turns = lines.filter((l) => l.startsWith('{"r":0')).length;
      ctx.push({
        role: "system",
        text: `Persisted thread for ${key}\n  ${turns} turn(s), ${lines.length} message(s)\n  ${path}\n  (resumes automatically next session · /threads clear to reset)`,
      });
    },
  },
  {
    name: "compact",
    aliases: ["compress"],
    description: "summarize older turns now to free up context",
    run: async (ctx) => {
      ctx.push({role: "system", text: "Compacting conversation…"});
      try {
        const report = await ctx.compactThread();
        ctx.push({role: "system", text: formatCompactionReport(report)});
      } catch (e) {
        ctx.push({role: "system", text: `Compaction failed: ${e instanceof Error ? e.message : String(e)}`});
      }
    },
  },
  {
    name: "theme",
    aliases: ["appearance", "themes"],
    description: "change the color scheme",
    run: (ctx) =>
      ctx.push({
        role: "system",
        text: "Press Enter on /theme to open the appearance picker (↑/↓ preview · Enter save · Esc cancel).",
      }),
  },
  {
    name: "sounds",
    aliases: ["sound"],
    description: "toggle UI sound effects (on/off)",
    usage: "[on|off]",
    run: (ctx) =>
      ctx.push({
        role: "system",
        text: "Press Enter on /sounds to toggle UI sound effects, or /sounds on|off.",
      }),
  },
  {name: "quit", aliases: ["exit", "q"], description: "exit", run: (ctx) => ctx.quit()},
  {
    name: "model",
    aliases: ["models"],
    description: "pick model + reasoning effort",
    usage: "[id] [effort]",
    run: async (ctx, args) => {
      // Allow a trailing effort token: `/model gpt-5.4-mini high`.
      const KNOWN_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
      let effort: string | undefined;
      let parts = [...args];
      if (parts.length >= 2 && KNOWN_EFFORTS.has(parts[parts.length - 1].toLowerCase())) {
        effort = parts.pop()!.toLowerCase();
      }
      const id = textArg(parts);
      if (!id) {
        const lines = modelSuggestions().map((choice) => `- ${choice.id.padEnd(40)} ${choice.label} · ${choice.desc}`);
        ctx.push({
          role: "system",
          text:
            `current model: ${ctx.model() || "(unknown)"}\n` +
            `Press Enter on /model to open the picker (↑/↓ model · ←/→ reasoning · Enter select).\n` +
            `Known models:\n${lines.join("\n")}\n` +
            `Or type one directly: /model <id> [effort].`,
        });
        return;
      }
      await selectModel(ctx, id, effort);
    },
  },
  {
    name: "explorer",
    aliases: ["explore"],
    description: "configure repo Explorer",
    run: (ctx) => {
      ctx.push({
        role: "system",
        text: "Press Enter on /explorer to open the picker (↑/↓ navigate · Enter select · Esc close).",
      });
    },
  },
  {
    name: "login",
    description: "log in to Siftable",
    run: async (ctx) => {
      try {
        const {verificationUri, userCode} = await ctx.client.login();
        ctx.setAwaitingLogin(true);
        ctx.push({
          role: "system",
          text:
            `Opening your browser to log in to Siftable...\n` +
            `If it doesn't open, visit: ${verificationUri}\n` +
            `Verification code: ${userCode}\n` +
            `I'll confirm here once you're signed in.`,
        });
      } catch (err) {
        ctx.push({role: "system", text: `/login: ${err instanceof Error ? err.message : String(err)}`});
      }
    },
  },
  {
    name: "key",
    description: "add a model provider key",
    usage: "<provider> <key> | vault <provider>",
    run: async (ctx, args) => {
      if (args[0] === "vault") {
        const provider = args[1];
        if (!provider) {
          ctx.push({role: "system", text: "usage: /key vault <provider>  (e.g. /key vault openrouter)"});
          return;
        }
        const result = await hydrateProviderKeyFromVault(ctx, provider, providerKeyEnv(provider));
        ctx.push({role: "system", text: result.message});
        return;
      }
      if (args.length < 2) {
        ctx.push({role: "system", text: "usage: /key <provider> <key>  (e.g. /key openrouter sk-...) or /key vault <provider>"});
        return;
      }
      try {
        const provider = args[0];
        const secret = args.slice(1).join(" ");
        if (isBrainProvider(provider)) {
          await ctx.client.config({provider, apiKey: secret});
          ctx.push({role: "system", text: `stored ${provider} API key for the model brain.`});
        } else {
          // Search-only providers (e.g. morph for warp-grep) aren't served by the
          // brain — set the env var directly instead of switching the brain to an
          // unknown provider.
          process.env[providerKeyEnv(provider)] = secret;
          ctx.push({role: "system", text: `stored ${provider} key as ${providerKeyEnv(provider)} for this session.`});
        }
      } catch (err) {
        ctx.push({role: "system", text: `/key failed: ${err instanceof Error ? err.message : String(err)}`});
      }
    },
  },
  {
    name: "codex",
    description: "Codex account/status: login · logout",
    usage: "[login|on|off|logout]",
    run: async (ctx, args) => {
      if (!ctx.client.codexStatus || !ctx.client.codexLogin) {
        ctx.push({ role: "system", text: "Codex is only available in local mode (`sift interactive`)." });
        return;
      }
      const sub = (args[0] || "status").toLowerCase();

      if (sub === "login") {
        try {
          const { verificationUri, userCode, completion } = await ctx.client.codexLogin();
          ctx.push({
            role: "system",
            text:
              `Opening your browser to sign in to Codex (ChatGPT)...\n` +
              `If it doesn't open, visit: ${verificationUri}\n` +
              `Verification code: ${userCode}\n` +
              `I'll confirm here once you're signed in.`,
          });
          completion?.then(async (result) => {
            if (result.success) {
              // Sign-in implies intent to use Codex — make it the active engine.
              if (ctx.client.codexSetActive) {
                const model = await ctx.client.codexSetActive(true);
                ctx.setModel(model.model);
              }
              ctx.push({ role: "system", text: `✓ Signed in to Codex${result.email ? ` as ${result.email}` : ""}. Codex is now your engine.` });
            } else {
              ctx.push({ role: "system", text: `Codex login failed${result.error ? `: ${result.error}` : "."}` });
            }
          });
        } catch (err) {
          ctx.push({ role: "system", text: `/codex login: ${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }

      if (sub === "on" || sub === "use") {
        await selectModel(ctx, "codex/gpt-5.6-sol");
        return;
      }

      if (sub === "off") {
        if (!ctx.client.codexSetActive) {
          ctx.push({ role: "system", text: "Codex engine switching is unavailable in this mode." });
          return;
        }
        const model = await ctx.client.codexSetActive(false);
        ctx.setModel(model.model);
        ctx.push({ role: "system", text: `Codex engine off — back to ${model.provider}/${model.model}.` });
        return;
      }

      if (sub === "logout") {
        await ctx.client.codexLogout?.();
        ctx.push({ role: "system", text: "Signed out of Codex." });
        return;
      }

      // status (default)
      const status = await ctx.client.codexStatus();
      if (!status.installed) {
        ctx.push({ role: "system", text: "Codex CLI: not found. Install it (https://developers.openai.com/codex)." });
        return;
      }
      const acct = status.account
        ? `signed in as ${status.account.email ?? status.account.type}${status.account.planType ? ` (${status.account.planType})` : ""}`
        : "not signed in — run /codex login";
      ctx.push({
        role: "system",
        text:
          `Codex (ChatGPT engine)\n` +
          `account: ${acct}\n` +
          `engine:  ${status.active ? `active · ${status.model}` : "not selected — run /model codex/gpt-5.6-sol"}`,
      });
    },
  },
  {
    name: "plan",
    description: "plan visually — agent work queue (deterministic) or a natural-language objective",
    usage: "[objective | work [--apply] [--after SRC:DST] [--limit N] | view]",
    run: async (ctx, args) => {
      const sub = (args[0] ?? "").toLowerCase();
      if (sub === "view") {
        if (!ctx.viewLastDiagram()) {
          ctx.push({role: "system", text: "no plan diagram to view yet — run /plan first"});
        }
        return;
      }
      if (sub === "task") {
        ctx.push({
          role: "system",
          text: "/plan task (human-task planning with confirm-gated mutations) is not wired yet. Use /plan work to plan the agent queue.",
        });
        return;
      }

      // A free-text objective (anything that isn't bare /plan, /plan work, or
      // bare flags) → ask the agent to plan it via the `plan` skill. It replies
      // with a plan card + a ```mermaid block that the TUI auto-renders.
      const positional = positionalArgs(args);
      if (positional.length && sub !== "work") {
        const objective = positional.join(" ").trim();
        ctx.submit(planRequestPrompt(objective), `/plan ${objective}`);
        return;
      }
      const limit = Math.max(1, Math.min(100, Number(flagValue(args, "--limit")) || 50));
      const response = await ctx.apiClient.listWorkItems({limit});
      const rows = listFrom(response, "workItems");
      const items: RawWorkItem[] = rows.map((row) => ({
        id: String(row.id ?? ""),
        title: (row.title ?? null) as string | null,
        prompt: (row.prompt ?? null) as string | null,
        status: (row.status ?? null) as string | null,
        taskId: (row.taskId ?? row.task_id ?? null) as string | null,
        queueRank: (row.queueRank ?? row.queue_rank ?? null) as number | null,
        writeScope: (row.writeScope ?? row.write_scope ?? null) as Record<string, unknown> | null,
        verificationCommands: (row.verificationCommands ?? row.verification_commands ?? null) as string[] | null,
      }));

      // Durable precedence overlay lives in the repo (.siftable/plans/overlay.json).
      const root = ctx.workspaceRoot() || ctx.cwd();
      const overlay = loadPlanOverlay(root);
      const declaredEdges = overlay.declaredEdges.map((e) => ({source: e.source, target: e.target}));
      const notices: string[] = [];

      // --after SRC:DST teaches a precedence the planner can't infer from scope.
      const taught: DeclaredEdge[] = [];
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] !== "--after") continue;
        const spec = args[i + 1] ?? "";
        const [srcRef, dstRef] = spec.split(":");
        if (!srcRef || !dstRef) {
          notices.push(`--after expects SRC:DST, got "${spec}"`);
          continue;
        }
        const src = resolveWorkItemRef(items, srcRef);
        const dst = resolveWorkItemRef(items, dstRef);
        if ("error" in src) { notices.push(`--after: ${src.error}`); continue; }
        if ("error" in dst) { notices.push(`--after: ${dst.error}`); continue; }
        taught.push({source: src.id, target: dst.id, note: `declared via --after (${srcRef}:${dstRef})`});
      }

      // Validate that taught edges don't create a precedence cycle before saving.
      if (taught.length) {
        const trial = planAgentWork(items, {declaredEdges: [...declaredEdges, ...taught]});
        if (trial.snapshot.status === "blocked" && trial.snapshot.invalidCycles.length) {
          notices.push("Refused to record --after edge(s): would create a precedence cycle.");
          taught.length = 0;
        } else {
          const {added} = addDeclaredEdges(root, taught);
          declaredEdges.push(...added.map((e) => ({source: e.source, target: e.target})));
          notices.push(`Recorded ${added.length} precedence edge(s) from --after.`);
        }
      }

      // --apply promotes the planner's derived edges (lane chains, sibling rank)
      // into durable declared edges so they survive and stay inspectable.
      if (args.includes("--apply")) {
        const {derivedHardEdges} = buildAgentWorkGraph(items, {declaredEdges});
        const {added} = addDeclaredEdges(
          root,
          derivedHardEdges.map((e) => ({source: e.source, target: e.target, note: "derived: lane/sibling order"})),
        );
        declaredEdges.push(...added.map((e) => ({source: e.source, target: e.target})));
        notices.push(
          added.length
            ? `Applied: persisted ${added.length} derived precedence edge(s) to ${root}/.siftable/plans/overlay.json`
            : "Applied: no new derived edges to persist (already recorded).",
        );
        notices.push("Note: work-item queue rank is not writable via the API; precedence is enforced at spawn time by Gate A and reflected in the order below.");
      }

      const {text, mermaid} = planAgentWork(items, {declaredEdges});
      const header = notices.length ? notices.join("\n") + "\n\n" : "";
      ctx.push({role: "system", text: header + text});

      // Draw the computed plan graph (the real precedence DAG) so the plan is
      // visual, not just a report. Routes through showDiagram → clipped preview
      // + pannable /view (or /plan view). ★ marks critical-path nodes.
      if (mermaid) {
        const rendered = renderMermaidSource(mermaid, {
          glyph: "unicode",
          color: "none",
          maxWidth: 120,
          overflow: "clip",
        });
        if (rendered.ok && rendered.text.trim()) ctx.showDiagram(rendered.text);
      }
    },
  },
  {
    name: "work",
    aliases: ["w"],
    description: "the agent work-queue hub — board, plan, focus, proof, handoff",
    run: async (ctx) => {
      // Text fallback. The TUI intercepts bare /work (index.tsx) to open the
      // arrow-navigable hub overlay; this body serves non-overlay contexts
      // (scripts, pipes) by printing the board the overlay would show.
      const {agents, items} = await loadWorkBoard(ctx);
      const statuses = ["running", "claimed", "queued", "blocked", "needs_review"];
      const lines: string[] = [
        "Work",
        agents.length ? agents.map((a) => `  ${a.alias} (${a.status})`).join("\n") : "  agents: none",
        "",
      ];
      let any = false;
      for (const status of statuses) {
        const group = items.filter((item) => item.status === status);
        if (!group.length) continue;
        any = true;
        lines.push(status, ...group.map((item) => `  - ${item.title} [${item.agent}]${item.owner ? ` · ${item.owner}` : ""}`));
      }
      if (!any) lines.push("No queued or active work items.");
      ctx.push({role: "system", text: lines.join("\n")});
    },
  },
  {
    // Folded into the /work hub board; kept as a typeable + scriptable alias
    // (hidden from /help + the slash palette). Same for /focus, /ship, /recap.
    name: "queue",
    hidden: true,
    description: "show agent queue board",
    run: async (ctx) => {
      const [agents, workItems] = await Promise.all([
        ctx.apiClient.listAgents({includeDisabled: true}),
        ctx.apiClient.listWorkItems({limit: 50}),
      ]);
      const agentRows = listFrom(agents, "agents");
      const workRows = listFrom(workItems, "workItems");
      ctx.push({
        role: "system",
        text: [
          "Agents",
          agentRows.length ? agentRows.map((agent) => `- ${agent.alias ?? agent.displayName ?? agent.id} (${agent.status ?? "unknown"})`).join("\n") : "- none",
          "\nWork",
          groupByStatus(workRows),
        ].join("\n"),
      });
    },
  },
  {
    name: "handoff",
    description: "create a Sift work item from current context",
    usage: "<title> [--agent codex] [--files a,b] [--acceptance a;b]",
    run: async (ctx, args) => {
      const title = positionalArgs(args).join(" ").trim();
      if (!title) {
        ctx.push({role: "system", text: "usage: /handoff <title> [--agent codex] [--files a,b] [--acceptance a;b]"});
        return;
      }
      const msg = await createHandoffWorkItem(ctx, {
        title,
        agent: flagValue(args, "--agent") ?? "codex",
        files: splitList(flagValue(args, "--files") ?? ""),
        acceptance: (flagValue(args, "--acceptance") ?? "").split(";").map((text) => text.trim()).filter(Boolean),
        verify: splitList(flagValue(args, "--verify") ?? ""),
      });
      ctx.push({role: "system", text: msg});
    },
  },
  {
    name: "focus",
    hidden: true,
    description: "show 3-5 priority actions",
    run: async (ctx) => {
      const context = await collectContext(ctx);
      ctx.push({role: "system", text: summarizeFocus(context)});
    },
  },
  {
    name: "proof",
    description: "find code/test evidence for a claim",
    usage: "<claim>",
    run: async (ctx, args) => {
      const claim = textArg(args);
      if (!claim) {
        ctx.push({role: "system", text: "usage: /proof <claim>"});
        return;
      }
      const {results, testHints} = await searchCodeEvidence(ctx, claim, 6);
      ctx.push({role: "system", text: formatEvidence(`Proof: ${claim}`, results, testHints)});
    },
  },
  {
    name: "remember",
    description: "store durable code memory",
    usage: "<fact> --category gotcha",
    run: async (ctx, args) => {
      const fact = positionalArgs(args).join(" ").trim();
      const category = flagValue(args, "--category");
      if (!fact || !category) {
        ctx.push({role: "system", text: "usage: /remember <fact> --category architecture|integration|convention|entrypoint|gotcha|ownership"});
        return;
      }
      const response = await ctx.apiClient.storeCodeMemory({fact, category});
      const data = getData(response);
      ctx.push({role: "system", text: `Remembered: ${data.id ?? "stored"} (${category})`});
    },
  },
  {name: "ship", hidden: true, description: "summarize diff and suggested tests", run: (ctx) => ctx.push({role: "system", text: summarizeShip(ctx)})},
  {name: "recap", hidden: true, description: "cluster recent work into proof-backed themes", usage: "[90d]", run: (ctx, args) => ctx.push({role: "system", text: recap(ctx, args[0] ?? "90d")})},
  {
    name: "crew",
    aliases: ["crews"],
    description: "create, inspect, and run Siftable crews",
    usage: "list|show|new|run",
    run: runCrewCommand,
  },
  {
    name: "collab",
    aliases: ["sessions"],
    description: "show collab branch sessions",
    usage: "[limit]",
    run: (ctx, args) => {
      const limit = Math.max(1, Math.min(50, Number(args[0]) || 10));
      ctx.push({role: "system", text: formatCollabSessions(listCollabSessions({limit}))});
    },
  },
  {
    name: "crew-smoke",
    hidden: true,
    description: "run deterministic crew adapter smoke",
    usage: "[--force]",
    run: async (ctx, args) => {
      if (process.env.SIFT_CREW_DEBUG !== "1" && !args.includes("--force")) {
        ctx.push({role: "system", text: "crew smoke is hidden. Set SIFT_CREW_DEBUG=1 or run /crew-smoke --force."});
        return;
      }
      ctx.push({role: "system", text: await runCrewSmoke(ctx)});
    },
  },
];

/**
 * Display hierarchy for /help and the command palette — grouped by purpose
 * instead of definition order. Commands not listed here still appear (appended
 * under "Other"), so nothing is hidden by omission.
 */
const COMMAND_GROUPS: Array<{title: string; names: string[]}> = [
  {title: "Session", names: ["help", "hotkeys", "status", "cwd", "copy", "clear", "compact", "threads", "quit"]},
  {title: "Model & Explorer", names: ["model", "codex", "explorer", "key", "login"]},
  {title: "Agents & branches", names: ["branches", "spawn", "merge", "rebase", "sendback", "reject", "queue", "handoff", "crew", "collab"]},
  {title: "Planning & work", names: ["plan", "focus", "proof", "remember", "ship", "recap"]},
  {title: "Tools & appearance", names: ["skills", "preflight", "mermaid", "view", "theme", "sounds"]},
];

/** Visible commands in hierarchy order, grouped. Ungrouped ones land in "Other". */
export function commandGroups(): Array<{title: string; commands: InteractiveCommand[]}> {
  const byName = new Map(interactiveCommands.filter((command) => !command.hidden).map((command) => [command.name, command] as const));
  const used = new Set<string>();
  const groups = COMMAND_GROUPS
    .map((group) => {
      const commands = group.names
        .map((name) => byName.get(name))
        .filter((command): command is InteractiveCommand => Boolean(command));
      commands.forEach((command) => used.add(command.name));
      return {title: group.title, commands};
    })
    .filter((group) => group.commands.length > 0);
  const leftovers = [...byName.values()].filter((command) => !used.has(command.name));
  if (leftovers.length) groups.push({title: "Other", commands: leftovers});
  return groups;
}

export function commandSuggestions(): Array<{name: string; desc: string}> {
  return commandGroups().flatMap((group) =>
    group.commands.map((command) => ({name: command.name, desc: command.description})),
  );
}

export async function runInteractiveCommand(ctx: InteractiveCommandContext, input: string): Promise<void> {
  const parts = parseCommandArgs(input.slice(1).trim());
  const name = parts[0]?.toLowerCase();
  const command = interactiveCommands.find((candidate) => candidate.name === name || candidate.aliases?.includes(name));
  if (!command) {
    ctx.push({role: "system", text: `unknown command: ${input}  (try /help)`});
    return;
  }
  await command.run(ctx, parts.slice(1));
}

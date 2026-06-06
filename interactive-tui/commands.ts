import {randomUUID} from "node:crypto";
import {homedir} from "node:os";
import {existsSync, readFileSync, rmSync} from "node:fs";
import {rolloutPathForKey} from "./threadEngine";
import {SiftClient} from "@siftable/mcp-server/dist/exfClient.js";
import {doneFallbackText, eventTextDelta, type ControlTransport, type RunningAgent} from "./controlClient";
import {collectDailyReviewContext, collectGitRecapSummary, collectLocalGitSummary, type DailyReviewContext} from "../dist/lib/daily-review-context.js";
import {requestApproval} from "./confirmGate";
import {listCollabSessions, type CollabBranchSnapshot, type CollabSessionSnapshot} from "./collabEngine";
import {runSiftCrew} from "./crewAdapter";
import {
  createCrewFromTemplate,
  crewStoragePath,
  getCrewDefinition,
  listCrewDefinitions,
  renderCrewTaskTemplate,
  type CrewScope,
  type SiftCrewDefinition,
} from "./crewRegistry";

export type CommandMessage = { role: "you" | "assistant" | "system" | "shell" | "tool"; text: string };

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
  quit: () => void;
  latestAssistantText: () => string;
  conversationText: () => string;
  copyText: (text: string) => Promise<string>;
  setAwaitingLogin: (value: boolean) => void;
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

export type ExplorerModeSetting = "auto" | "off" | "deterministic" | "scout" | "fanout";
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

// gpt-5.x (Codex + OpenRouter) expose low/med/high/xhigh. Anthropic and Gemini
// expose low/med/high (mapped to thinking budgets on the Anthropic path).
const GPT5_EFFORTS = ["low", "medium", "high", "xhigh"];
const CLAUDE_EFFORTS = ["low", "medium", "high"];

export const INTERACTIVE_MODEL_CHOICES: InteractiveModelChoice[] = [
  {
    id: "codex/gpt-5.5",
    provider: "codex",
    model: "gpt-5.5",
    label: "GPT-5.5 Codex",
    description: "ChatGPT/Codex account",
    aliases: ["codex", "gpt", "gpt-5.5", "chatgpt"],
    auth: "codex",
    reasoningEfforts: GPT5_EFFORTS,
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
    id: "openrouter/openai/gpt-5.2",
    provider: "openrouter",
    model: "openai/gpt-5.2",
    label: "GPT-5.2",
    description: "OpenRouter API key",
    aliases: ["gpt-5.2", "openai/gpt-5.2"],
    auth: "api-key",
    reasoningEfforts: GPT5_EFFORTS,
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
];

export const EXPLORER_MODE_CHOICES: ExplorerModeChoice[] = [
  {id: "auto", label: "Auto", description: "recommended repo preflight"},
  {id: "off", label: "Off", description: "skip Explorer"},
  {id: "deterministic", label: "Deterministic only", description: "fastest, no scout model"},
  {id: "scout", label: "Scout", description: "one read-only model helper"},
  {id: "fanout", label: "Fan-out", description: "parallel read-only role scouts"},
];

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
  return [
    `mode ${settings.mode}`,
    model ? `model ${model.label}` : `model ${settings.modelId}`,
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

async function hydrateProviderKeyFromVault(
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
    await ctx.client.config({provider, apiKey: secret});
    return {ok: true, message: `Using Sift Vault entry "${label}" for ${envVar} this session.`};
  } catch (err) {
    return {ok: false, message: `Could not read Sift Vault entry "${label}": ${err instanceof Error ? err.message : String(err)}`};
  }
}

export function applyExplorerSettings(settings: ExplorerSettings): {ok: boolean; message: string} {
  const model = explorerModelChoices().find((choice) => choice.id === settings.modelId);
  if (!model) return {ok: false, message: `Explorer model not found: ${settings.modelId}`};
  const keyMessage = missingKeyMessage(model);
  if (keyMessage) return {ok: false, message: keyMessage};

  process.env.SIFT_EXPLORER_BUDGET = settings.budget;
  process.env.SIFT_EXPLORER_SCOUT_PROVIDER = model.provider;
  process.env.SIFT_EXPLORER_SCOUT_MODEL = model.model;

  if (settings.mode === "off") {
    process.env.SIFT_EXPLORER = "off";
    process.env.SIFT_EXPLORER_SCOUT = "0";
    process.env.SIFT_EXPLORER_FANOUT = "0";
  } else if (settings.mode === "scout") {
    process.env.SIFT_EXPLORER = "on";
    process.env.SIFT_EXPLORER_SCOUT = "1";
    process.env.SIFT_EXPLORER_FANOUT = "0";
  } else if (settings.mode === "fanout") {
    process.env.SIFT_EXPLORER = "on";
    process.env.SIFT_EXPLORER_SCOUT = "0";
    process.env.SIFT_EXPLORER_FANOUT = "1";
  } else {
    process.env.SIFT_EXPLORER = "on";
    process.env.SIFT_EXPLORER_SCOUT = "0";
    process.env.SIFT_EXPLORER_FANOUT = "0";
  }

  return {ok: true, message: `Explorer -> ${explorerSettingsSummary(settings)}`};
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
    ctx.push({role: "system", text: `model -> ${result.provider}/${result.model}${effortSuffix(effort)}`});
  } catch (err) {
    ctx.push({role: "system", text: `/model failed: ${err instanceof Error ? err.message : String(err)}`});
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

function parseAdHocModel(raw: string): {provider?: string; model: string} {
  const id = raw.trim();
  if (id.startsWith("openrouter/")) return {provider: "openrouter", model: id.slice("openrouter/".length)};
  if (id.startsWith("openai/")) return {provider: "openai", model: id.slice("openai/".length)};
  if (id.startsWith("gemini/")) return {provider: "gemini", model: id.slice("gemini/".length)};
  if (id.startsWith("anthropic/") && !id.includes(".")) return {provider: "anthropic", model: id.slice("anthropic/".length)};
  if (/^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i.test(id)) return {provider: "openrouter", model: id};
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

export const interactiveCommands: InteractiveCommand[] = [
  {
    name: "help",
    description: "show commands",
    run: (ctx) => {
      const lines = interactiveCommands
        .filter((cmd) => !cmd.hidden)
        .map((cmd) => `/${cmd.name}${cmd.usage ? ` ${cmd.usage}` : ""} · ${cmd.description}`);
      ctx.push({
        role: "system",
        text: `Commands:\n${lines.join("\n")}\n\nAlso: !<cmd> runs a shell command · Enter while busy queues a message.`,
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
    usage: "[last|all]",
    run: async (ctx, args) => {
      const target = (args[0] || "last").toLowerCase();
      const text = target === "all" || target === "transcript" ? ctx.conversationText() : ctx.latestAssistantText();
      ctx.push({role: "system", text: await ctx.copyText(text)});
    },
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
  {name: "quit", aliases: ["exit", "q"], description: "exit", run: (ctx) => ctx.quit()},
  {
    name: "model",
    aliases: ["models"],
    description: "pick model + reasoning effort",
    usage: "[id] [effort]",
    run: async (ctx, args) => {
      // Allow a trailing effort token: `/model gpt-5.2 high`.
      const KNOWN_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
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
        await ctx.client.config({provider: args[0], apiKey: args.slice(1).join(" ")});
        ctx.push({role: "system", text: `stored ${args[0]} API key for the model brain.`});
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
        await selectModel(ctx, "codex/gpt-5.5");
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
          `engine:  ${status.active ? `active · ${status.model}` : "not selected — run /model codex/gpt-5.5"}`,
      });
    },
  },
  {
    name: "queue",
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
      const files = splitList(flagValue(args, "--files") ?? "");
      const acceptance = (flagValue(args, "--acceptance") ?? "")
        .split(";")
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => ({text, met: false}));
      const gitStatus = collectLocalGitSummary({cwd: ctx.cwd()}).status;
      const payload = {
        title,
        prompt: `Handoff from sift interactive.\n\n${ctx.conversationText().slice(-4000)}`,
        assignedAlias: flagValue(args, "--agent") ?? "codex",
        inputContext: {
          cwd: ctx.cwd(),
          files,
          gitStatus,
          transcriptTail: ctx.conversationText().slice(-4000),
        },
        acceptanceCriteria: acceptance,
        verificationCommands: splitList(flagValue(args, "--verify") ?? ""),
      };
      const response = await ctx.apiClient.createWorkItem(payload, `interactive-${Date.now()}-${randomUUID()}`);
      const workItem = getData(response).workItem as Record<string, unknown> | undefined;
      ctx.push({role: "system", text: `Work item created: ${workItem?.id ?? "(unknown id)"} · ${title}`});
    },
  },
  {
    name: "focus",
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
      const repos = listFrom(await ctx.apiClient.listCodeRepositories(), "repositories");
      const repo = repos.find((candidate) => typeof candidate.rootPath === "string" && ctx.cwd().startsWith(candidate.rootPath as string)) ?? repos[0];
      const results = listFrom(await ctx.apiClient.searchCode({query: claim, repositoryId: repo?.id as string | undefined, limit: 6}), "results");
      const testHints = results.filter((result) => String(result.filePath ?? "").match(/\.(test|spec|vitest)\./));
      ctx.push({
        role: "system",
        text: [
          `Proof: ${claim}`,
          results.length ? results.map((result) => `- ${result.filePath}:${result.startLine ?? "?"} ${result.symbolName ?? ""}`).join("\n") : "No code search results.",
          testHints.length ? "\nTest evidence:\n" + testHints.map((result) => `- ${result.filePath}`).join("\n") : "\nTest evidence: not found in top results.",
        ].join("\n"),
      });
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
  {name: "ship", description: "summarize diff and suggested tests", run: (ctx) => ctx.push({role: "system", text: summarizeShip(ctx)})},
  {name: "recap", description: "cluster recent work into proof-backed themes", usage: "[90d]", run: (ctx, args) => ctx.push({role: "system", text: recap(ctx, args[0] ?? "90d")})},
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

export function commandSuggestions(): Array<{name: string; desc: string}> {
  return interactiveCommands
    .filter((command) => !command.hidden)
    .map((command) => ({name: command.name, desc: command.description}));
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

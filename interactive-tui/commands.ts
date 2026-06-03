import {randomUUID} from "node:crypto";
import {SiftClient} from "@siftable/mcp-server/dist/exfClient.js";
import type {ControlTransport, RunningAgent} from "./controlClient";
import {collectDailyReviewContext, collectGitRecapSummary, collectLocalGitSummary, type DailyReviewContext} from "../src/lib/daily-review-context";

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
  /**
   * Reasoning-effort levels this model supports, low→high. Drives the picker's
   * second stage. Omit (or leave empty) for models with no configurable
   * reasoning — the picker then confirms on Enter with no effort step.
   */
  reasoningEfforts?: string[];
  /** Effort pre-selected in the picker; falls back to the middle of the list. */
  defaultEffort?: string;
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
    reasoningEfforts: CLAUDE_EFFORTS,
    defaultEffort: "high",
  },
];

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

  // Door B: the direct Anthropic API needs a key in-env (the OpenRouter path
  // does not — OpenRouter holds its own key). Gate selection with a clear hint
  // instead of letting the first turn fail with a raw adapter error.
  if (choice.auth === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    ctx.push({role: "system", text: `${choice.label} needs an Anthropic API key. Run: /key anthropic sk-ant-…  then reselect.`});
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
    const result = await ctx.client.config({model: raw, ...(effort ? {effort} : {})});
    ctx.setModel(result.model);
    ctx.push({role: "system", text: `model -> ${result.provider}/${result.model}${effortSuffix(effort)}`});
  } catch (err) {
    ctx.push({role: "system", text: `/model failed: ${err instanceof Error ? err.message : String(err)}`});
  }
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

export const interactiveCommands: InteractiveCommand[] = [
  {
    name: "help",
    description: "show commands",
    run: (ctx) => {
      const lines = interactiveCommands.map((cmd) => `/${cmd.name}${cmd.usage ? ` ${cmd.usage}` : ""} · ${cmd.description}`);
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
        ctx.push({role: "system", text: `workdir: ${ctx.cwd()}`});
        return;
      }
      try {
        ctx.setCwd(target);
        ctx.push({role: "system", text: `workdir → ${ctx.cwd()}`});
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
    usage: "<provider> <key>",
    run: async (ctx, args) => {
      if (args.length < 2) {
        ctx.push({role: "system", text: "usage: /key <provider> <key>  (e.g. /key openrouter sk-...)"});
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
];

export function commandSuggestions(): Array<{name: string; desc: string}> {
  return interactiveCommands.map((command) => ({name: command.name, desc: command.description}));
}

export async function runInteractiveCommand(ctx: InteractiveCommandContext, input: string): Promise<void> {
  const parts = input.slice(1).trim().split(/\s+/).filter(Boolean);
  const name = parts[0]?.toLowerCase();
  const command = interactiveCommands.find((candidate) => candidate.name === name || candidate.aliases?.includes(name));
  if (!command) {
    ctx.push({role: "system", text: `unknown command: ${input}  (try /help)`});
    return;
  }
  await command.run(ctx, parts.slice(1));
}

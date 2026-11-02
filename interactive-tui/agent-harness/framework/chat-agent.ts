import {verifyCandidate, verifyReceiptCurrent, verificationAllowsRepair, verificationFeedback, type CandidateVerificationReceipt, type CandidateVerificationInput} from '../../candidateVerification';
import {detectUserDirectedRequest, noninteractiveFeedback, truncationNudge, NONINTERACTIVE_UNSETTLED_ERROR} from './settlement';
import {fitHistoryToRequestBudget, estimateRequestBytes, requestByteCeiling, FRAMING_BYTES} from './request-budget';
/** Bounded replay of a reasoning-only output-limited response (CLI-045). */
const INCOMPLETE_RETRY_LIMIT = 2;
import {ProviderHttpError, ProviderIncompleteError, reasoningOnlyTruncation} from './adapters/transport.js';
/**
 * ChatAgent — Composable AI Chat Agent
 *
 * Composes tools, memory, context providers, and AI adapters into
 * a single configurable, embeddable agent.
 *
 * @example
 * ```ts
 * import { createChatAgent } from "../index.js";
 *
 * // Programmatic
 * const agent = await createChatAgent({ provider: "gemini" });
 * const result = await agent.chat("Create a task to review the PR");
 *
 * // Interactive CLI
 * await agent.interactive();
 *
 * // HTTP server
 * await agent.serve({ port: 3000 });
 * ```
 */

import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AdapterResponse,
  AdapterSessionState,
  ChatContent,
  ChatMessage,
  ToolCall,
} from "./adapters/types.js";
import { validatedAdapterToolCalls } from "./adapters/types.js";
import { chatContentToText } from "./adapters/content.js";
import type { ToolExecutionContext } from "./execution-context.js";
import type { AdapterEvent, ProviderReceipt } from "./adapters/types.js";
import type { AIAdapter } from "./adapters/types.js";
import { snapshotToolRegistry, ToolRegistry, type ToolRegistration } from "./registry.js";
import { abortedTurnReason, isAbortInterruption, throwIfAborted, waitForTurn } from "./turn-abort.js";
import { cancelRun, completeRun, errorMessage, failRun } from "./run-lifecycle.js";
import {
  applyCompactionPlan,
  buildCompactionConfig,
  buildSummarizeTranscript,
  compactionEnabled,
  COMPACTION_SUMMARY_INSTRUCTION,
  COMPACTION_SUMMARY_SYSTEM,
  estimateHistoryTokens,
  planCompaction,
  toPlanMessages,
  type CompactionPlanFailure,
} from "./compaction.js";
import { appendTurn, loadHistory, persistEnabled, rolloutPathForThread } from "./rollout.js";
import type { ConnectedProvider } from "./context.js";
import { connectProviderOwned, contextPrompt } from "./context.js";
import {
  createConversationMemory,
  createFactMemory,
  createMemoryTools,
} from "./memory.js";
import type { ConversationMemory, FactMemory } from "./memory.js";
import { registry as globalRegistry } from "./registry.js";
import {
  resolveAdapter,
  resolveContextProviders,
  resolveSystemPrompt,
  buildAgentRegistry,
} from "./chat-agent-resolve.js";
import type {
  ChatAgentConfig,
  ChatAgent,
  ChatResult,
  ChatStreamChunk,
  ChatAgentChatOptions,
  ChatSessionConfig,
  CompactionOutcome,
  OutcomeClaim,
  RunContext,
  RunRecord,
  RunToolEffectReceipt,
  RunToolExecutionMode,
  ServeOptions,
  MemoryConfig,
} from "./chat-agent-types.js";
import {
  RUN_SCHEMA_VERSION,
  RUN_TOOL_OUTPUT_POLICY_VERSION,
  RUN_TOOL_SCHEDULING_POLICY_VERSION,
  RunExecutionError,
} from "./chat-agent-types.js";
import { digestJson, snapshotJson, SessionKernel } from "./session.js";
import type { SessionEventContext } from "./session.js";
import { classifyToolCall, runToolBatch } from "./tool-scheduler.js";
import { createRepetitionTracker } from "./repetition.js";
import {
  boundToolOutput,
  bytePrefix,
  cleanupToolOutputSpillSession,
  createToolOutputSpillCollector,
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  DEFAULT_TOOL_OUTPUT_MAX_LINES,
  MIN_TOOL_OUTPUT_MAX_BYTES,
  MIN_TOOL_OUTPUT_MAX_LINES,
  resolveToolOutputSpillPolicy,
} from "./tool-output.js";
import type { ToolOutputConfig, ToolOutputSpillCollector } from "./tool-output.js";
import { normalizeToolResult } from "./tool.js";
import type { ToolResult } from "./types.js";
import { redactSensitiveText, sanitizeSensitiveValue } from "./redaction.js";

function sanitizeToolResult(result: ToolResult): ToolResult {
  return sanitizeSensitiveValue(result) as ToolResult;
}

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Create a composable chat agent.
 *
 * Wires together tools, memory, context providers, and an AI adapter
 * into a single agent that can be used programmatically, as a CLI,
 * or as an HTTP server.
 *
 * ```ts
 * const agent = await createChatAgent({
 *   provider: "gemini",
 *   memory: true,
 *   providers: ["siftable"],
 * });
 * ```
 */
export async function createChatAgent(
  config: ChatAgentConfig = {},
): Promise<ChatAgent> {
  // 1. Build the agent's tool registry (clone/filter from source)
  const agentRegistry = buildAgentRegistry(config, globalRegistry);

  // 2. Set up memory (default: ON)
  let conversationMemory: ConversationMemory | undefined;
  let factMemory: FactMemory | undefined;
  const sessionThreadId = config.session?.threadId;
  let threadId = sessionThreadId ?? randomUUID();
  let threadIdExplicit = sessionThreadId !== undefined;
  const memConfig = typeof config.memory === "object" ? config.memory : {};
  const conversationMemoryEnabled = config.memory !== false && memConfig.conversation !== false;
  const factMemoryEnabled = config.memory !== false && memConfig.facts !== false;
  const memoryEnabled = conversationMemoryEnabled || factMemoryEnabled;

  if (conversationMemoryEnabled) {
    if (
      sessionThreadId !== undefined
      && memConfig.threadId !== undefined
      && sessionThreadId !== memConfig.threadId
    ) {
      throw new Error("session.threadId and memory.threadId must match");
    }
    conversationMemory = createConversationMemory(memConfig.conversationStore);
    threadId = memConfig.threadId ?? threadId;
    threadIdExplicit ||= memConfig.threadId !== undefined;
  }

  if (factMemoryEnabled) {
    factMemory = createFactMemory(memConfig.factStore);
  }

  if (memoryEnabled) {
    // Register memory tools — but never shadow a user tool of the
    // same name. If the user defined their own store_fact, we keep theirs.
    agentRegistry.registerAll(
      createMemoryTools(conversationMemory, factMemory),
      { overwrite: false },
    );
  }

  // 3. Connect context providers
  const connectedProviders: ConnectedProvider[] = [];
  // Each provider's tool registration, so destroy() removes exactly what it
  // installed. Without this, long-lived processes that create and destroy
  // agents accumulate ghost tools.
  const providerRegistrations: ToolRegistration[] = [];
  let contextBlock: string | undefined;

  if (config.providers && config.providers.length > 0) {
    const resolved = await resolveContextProviders(config.providers);
    for (const provider of resolved) {
      try {
        const { connected, registration } = await connectProviderOwned(provider, agentRegistry);
        connectedProviders.push(connected);
        providerRegistrations.push(registration);
      } catch (error) {
        const name = provider.metadata.name;
        const msg = errorMessage(error);
        console.warn(`⚠️  ${name}: failed to connect — ${msg}`);
      }
    }

  }

  // Everything after provider connection shares one cleanup boundary.
  try {
    if (connectedProviders.length > 0) {
      contextBlock = await contextPrompt(connectedProviders);
      if (contextBlock === "") contextBlock = undefined;
    }

    const systemPrompt = config.raw
      ? resolveSystemPrompt(
        { prompt: "You are a helpful assistant." },
        agentRegistry,
        )
      : resolveSystemPrompt(config, agentRegistry, {
          contextBlock,
          memoryEnabled: factMemoryEnabled,
        });
    const adapter = config.adapter ?? resolveAdapter(config, systemPrompt);

    // Bounds fail loudly at construction: a NaN/Infinity/fractional cap
    // would otherwise silently disarm the pool guard or the output caps.
    requirePositiveInteger("maxParallelTools", config.maxParallelTools, 1);
    requirePositiveInteger("toolOutput.maxBytes", config.toolOutput?.maxBytes, MIN_TOOL_OUTPUT_MAX_BYTES);
    requirePositiveInteger("toolOutput.maxLines", config.toolOutput?.maxLines, MIN_TOOL_OUTPUT_MAX_LINES);
    if (
      config.toolOutput?.spillDir !== undefined
      && (
        typeof config.toolOutput.spillDir !== "string"
        || config.toolOutput.spillDir.trim() === ""
      )
    ) {
      throw new Error("toolOutput.spillDir must be a non-empty path when configured");
    }

    return new ChatAgentImpl({
      name: config.name ?? "agent",
      adapter,
      registry: agentRegistry,
      systemPrompt,
      conversationMemory,
      factMemory,
      connectedProviders,
      providerRegistrations,
      threadId,
      threadIdExplicit,
      maxToolRounds: config.maxToolRounds ?? 10,
      maxParallelTools: config.maxParallelTools ?? 4,
      toolOutput: config.toolOutput,
      persistKey: config.persistKey,
      session: config.session,
      executionContext: config.executionContext,
      requestOptions: {
        ...(config.reasoningEffort ? {reasoningEffort: config.reasoningEffort} : {}),
        ...(config.adapterConfig?.baseUrl ? {baseUrl: config.adapterConfig.baseUrl} : {}),
        ...(config.adapterConfig?.maxOutputTokens ? {maxOutputTokens: config.adapterConfig.maxOutputTokens} : {}),
        ...(config.adapterConfig?.retry ? {retry: {...config.adapterConfig.retry}} : {}),
        ...(config.adapterConfig?.timeouts ? {timeouts: {...config.adapterConfig.timeouts}} : {}),
      },
    });
  } catch (error) {
    for (const registration of providerRegistrations) registration.dispose();
    await Promise.allSettled(
      connectedProviders.map((provider) => provider.disconnect?.()),
    );
    throw error;
  }
}

// ─── Implementation ────────────────────────────────────────────────────────

function requirePositiveInteger(
  label: string,
  value: number | undefined,
  min: number,
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new TypeError(`${label} must be an integer >= ${min}; received ${String(value)}`);
  }
}

class ProviderObservationError extends Error {}

interface ChatAgentInternals {
  executionContext?: ChatAgentConfig["executionContext"];
  requestOptions?: Record<string, unknown>;
  name: string;
  adapter: AIAdapter;
  registry: ToolRegistry;
  systemPrompt: string;
  conversationMemory?: ConversationMemory;
  factMemory?: FactMemory;
  connectedProviders: ConnectedProvider[];
  providerRegistrations: ToolRegistration[];
  threadId: string;
  threadIdExplicit: boolean;
  maxToolRounds: number;
  maxParallelTools: number;
  toolOutput?: ToolOutputConfig;
  persistKey?: string;
  session?: ChatSessionConfig;
}

class ChatAgentImpl implements ChatAgent {
  readonly name: string;
  readonly provider: string;
  readonly model: string;

  private adapter: AIAdapter;
  private executionContext?: ChatAgentConfig["executionContext"];
  private requestOptions: Record<string, unknown>;
  private providerListener?: (event: AdapterEvent) => void;
  private providerReceipts: ProviderReceipt[] = [];
  private streamedResponses = new WeakSet<AdapterResponse>();
  private registry: ToolRegistry;
  private systemPrompt: string;
  private conversationMemory?: ConversationMemory;
  private factMemory?: FactMemory;
  private connectedProviders: ConnectedProvider[];
  private providerRegistrations: ToolRegistration[];
  private threadId: string;
  private pinnedThreadId?: string;
  private maxToolRounds: number;
  private maxParallelTools: number;
  private toolOutput?: ToolOutputConfig;
  private protectedSpillRefs = new Set<string>();
  private spillCollector?: ToolOutputSpillCollector;
  private spillCollectionTimer?: ReturnType<typeof setTimeout>;
  private session: SessionKernel;
  private turnTail: Promise<void> = Promise.resolve();
  private pendingTurnOperations = 0;
  private rolloutPath?: string;
  private writeLegacyRollout = true;
  private seeded = false;
  private plannerUnavailableNoted = false;
  private contextWindowFallbackNoted = false;

  constructor(internals: ChatAgentInternals) {
    this.name = internals.name;
    this.adapter = internals.adapter;
    this.executionContext = internals.executionContext;
    this.requestOptions = snapshotJson(internals.requestOptions || {}) as Readonly<Record<string, unknown>>;
    this.registry = internals.registry;
    this.systemPrompt = internals.systemPrompt;
    this.conversationMemory = internals.conversationMemory;
    this.factMemory = internals.factMemory;
    this.connectedProviders = internals.connectedProviders;
    this.providerRegistrations = internals.providerRegistrations;
    this.threadId = internals.threadId;
    this.pinnedThreadId = internals.threadIdExplicit
      ? internals.threadId
      : undefined;
    this.maxToolRounds = internals.maxToolRounds;
    this.maxParallelTools = internals.maxParallelTools;
    this.toolOutput = internals.toolOutput;
    this.provider = internals.adapter.name;
    this.model = internals.adapter.model;
    if (
      internals.session?.store !== undefined
      && this.conversationMemory !== undefined
      && !this.conversationMemory.atomicMutations
    ) {
      throw new Error(
        "Durable chat sessions require a conversation Store with atomic mutate() support; "
        + "use createStore(), disable conversation memory, or provide an atomic store",
      );
    }
    this.session = new SessionKernel({
      sessionId: internals.session?.id ?? randomUUID(),
      store: internals.session?.store,
      metadata: {
        agentName: this.name,
        provider: this.provider,
        model: this.model,
        threadId: this.threadId,
        maxToolRounds: this.maxToolRounds,
      },
    });
    const journalThreadId = this.session.getThreadId();
    if (
      journalThreadId !== undefined
      && internals.threadIdExplicit
      && journalThreadId !== internals.threadId
    ) {
      throw new Error(
        `session journal belongs to thread ${journalThreadId}, not ${internals.threadId}`,
      );
    }
    if (journalThreadId !== undefined) this.threadId = journalThreadId;
    if (internals.session?.recoverInterrupted !== false) {
      this.session.recoverInterrupted();
    }
    if (this.toolOutput?.spillDir !== undefined) {
      // spillDir is a common custody root, not a session-owned directory.
      // Derive a stable, path-safe child so reopening the same journal finds
      // its prior spills while another session sharing the root can never
      // collect or destroy them.
      this.toolOutput = {
        ...this.toolOutput,
        spillDir: join(
          this.toolOutput.spillDir,
          `session-${digestJson(this.session.sessionId)}`,
        ),
      };
      for (const event of this.session.getEvents()) {
        if (event.type !== "tool/result") continue;
        const ref = event.data.output?.fullOutputRef;
        if (ref !== undefined) this.protectedSpillRefs.add(ref);
      }
      for (const ref of this.toolOutput.protectedSpillRefs ?? []) {
        this.protectedSpillRefs.add(ref);
      }
      this.spillCollector = createToolOutputSpillCollector({
        spillDir: this.toolOutput.spillDir,
        policy: this.toolOutput.spillPolicy,
        protectedPaths: this.protectedSpillRefs,
        referencesComplete: true,
      });
      this.spillCollector.collect();
      this.toolOutput = {
        ...this.toolOutput,
        protectedSpillRefs: this.protectedSpillRefs,
      };
      this.scheduleSpillCollection();
    }
    if (this.conversationMemory) {
      if (this.session.getEventCount() === 1) {
        const prior = this.conversationMemory.getRecent(this.threadId, Number.MAX_SAFE_INTEGER);
        if (prior.length > 0) {
          this.session.replaceHistory([...prior], "conversation_memory_imported");
        }
      } else if (this.currentHistory().length > 0) {
        // The journal is authoritative. Reset/delete clear the compatibility
        // projection first, so reopen must repair a projection lost between
        // that write and the authoritative journal commit.
        this.conversationMemory.replaceMessages(this.threadId, this.currentHistory());
      }
    }
    this.rolloutPath =
      internals.persistKey && persistEnabled() ? rolloutPathForThread(internals.persistKey) : undefined;
    // A configured event store is the durable authority. The old rollout is
    // read once for migration, but continuing its unlocked two-write mirror
    // would reintroduce orphan turns and cross-process last-writer loss.
    this.writeLegacyRollout = internals.session?.store === undefined;
  }

  private scheduleSpillCollection(): void {
    if (this.spillCollectionTimer !== undefined) {
      clearTimeout(this.spillCollectionTimer);
      this.spillCollectionTimer = undefined;
    }
    const delay = this.spillCollector?.nextDelayMs();
    if (delay === undefined) return;
    // Node clamps larger timeouts to 1 ms, so cap and reschedule instead.
    const boundedDelay = Math.min(delay, 2_147_483_647);
    this.spillCollectionTimer = setTimeout(() => {
      this.spillCollectionTimer = undefined;
      this.spillCollector?.collect();
      this.scheduleSpillCollection();
    }, boundedDelay);
    this.spillCollectionTimer.unref?.();
  }

  private stopSpillCollection(): void {
    if (this.spillCollectionTimer === undefined) return;
    clearTimeout(this.spillCollectionTimer);
    this.spillCollectionTimer = undefined;
  }

  /**
   * Seed history from the persisted rollout on the first turn of a session.
   * Loads the whole prior conversation; if it's large, the pre-turn compaction
   * pass (which runs right after this) trims it before the model call. Idempotent.
   */
  private ensureSeeded(): void {
    if (this.seeded) return;
    this.seeded = true;
    if (!this.rolloutPath) return;
    // A durable journal with anything beyond its creation event has already
    // imported or recorded the authoritative history. Re-importing the legacy
    // rollout on restart would duplicate every prior user/assistant turn and
    // could also undo a journaled reset whose active projection is empty.
    if (this.session.getEventCount() > 1) return;
    const prior = loadHistory(this.rolloutPath);
    if (prior.length > 0) {
      this.session.replaceHistory(
        [...prior, ...this.session.getHistory()],
        "legacy_rollout_imported",
      );
    }
  }

  /** Persist a completed turn (user prompt + final assistant answer). */
  private appendTurnRollout(userContent: ChatContent, assistantText: string): void {
    if (!this.rolloutPath || !this.writeLegacyRollout) return;
    appendTurn(this.rolloutPath, chatContentToText(userContent), assistantText || null);
  }

  // ── chat() with overloads ──────────────────────────────────────────────

  chat(message: ChatContent, options?: ChatAgentChatOptions & { stream?: false }): Promise<ChatResult>;
  chat(message: ChatContent, options: ChatAgentChatOptions & { stream: true }): AsyncIterable<ChatStreamChunk>;
  chat(message: ChatContent, options?: ChatAgentChatOptions): Promise<ChatResult> | AsyncIterable<ChatStreamChunk> {
    if (options?.stream) {
      return this.chatStream(message, options);
    }
    return this.chatAsync(message, options);
  }

  private exhaustedToolRoundSystemPrompt(promptOverride?: string): string {
    return `${promptOverride ?? this.systemPrompt}

The assistant has reached the tool-calling round limit for this turn. Do not call more tools. Give the user a concise final answer using only the tool results already present in the conversation. If the evidence is partial, clearly say what was checked, what you found, and what remains uncertain.`;
  }

  /**
   * Pre-turn context compaction. Runs before the new user message is added, so
   * it only ever rewrites already-completed turns — the current turn's tool/
   * assistant alternation is never touched. Prune-then-summarize, turn-aligned
   * (decided by the Zig planner). No-ops unless SIFT_CONTEXT_COMPACTION=1 and the
   * native library is present; any summarizer error degrades to prune-only so we
   * never corrupt history on a transient failure.
   */
  private async maybeCompact(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (!compactionEnabled()) return;
    // Short threads can't overflow; skip the planner call entirely.
    if (this.session.getHistory().length < 8) return;
    await this.runCompaction(false, signal);
  }

  /**
   * Public, explicit compaction (the TUI's `/compact`). Seeds prior history,
   * then forces a prune+summarize pass even when the thread is still within
   * budget, and reports what changed so the caller can show before/after. Safe
   * to call between turns; the same gating that protects {@link maybeCompact}
   * applies (disabled flag, native library absent, summarizer error → prune-only).
   */
  async compact(options?: { force?: boolean; signal?: AbortSignal }): Promise<CompactionOutcome> {
    const release = await this.acquireTurn(options?.signal);
    try {
      throwIfAborted(options?.signal);
      this.ensureSeeded();
      return await this.runCompaction(options?.force ?? true, options?.signal);
    } finally {
      release();
    }
  }

  /**
   * Shared compaction core. `force` runs the pipeline regardless of budget
   * (manual /compact); otherwise it only acts on overflow (auto, pre-turn).
   * Returns an outcome describing whether history changed and by how much.
   */
  private async runCompaction(
    force: boolean,
    signal?: AbortSignal,
  ): Promise<CompactionOutcome> {
    throwIfAborted(signal);
    const history = this.currentHistory();
    const before = estimateHistoryTokens(history);
    const unchanged = (reason: string): CompactionOutcome => ({
      ran: false,
      reason,
      beforeTokens: before,
      afterTokens: before,
      prunedMessages: 0,
      summarized: false,
    });

    if (!compactionEnabled()) return unchanged("compaction is disabled (SIFT_CONTEXT_COMPACTION=0)");
    if (history.length === 0) return unchanged("no conversation to compact yet");

    // The configured cap, else the cap the adapter applies on its own.
    const routeOutput = this.requestOptions?.maxOutputTokens ?? this.adapter.maxOutputTokens;
    const config = buildCompactionConfig(this.model, typeof routeOutput === "number" ? { maxOutputTokens: routeOutput } : {});
    if (config.contextWindowSource === "fallback") this.noteContextWindowFallback();
    const outcome = planCompaction(toPlanMessages(history), {
      ...config,
      force,
    });
    if (outcome.ok === false) {
      this.notePlannerUnavailable(outcome.reason, outcome.detail);
      return unchanged(`compaction planner unavailable (${outcome.reason})`);
    }
    const plan = outcome.plan;
    if (!plan.needsCompaction) return unchanged("already within the context budget");

    let summaryText: string | null = null;
    const summarizeEnd = plan.summarizeRange[1];
    const sourceHistory = this.session.getHistory();
    if (summarizeEnd > 0) {
      const transcript = buildSummarizeTranscript(history, summarizeEnd);
      const auxiliaryContext: SessionEventContext = { correlationId: randomUUID() };
      const auxiliaryInput: ChatMessage[] = freezeJson([{ role: "user", content: `${COMPACTION_SUMMARY_INSTRUCTION}\n\n<conversation>\n${transcript}\n</conversation>` }]);
      // Journal the derived summary input independently from the main model
      // history. This must succeed before any provider attempt can begin, and
      // must not be caught by the prune-only provider-failure fallback below.
      this.session.append({
        type: "model/auxiliary-request-prepared",
        data: {
          purpose: "compaction",
          history: {
            throughSeq: this.session.getEventCount(),
            messageCount: history.length,
            sha256: digestJson(history),
          },
          input: auxiliaryInput,
          inputSha256: digestJson(auxiliaryInput),
          envelope: { systemPrompt: COMPACTION_SUMMARY_SYSTEM, tools: [] },
          systemPromptSha256: digestJson(COMPACTION_SUMMARY_SYSTEM),
          tools: { names: [], sha256: digestJson([]) },
          options: { ...this.requestOptions, oneShot: true, stream: false, sourceRange: [0, summarizeEnd] },
          adapter: { name: this.provider, model: this.model },
        },
        ...auxiliaryContext,
      });
      try {
        throwIfAborted(signal);
        const resp = await this.adapter.chat(auxiliaryInput, new ToolRegistry(), {
          systemPrompt: COMPACTION_SUMMARY_SYSTEM,
          oneShot: true,
          stream: false,
          onEvent: (event) => { if (event.type !== "provider.text.delta") this.observeProvider(event, auxiliaryContext); },
          ...(signal === undefined ? {} : { signal }),
        });
        throwIfAborted(signal);
        summaryText = resp.text?.trim() || null;
      } catch (error) {
        if (error instanceof ProviderObservationError || isAbortInterruption(error, signal)) throw error;
        summaryText = null; // fall back to prune-only
      }
    }

    throwIfAborted(signal);
    // The plan and summary describe the history read above. If it moved
    // while the summary was prepared, applying them would discard the change.
    // History is replaced, never mutated in place, so identity detects a move.
    if (this.session.getHistory() !== sourceHistory) {
      return unchanged("history changed while the summary was prepared; nothing was replaced");
    }
    let compacted = applyCompactionPlan(history, plan, summaryText);
    // A replacement that is not smaller makes no progress. A summary longer
    // than what it replaces still leaves the plan's pruning, which may help.
    if (summaryText != null && estimateHistoryTokens(compacted) >= before) {
      summaryText = null;
      compacted = applyCompactionPlan(history, plan, null);
    }
    if (estimateHistoryTokens(compacted) >= before) {
      return unchanged(summarizeEnd > 0 && summaryText == null
        ? "no usable summary and nothing to prune; nothing was replaced"
        : "compaction would not shrink the history; nothing was replaced");
    }
    this.session.replaceHistoryAndClearAdapterStates(compacted, "compaction_applied");
    return {
      ran: true,
      beforeTokens: before,
      afterTokens: estimateHistoryTokens(compacted),
      prunedMessages: plan.prune.length,
      summarized: summaryText != null && summarizeEnd > 0,
    };
  }

  /**
   * Record planner degradation once per session. The journal event is the
   * durable signal (it survives the packaged runtime's missing native
   * library); stderr reaches the interactive user. Emitted pre-turn or between
   * turns only, so it carries correlation context but no turn/step ids.
   */
  private notePlannerUnavailable(reason: CompactionPlanFailure, detail?: string): void {
    if (this.plannerUnavailableNoted) return;
    // Journal-derived state: a reopened session replays a prior event from the
    // store, so a second agent on the same session stays silent too.
    if (this.session.getEvents().some((event) => event.type === "compaction/planner-unavailable")) {
      this.plannerUnavailableNoted = true;
      return;
    }
    console.warn(`Compaction planner unavailable (${reason}) — context compaction is degraded this session`);
    try {
      this.session.append({
        type: "compaction/planner-unavailable",
        data: detail === undefined ? { reason } : { reason, detail },
        correlationId: randomUUID(),
      });
    } catch {
      // Journal unavailable — leave the flag unset so a later turn retries
      // instead of suppressing the only durable signal forever.
      return;
    }
    this.plannerUnavailableNoted = true;
  }

  /**
   * Warn once per session when compaction budgets against the conservative
   * fallback window because the model is unknown — stderr only (a resolved
   * window is config, not degradation), but loud enough that a stale table
   * entry is visible rather than silently under-budgeting.
   */
  private noteContextWindowFallback(): void {
    if (this.contextWindowFallbackNoted) return;
    this.contextWindowFallbackNoted = true;
    console.warn(`Context window unknown for model ${JSON.stringify(this.model)} — compaction is using a conservative fallback; set SIFT_CONTEXT_WINDOW to override`);
  }

  private async acquireTurn(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    const previous = this.turnTail;
    let release!: () => void;
    this.turnTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pendingTurnOperations += 1;
    let released = false;
    const finish = (): void => {
      if (released) return;
      released = true;
      this.pendingTurnOperations -= 1;
      release();
    };
    try {
      await waitForTurn(previous, signal);
    } catch (error) {
      // Hand a cancelled FIFO slot through only after its predecessor exits.
      void previous.then(finish, finish);
      throw error;
    }
    return finish;
  }

  private currentHistory(): ChatMessage[] {
    return [...this.session.getHistory()];
  }

  private eventContext(
    run: RunRecord,
    stepId?: string,
  ): SessionEventContext {
    return {
      turnId: run.manifest.runId,
      runId: run.manifest.runId,
      correlationId: run.manifest.correlationId,
      ...(stepId === undefined ? {} : { stepId }),
    };
  }

  private modelToolSnapshot(registry = this.registry) {
    return registry.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      tags: tool.tags ?? [],
    }));
  }

  private recordModelRequest(
    messages: ChatMessage[],
    systemPrompt: string,
    toolSnapshot: ReturnType<ChatAgentImpl["modelToolSnapshot"]>,
    options: unknown,
    context: SessionEventContext,
  ): void {
    this.session.append({
      type: "model/request-prepared",
      data: {
        history: {
          throughSeq: this.session.getEventCount(),
          messageCount: messages.length,
          sha256: digestJson(messages),
        },
        systemPromptSha256: digestJson(systemPrompt),
        envelope: { systemPrompt, tools: toolSnapshot },
        tools: {
          names: toolSnapshot.map((tool) => tool.name).sort(),
          sha256: digestJson(toolSnapshot),
        },
        options: { ...this.requestOptions, ...(options as Record<string, unknown>) },
        adapter: { name: this.provider, model: this.model },
      },
      ...context,
    });
  }

  private recordModelResponse(
    response: AdapterResponse,
    context: SessionEventContext,
  ): void {
    this.session.append({
      type: "model/response-received",
      data: {
        ...(response.text === undefined ? {} : { text: response.text }),
        ...(response.toolCall === undefined ? {} : { toolCall: response.toolCall }),
        ...(response.toolCalls === undefined ? {} : { toolCalls: response.toolCalls }),
        ...(response.thinking === undefined ? {} : { thinking: response.thinking }),
        ...(response.providerReplay === undefined
          ? {}
          : { providerReplay: response.providerReplay }),
        ...(response.continuationRecovery === undefined
          ? {}
          : { continuationRecovery: response.continuationRecovery }),
      },
      ...context,
    });
  }

  private observeProvider(event: AdapterEvent, context: SessionEventContext = {}): void {
    try {
      if (event.type !== "provider.text.delta") {
        this.session.append({ type: "model/provider-event", data: { event }, ...context });
      }
      if (event.type === "provider.response") this.providerReceipts.push(event.receipt);
      this.providerListener?.(event);
    } catch (error) {
      throw new ProviderObservationError("Provider event could not be recorded or delivered", {cause: error});
    }
  }

  /** Fit the current history to the lane's request budget between steps, recording any pruning. */
  private fitRequestBudget(systemPrompt: string, context: SessionEventContext, reason: "preemptive" | "http-413", aggressive = false): boolean {
    const history = this.currentHistory();
    // The adapter also sends every tool definition; count it so a large registry cannot
    // hide an oversized request from the estimate.
    const overheadBytes = FRAMING_BYTES + Buffer.byteLength(JSON.stringify(this.modelToolSnapshot(this.registry)), "utf8");
    // After a 413 the provider has already rejected this size, whatever the lane estimate
    // says: target well below the current request and keep only the newest result.
    const outcome = fitHistoryToRequestBudget(history, systemPrompt, {
      provider: this.provider, overheadBytes,
      ...(aggressive ? {
        keepLast: 1,
        // Never above the lane's own ceiling, even when the rejected request was small.
        ceilingBytes: Math.min(requestByteCeiling(this.provider), Math.floor(estimateRequestBytes(history, systemPrompt, overheadBytes) * 0.6)),
      } : {}),
    });
    // A retry is only worth sending if pruning made the request smaller.
    if (outcome.pruned.length === 0 || outcome.afterBytes >= outcome.beforeBytes) return false;
    this.session.replaceHistory(outcome.history, "in_turn_tool_results_pruned", context);
    this.session.append({ type: "model/request-pruned", data: { reason, beforeBytes: outcome.beforeBytes, afterBytes: outcome.afterBytes, ceilingBytes: outcome.ceilingBytes, prunedCalls: outcome.pruned.length }, ...context });
    return true;
  }

  private async callAdapter(
    messages: ChatMessage[],
    registry: ToolRegistry,
    systemPrompt: string,
    context: SessionEventContext,
    signal?: AbortSignal,
  ): Promise<AdapterResponse> {
    const stateKey = this.adapter.sessionStateKey;
    const projectedState = stateKey === undefined
      ? undefined
      : this.session.getAdapterSessionState(stateKey);
    let streamed = false;
    const response = await this.adapter.chat(messages, registry, {
      stream: this.providerListener !== undefined,
      onEvent: (event) => {
        if (event.type === "provider.text.delta" && this.providerListener) streamed = true;
        this.observeProvider(event, context);
      },
      systemPrompt,
      ...(signal === undefined ? {} : { signal }),
      ...(projectedState === undefined ? {} : { sessionState: { ...projectedState } }),
    });
    if (streamed) this.streamedResponses.add(response);
    validatedAdapterToolCalls(response);
    this.recordModelResponse(response, context);
    if (response.sessionState !== undefined) {
      if (stateKey === undefined || response.sessionState.key !== stateKey) {
        throw new Error(
          `Adapter "${this.provider}" returned continuation state for an unexpected key`,
        );
      }
      this.session.setAdapterSessionState(response.sessionState, context);
    }
    return response;
  }

  private clearAdapterSessionState(
    reason: string,
    context: SessionEventContext = {},
  ): void {
    const key = this.adapter.sessionStateKey;
    if (key !== undefined) {
      this.session.clearAdapterSessionState(key, reason, context);
    }
  }

  private snapshotAdapterSessionState(): AdapterSessionState | undefined {
    const key = this.adapter.sessionStateKey;
    if (key === undefined) return undefined;
    const state = this.session.getAdapterSessionState(key);
    return state === undefined ? undefined : { ...state };
  }

  private restoreAdapterSessionState(
    priorState: AdapterSessionState | undefined,
    clearReason: string,
    context: SessionEventContext,
  ): void {
    const key = this.adapter.sessionStateKey;
    if (key === undefined) return;
    if (priorState === undefined) {
      this.session.clearAdapterSessionState(key, clearReason, context);
      return;
    }
    this.session.setAdapterSessionState(priorState, context);
  }

  private async executeTool(
    call: ToolCall,
    executionMode: RunToolExecutionMode,
    context: SessionEventContext,
    executionContext: ToolExecutionContext,
    registry: ToolRegistry,
    rememberEffect: (
      call: ToolCall,
      executionMode: RunToolExecutionMode,
      result: RunToolEffectReceipt["result"],
      context: SessionEventContext,
    ) => void,
  ): Promise<{
    result: Awaited<ReturnType<ToolRegistry["execute"]>>;
    modelContent: string;
  }> {
    this.session.append({ type: "tool/call", data: { call, executionMode }, ...context });
    this.session.append({
      type: "tool/execution-started",
      data: { call, executionMode },
      ...context,
    });
    rememberEffect(call, executionMode, {
      success: false,
      error: "Tool execution started without a durable result receipt",
      executionOutcome: "unknown",
    }, context);

    let result: Awaited<ReturnType<ToolRegistry["execute"]>>;
    try {
      result = await registry.execute(call.name, call.args, executionContext);
    } catch (error) {
      return this.recordUncertainToolResult(
        call,
        executionMode,
        error,
        context,
        rememberEffect,
      );
    }

    const execution = normalizeToolResult(call.name, result);
    const normalizedResult = sanitizeToolResult(execution.result);
    const serializedResult = JSON.stringify(normalizedResult);
    let modelResult = serializedResult;
    const project = registry.get(call.name)?.modelResult;
    if (project) {
      try {
        // Project a copy: presentation cannot mutate the execution receipt.
        // Apply serialization hooks before validating or redacting, just as
        // at the executor boundary. Hooks cannot replace checked content later.
        const projected = sanitizeToolResult(JSON.parse(JSON.stringify(project(JSON.parse(serializedResult)))));
        if (projected.success === normalizedResult.success
          && projected.executionOutcome === normalizedResult.executionOutcome
          && (projected.error === undefined || typeof projected.error === "string")) {
          modelResult = JSON.stringify(projected);
        }
      } catch { /* A presentation failure must not change a known tool outcome. */ }
    }
    const bounded = boundToolOutput(serializedResult, this.toolOutput, call.id);
    const modelContent = modelResult === serializedResult ? bounded.content
      : boundToolOutput(modelResult, { ...this.toolOutput, spillDir: undefined }, call.id, bounded.fullOutputRef).content;
    const executionOutcome = execution.outcome;
    const normalizedRecord = normalizedResult as unknown as Record<string, unknown>;
    rememberEffect(call, executionMode, {
      success: normalizedResult.success,
      ...(Object.prototype.hasOwnProperty.call(normalizedRecord, "data")
        ? { data: normalizedRecord.data }
        : {}),
      ...(normalizedResult.error === undefined ? {} : { error: normalizedResult.error }),
      executionOutcome,
    }, context);

    // append() can throw after durably committing the event. Protect the
    // spill before calling it and never delete on an ambiguous error, or a
    // committed journal reference could be left dangling. A true pre-commit
    // orphan is reclaimed after the grace period or on session deletion.
    if (bounded.fullOutputRef !== undefined) {
      this.protectedSpillRefs.add(bounded.fullOutputRef);
      this.scheduleSpillCollection();
    }
    this.session.append({
      type: "tool/result",
      data: {
          toolCallId: call.id,
          toolName: call.name,
          outcome: executionOutcome,
          // The durable journal is bounded: an under-cap result is persisted
          // whole; an over-cap result is persisted only as its bounded
          // preview (modelContent) plus output metadata — the complete bytes
          // live in the spill file, never in the journal.
          ...(bounded.truncated ? {} : { result: normalizedResult }),
          modelContent,
          ...(bounded.truncated
            ? {
                output: {
                  truncated: true as const,
                  byteCount: bounded.byteCount,
                  lineCount: bounded.lineCount,
                  ...(bounded.fullOutputRef ? { fullOutputRef: bounded.fullOutputRef } : {}),
                },
              }
            : {}),
          ...(normalizedResult.error === undefined
            ? {}
            : {
                error: bounded.truncated
                  ? bytePrefix(normalizedResult.error, 2048)
                  : normalizedResult.error,
              }),
      },
      ...context,
    });
    return { result: normalizedResult, modelContent };
  }

  /**
   * Declare a call that cancellation prevented from ever starting. Only the
   * tool/call event is journaled — no execution-started, no fabricated
   * result. The kernel's interruption repair is the single authority for
   * closing a declared-but-never-started call: it records a definitive
   * failed (not unknown) receipt and the paired model-facing tool message
   * when the aborted turn closes.
   */
  private declareCancelledToolCall(
    call: ToolCall,
    executionMode: RunToolExecutionMode,
    context: SessionEventContext,
  ): void {
    this.session.append({ type: "tool/call", data: { call, executionMode }, ...context });
  }

  /**
   * Close a started execution even when the executor pipeline itself fails.
   * The underlying side effect may have happened, so this is deliberately an
   * unknown outcome rather than a synthetic failed tool result.
   */
  private recordUncertainToolResult(
    call: ToolCall,
    executionMode: RunToolExecutionMode,
    error: unknown,
    context: SessionEventContext,
    rememberEffect: (
      call: ToolCall,
      executionMode: RunToolExecutionMode,
      result: RunToolEffectReceipt["result"],
      context: SessionEventContext,
    ) => void,
  ): {
    result: Awaited<ReturnType<ToolRegistry["execute"]>>;
    modelContent: string;
  } {
    const message = redactSensitiveText(
      `Tool execution outcome is unknown: ${errorMessage(error)}`,
    );
    const result = {
      success: false,
      error: message,
      executionOutcome: "unknown" as const,
    };
    // Same single output boundary as the success path — including the
    // journal: a truncated representation is persisted without the full
    // result or an unbounded error string.
    const bounded = boundToolOutput(JSON.stringify(result), this.toolOutput, call.id);
    const modelContent = bounded.content;
    rememberEffect(call, executionMode, result, context);
    if (bounded.fullOutputRef !== undefined) {
      this.protectedSpillRefs.add(bounded.fullOutputRef);
      this.scheduleSpillCollection();
    }
    this.session.append({
      type: "tool/result",
      data: {
          toolCallId: call.id,
          toolName: call.name,
          outcome: "unknown",
          ...(bounded.truncated ? {} : { result }),
          error: bounded.truncated ? bytePrefix(message, 2048) : message,
          modelContent,
          ...(bounded.truncated
            ? {
                output: {
                  truncated: true as const,
                  byteCount: bounded.byteCount,
                  lineCount: bounded.lineCount,
                  ...(bounded.fullOutputRef ? { fullOutputRef: bounded.fullOutputRef } : {}),
                },
              }
            : {}),
      },
      ...context,
    });
    return { result, modelContent };
  }

  private async chatAsync(
    message: ChatContent,
    options?: ChatAgentChatOptions,
  ): Promise<ChatResult> {
    let result: ChatResult | undefined;
    for await (const chunk of this.runTurn(message, options)) {
      if (chunk.type === "done") result = chunk.result;
    }
    if (!result) throw new Error("chat turn ended without a result");
    return result;
  }

  // ── One turn engine, projected as promise or stream ───────────────────

  private async *chatStream(
    message: ChatContent,
    options?: ChatAgentChatOptions,
  ): AsyncIterable<ChatStreamChunk> {
    yield* this.runTurn(message, options);
  }

  private async *runTurn(
    message: ChatContent,
    options?: ChatAgentChatOptions,
  ): AsyncGenerator<ChatStreamChunk> {
    // Snapshot trusted checks before waiting for the turn or making a request.
    const suppliedVerification = options?.completionVerification;
    const completionVerification = suppliedVerification && {
      ...suppliedVerification,
      argv: [...suppliedVerification.argv], files: [...suppliedVerification.files],
      context: {...suppliedVerification.context, approval: suppliedVerification.context.approval
        ? {...suppliedVerification.context.approval} : undefined},
    };
    const release = await this.acquireTurn(options?.signal);
    this.providerListener = options?.onProviderEvent;
    this.providerReceipts = [];
    try {
      throwIfAborted(options?.signal);
      this.switchThreadIfNeeded(options?.threadId);
      const currentThreadId = this.threadId;
      const prompt = options?.systemPrompt ?? this.systemPrompt;
      const projectConversationHistory = (): void => {
        if (!this.conversationMemory) return;
        try {
          this.conversationMemory.replaceMessages(
            currentThreadId,
            this.currentHistory(),
          );
        } catch (error) {
          console.warn(
            `Conversation-memory projection failed: ${errorMessage(error)}`,
          );
        }
      };
      this.ensureSeeded();
      await this.maybeCompact(options?.signal);
      throwIfAborted(options?.signal);

      let run = createRunManifest({
        ...options?.run,
        actor: { kind: "chat_agent", name: this.name },
        adapter: this.adapter,
        instructions: prompt,
        tools: this.registry.getAll(),
        maxRounds: this.maxToolRounds,
        maxParallelTools: this.maxParallelTools,
        toolOutput: this.toolOutput,
      });
      const baseContext = this.eventContext(run);
      const historyBefore = this.currentHistory();
      const adapterStateBefore = this.snapshotAdapterSessionState();
      const userMessage: ChatMessage = { role: "user", content: message };
      const toolCalls: ChatResult["toolCalls"] = [];
      const repetition = createRepetitionTracker();
      const effectReceipts = new Map<string, RunToolEffectReceipt>();
      const effectReceiptKey = (
        stepId: string | undefined,
        callId: string,
      ): string => `${stepId ?? ""}\0${callId}`;
      const rememberEffect = (
        call: ToolCall,
        executionMode: RunToolExecutionMode,
        result: RunToolEffectReceipt["result"],
        context: SessionEventContext,
      ): void => {
        effectReceipts.set(effectReceiptKey(context.stepId, call.id), {
          callId: call.id,
          name: call.name,
          executionMode,
          args: { ...call.args },
          result: { ...result },
        });
      };
      const markUndurableEffectsUnknown = (failure: unknown): void => {
        const durableResultKeys = new Set(
          this.session.getEvents().flatMap((event) => (
            event.type === "tool/result"
            && event.runId === run.manifest.runId
              ? [effectReceiptKey(event.stepId, event.data.toolCallId)]
              : []
          )),
        );
        for (const [key, receipt] of effectReceipts) {
          if (durableResultKeys.has(key)) continue;
          effectReceipts.set(key, {
            ...receipt,
            result: {
              success: false,
              error: `Durable tool result receipt was not recorded: ${errorMessage(failure)}`,
              executionOutcome: "unknown",
            },
          });
        }
      };
      let rounds = 0;
      let maxRounds = this.maxToolRounds;
      let finalText = "";
      let verification: CandidateVerificationReceipt | undefined;
      let assistantTurnComplete = false;
      // One feedback round per turn: a second user-directed answer fails the run.
      let settlementFeedbackGiven = false;
      let activeStepId: string | undefined;
      // Steering is appended only between steps, never while a step or tool
      // is open; the journal rejects a user message there.
      const steeredIds = new Set<string>();
      const deliverSteering = (): number => {
        const source = options?.steering;
        if (!source) return 0;
        let delivered = 0;
        for (const {id, message} of source.pending()) {
          if (steeredIds.has(id) || !message.trim()) continue;
          steeredIds.add(id);
          this.session.appendMessage({role: "user", content: message}, baseContext);
          delivered += 1;
          source.onDelivered?.(id);
        }
        return delivered;
      };
      let turnStarted = false;
      let terminalRecorded = false;
      let interruptionReason: string | undefined;
      let toolExecutionStarted = false;
      let journalRecoveryRequired = false;
      let effectHistoryCheckpoint: ChatMessage[] | undefined;
      let effectStateCheckpoint: AdapterSessionState | undefined;
      // Set only once a tool batch has durable result receipts. Request pruning
      // before that point must not turn a failed turn into a partial-effects
      // rollback that retains the unanswered user message.
      let toolEffectsCheckpointed = false;
      let pendingFailure: RunExecutionError | undefined;
      let pendingTerminal: {
        outcome: "failed" | "interrupted";
        reason: string;
      } | undefined;

      const terminateTurn = (
        outcome: "failed" | "interrupted",
        reason: string,
      ): void => {
        if (journalRecoveryRequired || terminalRecorded || !turnStarted) return;
        if (activeStepId !== undefined) {
          this.session.append({
            type: "step/completed",
            data: { outcome, reason },
            ...this.eventContext(run, activeStepId),
          });
          activeStepId = undefined;
        }
        const retainedHistory = effectHistoryCheckpoint ?? historyBefore;
        const retainedState = effectHistoryCheckpoint === undefined
          ? adapterStateBefore
          : effectStateCheckpoint;
        const rollbackReason = effectHistoryCheckpoint === undefined
          ? `turn_${outcome}`
          : `turn_${outcome}_partial_effects`;
        this.session.replaceHistory(retainedHistory, rollbackReason, baseContext);
        this.restoreAdapterSessionState(retainedState, rollbackReason, baseContext);
        if (outcome === "failed") {
          this.session.append({
            type: "turn/failed",
            data: { error: reason, rounds },
            ...baseContext,
          });
        } else {
          this.session.append({
            type: "turn/interrupted",
            data: { reason, recovered: false },
            ...baseContext,
          });
        }
        terminalRecorded = true;
        if (effectHistoryCheckpoint !== undefined) projectConversationHistory();
      };

      const recoverInterruptedBatch = (failure: unknown): void => {
        if (!journalRecoveryRequired) return;
        markUndurableEffectsUnknown(failure);
        try {
          this.session.recoverInterrupted(
            "chat turn recovered after an interrupted tool batch; tools were not retried",
          );
          journalRecoveryRequired = false;
          activeStepId = undefined;
          terminalRecorded = true;
          if (effectReceipts.size > 0) projectConversationHistory();
        } catch {
          // Keep the incomplete journal intact for startup recovery. A
          // second lifecycle-write failure must not mask effect receipts.
        }
      };

      try {
        this.session.append({
          type: "turn/started",
          data: { input: userMessage },
          ...baseContext,
        });
        turnStarted = true;
        this.session.appendMessage(userMessage, baseContext);
        throwIfAborted(options?.signal);

        let incompleteRetries = 0;
        let tooLargeRetried = false;
        while (maxRounds-- > 0) {
          throwIfAborted(options?.signal);
          deliverSteering();
          // Between steps: keep the request inside the lane's byte ceiling (CLI-046).
          if (this.fitRequestBudget(prompt, baseContext, "preemptive") && toolEffectsCheckpointed) effectHistoryCheckpoint = this.currentHistory();
          rounds += 1;
          const nextStepId = randomUUID();
          const stepContext = this.eventContext(run, nextStepId);
          this.session.append({
            type: "step/started",
            data: { index: rounds - 1 },
            ...stepContext,
          });
          activeStepId = nextStepId;
          const suppliedExecution = this.executionContext?.();
          const executionSnapshot = suppliedExecution === undefined ? undefined : Object.freeze({
            ...suppliedExecution,
            ...(suppliedExecution.approval ? {approval: Object.freeze({...suppliedExecution.approval})} : {}),
          });
          const requestRegistry = snapshotToolRegistry(this.registry, executionSnapshot?.approval?.policy);
          const requestMessages = this.currentHistory();
          const toolSnapshot = this.modelToolSnapshot(requestRegistry);
          this.recordModelRequest(
            requestMessages,
            prompt,
            toolSnapshot,
            { toolChoice: "auto", execution: executionSnapshot ? { workspaceRoot: executionSnapshot.workspaceRoot, sessionCwd: executionSnapshot.sessionCwd, approval: executionSnapshot.approval, deadline: executionSnapshot.deadline } : undefined },
            stepContext,
          );
          const stepAdapterStateBefore = this.snapshotAdapterSessionState();
          let response: AdapterResponse;
          try {
            response = await this.callAdapter(
              requestMessages,
              requestRegistry,
              prompt,
              stepContext,
              options?.signal,
            );
          } catch (error) {
            throwIfAborted(options?.signal);
            const tooLarge = error instanceof ProviderHttpError && error.status === 413 && !tooLargeRetried;
            const truncated = reasoningOnlyTruncation(error) && incompleteRetries < INCOMPLETE_RETRY_LIMIT;
            if (!tooLarge && !truncated) throw error;
            // The attempt is its own journal step: close it as failed, then retry in a
            // fresh step. A 413 prunes harder once (CLI-046); a reasoning-only
            // truncation replays the same request, bounded (CLI-045). A retry does not
            // consume a tool round, so the last permitted round can still be replayed,
            // and it is not a reported round either.
            maxRounds += 1;
            rounds -= 1;
            this.restoreAdapterSessionState(stepAdapterStateBefore, "failed_model_request_rolled_back", stepContext);
            this.session.append({ type: "step/completed", data: { outcome: "failed", reason: tooLarge ? "request_too_large_retry" : "provider_incomplete_retry" }, ...stepContext });
            activeStepId = undefined;
            if (tooLarge) {
              tooLargeRetried = true;
              if (!this.fitRequestBudget(prompt, baseContext, "http-413", true)) throw error;
              if (toolEffectsCheckpointed) effectHistoryCheckpoint = this.currentHistory();
            } else {
              incompleteRetries += 1;
              const finishReason = (error as ProviderIncompleteError).finishReason;
              this.session.append({ type: "model/incomplete-retry", data: { finishReason, attempt: incompleteRetries }, ...baseContext });
              if (incompleteRetries === INCOMPLETE_RETRY_LIMIT) {
                // The identical request has already been replayed once; change the ask.
                this.session.appendMessage({ role: "user", content: truncationNudge(finishReason, incompleteRetries) }, baseContext);
                effectHistoryCheckpoint = this.currentHistory();
              }
            }
            continue;
          }
          throwIfAborted(options?.signal);

          const calls = validatedAdapterToolCalls(response);
          if (response.text && calls.length > 0) {
            yield { type: "text", text: response.text, streamed: this.streamedResponses.has(response) };
          }

          if (calls.length > 0) {
            for (const call of calls) {
              yield { type: "tool_call", toolCall: { name: call.name, args: call.args, callId: call.id } };
            }
            throwIfAborted(options?.signal);
            const assistantCallMessage: ChatMessage = calls.length === 1
              ? {
                  role: "assistant",
                  content: JSON.stringify(calls[0].args),
                  toolCallId: calls[0].id,
                  toolName: calls[0].name,
                  ...(response.thinking && { thinkingBlocks: response.thinking }),
                  ...(response.providerReplay === undefined
                    ? {}
                    : { providerReplay: response.providerReplay }),
                }
              : {
                  role: "assistant",
                  content: "",
                  toolCalls: calls,
                  ...(response.thinking && { thinkingBlocks: response.thinking }),
                  ...(response.providerReplay === undefined
                    ? {}
                    : { providerReplay: response.providerReplay }),
                };
            this.session.appendMessage(assistantCallMessage, stepContext);

            toolExecutionStarted = true;
            journalRecoveryRequired = true;
            const callModes = calls.map((call) => (
              classifyToolCall(requestRegistry.get(call.name), call.args)
            ));
            // Bounded admission: parallel-safe calls share a capped pool,
            // exclusive calls (the fail-closed default) run alone as
            // barriers. Abort stops admissions — started calls drain, and a
            // never-started call is only DECLARED (tool/call event): the
            // kernel's interruption repair closes it with a definitive
            // failed/not-started receipt when the aborted turn ends.
            const batchOutcomes = await runToolBatch(calls, {
              mode: (_call, index) => callModes[index] ?? "exclusive",
              execute: (call, index) => this.executeTool(
                call,
                callModes[index] ?? "exclusive",
                stepContext,
                {
                  workspaceRoot: process.cwd(), sessionCwd: process.cwd(),
                  ...executionSnapshot,
                  sessionId: this.session.sessionId,
                  turnId: stepContext.turnId!, callId: call.id,
                  signal: options?.signal,
                },
                requestRegistry,
                rememberEffect,
              ),
              maxParallel: this.maxParallelTools,
              isCancelled: () => options?.signal?.aborted === true,
            });
            const executions: Array<
              { result: Awaited<ReturnType<ToolRegistry["execute"]>>; modelContent: string } | null
            > = [];
            for (let index = 0; index < calls.length; index += 1) {
              const outcome = batchOutcomes[index];
              if (outcome.status === "rejected") throw outcome.reason;
              if (outcome.status === "cancelled") {
                this.declareCancelledToolCall(
                  calls[index],
                  callModes[index] ?? "exclusive",
                  stepContext,
                );
                executions.push(null);
              } else {
                executions.push(outcome.value);
              }
            }
            const resultChunks: ChatStreamChunk[] = [];
            const repetitionNotices: string[] = [];
            let uncertainExecution = false;
            for (let index = 0; index < calls.length; index += 1) {
              const call = calls[index];
              const execution = executions[index];
              // Cancelled-before-start: declared above, closed by the
              // kernel's interruption repair — no message or chunk here.
              if (execution === null) continue;
              const repetitionNotice = repetition.observe(call);
              if (repetitionNotice !== undefined) repetitionNotices.push(repetitionNotice);
              this.session.appendMessage({
                role: "tool",
                content: execution.modelContent,
                toolCallId: call.id,
                toolName: call.name,
              }, stepContext);
              toolCalls.push({
                callId: call.id,
                name: call.name,
                executionMode: callModes[index] ?? "exclusive",
                args: call.args,
                result: {
                  success: execution.result.success,
                  data: execution.result.data,
                  error: execution.result.error,
                  executionOutcome: execution.result.executionOutcome,
                },
              });
              resultChunks.push({
                type: "tool_result",
                toolResult: {
                  name: call.name,
                  success: execution.result.success,
                  data: execution.result.data,
                  error: execution.result.error,
                  executionOutcome: execution.result.executionOutcome,
                  callId: call.id,
                  outputPreview: execution.modelContent,
                },
              });
              uncertainExecution ||= execution.result.executionOutcome === "unknown";
            }
            // A tool batch is safe to retain in model history only after every
            // call has a matching durable result receipt. Until this point,
            // rollback must discard the entire batch even though an external
            // side effect may already have started. A cancelled-before-start
            // call was only DECLARED (no receipt yet), so recovery must still
            // run at turn close to give it its not-started receipt.
            effectHistoryCheckpoint = this.currentHistory();
            effectStateCheckpoint = this.snapshotAdapterSessionState();
            toolEffectsCheckpointed = true;
            journalRecoveryRequired = batchOutcomes.some(
              (outcome) => outcome.status === "cancelled",
            );
            // Journal every result before yielding any result chunk. A stream
            // consumer may close at a yield boundary, but completed effects
            // must still have model-facing receipts in call order.
            for (const chunk of resultChunks) yield chunk;
            throwIfAborted(options?.signal);
            if (uncertainExecution) {
              throw new Error(
                "One or more tool outcomes are unknown; verify side effects before deciding whether any retry is safe",
              );
            }
            this.session.append({
              type: "step/completed",
              data: { outcome: "completed", reason: "tool_results" },
              ...stepContext,
            });
            activeStepId = undefined;
            // Notices follow the complete tool batch and are ordinary durable
            // history, so replay and request hashing see the same model input.
            for (const content of repetitionNotices) {
              this.session.appendMessage({ role: "user", content }, baseContext);
            }
            effectHistoryCheckpoint = this.currentHistory();
            continue;
          }

          // Settle before projecting: a user-directed answer in a noninteractive
          // run is never yielded as answer text. Streamed deltas may already
          // have reached the listener, so the stream carries an explicit
          // settlement chunk that consumers render as a withdrawal.
          const unsettledRequest = options?.noninteractive && response.text && !completionVerification
            ? detectUserDirectedRequest(response.text)
            : undefined;
          if (response.text) {
            finalText = response.text;
            this.session.appendMessage(
              {
                role: "assistant",
                content: response.text,
                ...(response.providerReplay === undefined
                  ? {}
                  : { providerReplay: response.providerReplay }),
              },
              stepContext,
            );
            if (!unsettledRequest) {
              assistantTurnComplete = true;
              yield { type: "text", text: response.text, streamed: this.streamedResponses.has(response) };
              throwIfAborted(options?.signal);
            }
          }
          if (!response.text) {
            this.restoreAdapterSessionState(
              stepAdapterStateBefore,
              "empty_model_response_rolled_back",
              stepContext,
            );
          }
          this.session.append({
            type: "step/completed",
            data: {
              outcome: "completed",
              reason: response.text ? "model_response" : "empty_model_response",
            },
            ...stepContext,
          });
          activeStepId = undefined;
          if (options?.noninteractive && unsettledRequest) {
            // No person will ever answer a question asked here. Treat the answer
            // as unsettled: one bounded reminder, then an honest failure. When an
            // objective completion check is configured it settles the task instead.
            const request = unsettledRequest;
            {
              const approvalPolicy = options.noninteractive.approvalPolicy;
              if (settlementFeedbackGiven) {
                this.session.append({type: "settlement/user-directed", data: {cue: request.cue, action: "failed", approvalPolicy}, ...baseContext});
                yield { type: "settlement", settlement: { action: "failed", cue: request.cue, streamed: this.streamedResponses.has(response) } };
                throw new Error(NONINTERACTIVE_UNSETTLED_ERROR);
              }
              settlementFeedbackGiven = true;
              this.session.append({type: "settlement/user-directed", data: {cue: request.cue, action: "feedback", approvalPolicy}, ...baseContext});
              yield { type: "settlement", settlement: { action: "feedback", cue: request.cue, streamed: this.streamedResponses.has(response) } };
              assistantTurnComplete = false;
              finalText = "";
              // This write must succeed before the next inference request.
              this.session.appendMessage({role: "user", content: noninteractiveFeedback(approvalPolicy, request)}, baseContext);
              effectHistoryCheckpoint = this.currentHistory();
              effectStateCheckpoint = this.snapshotAdapterSessionState();
              if (maxRounds <= 0) throw new Error(NONINTERACTIVE_UNSETTLED_ERROR);
              continue;
            }
          }
          if (completionVerification && !response.text) {
            throw new Error("The model returned no candidate answer; configured verification was not run");
          }
          if (completionVerification && response.text) {
            // This is inside the turn lease: never call the public locking API.
            verification = await this.recordVerification({
              ...completionVerification,
              context: {...completionVerification.context, sessionId: this.session.sessionId,
                turnId: run.manifest.runId, callId: randomUUID(), signal: options?.signal},
            }, receipt => {
              // A prepared check may have effects even if the settled receipt
              // subsequently cannot be written. Recovery must preserve that fact.
              journalRecoveryRequired = receipt.completedAt === "";
              effectHistoryCheckpoint = this.currentHistory();
              effectStateCheckpoint = this.snapshotAdapterSessionState();
              options?.onVerification?.(receipt);
            });
            if (verification.status === "passed") {
              const freshness = verifyReceiptCurrent(verification);
              if (!freshness.current) {
                verification = {...verification, status: "stale", reason: freshness.reason};
                this.session.append({type: "verification/recorded", data: {receipt: verification}});
                options?.onVerification?.(structuredClone(verification));
              }
            }
            throwIfAborted(options?.signal);
            if (verification.status !== "passed") {
              assistantTurnComplete = false;
              finalText = "";
              if (!verificationAllowsRepair(verification)) {
                throw new Error(`Candidate verification ${verification.status}: ${verification.reason ?? 'check did not pass'}; automatic repair was not admitted`);
              }
              // This write must succeed before the next inference request.
              this.session.appendMessage({role: "user", content: verificationFeedback(verification)}, baseContext);
              effectHistoryCheckpoint = this.currentHistory();
              effectStateCheckpoint = this.snapshotAdapterSessionState();
              if (maxRounds <= 0) { maxRounds = -1; break; }
              continue;
            }
          }
          // A correction that arrived while the model was answering would
          // otherwise wait for the next turn. Give the model a step to act on it.
          if (maxRounds > 0 && deliverSteering() > 0) {
            assistantTurnComplete = false;
            finalText = "";
            effectHistoryCheckpoint = this.currentHistory();
            effectStateCheckpoint = this.snapshotAdapterSessionState();
            continue;
          }
          break;
        }

        if (!finalText && maxRounds < 0 && !completionVerification) {
          // The finalizer sends its own, longer prompt: fit the request against that one.
          const finalizerPrompt = this.exhaustedToolRoundSystemPrompt(options?.systemPrompt);
          if (this.fitRequestBudget(finalizerPrompt, baseContext, "preemptive") && toolEffectsCheckpointed) effectHistoryCheckpoint = this.currentHistory();
          const finalizerStepId = randomUUID();
          const finalizerContext = this.eventContext(run, finalizerStepId);
          this.session.append({
            type: "step/started",
            data: { index: rounds },
            ...finalizerContext,
          });
          activeStepId = finalizerStepId;
          const requestMessages = this.currentHistory();
          this.recordModelRequest(
            requestMessages,
            finalizerPrompt,
            [],
            { finalizer: true },
            finalizerContext,
          );
          const finalizerStateBefore = this.snapshotAdapterSessionState();
          const response = await this.callAdapter(
            requestMessages,
            new ToolRegistry(),
            finalizerPrompt,
            finalizerContext,
            options?.signal,
          );
          throwIfAborted(options?.signal);
          if (validatedAdapterToolCalls(response).length > 0) {
            throw new Error("Tool-round finalizer returned a tool call after tools were disabled");
          }
          finalText = response.text?.trim() || "";
          if (finalText) {
            this.session.appendMessage(
              {
                role: "assistant",
                content: finalText,
                ...(response.providerReplay === undefined
                  ? {}
                  : { providerReplay: response.providerReplay }),
              },
              finalizerContext,
            );
            if (options?.noninteractive && !completionVerification) {
              // The response is projected; with no retry round left, a
              // user-directed finalizer answer fails the run outright.
              const request = detectUserDirectedRequest(finalText);
              if (request) {
                this.session.append({type: "settlement/user-directed", data: {cue: request.cue, action: "failed", approvalPolicy: options.noninteractive.approvalPolicy}, ...finalizerContext});
                yield { type: "settlement", settlement: { action: "failed", cue: request.cue, streamed: this.streamedResponses.has(response) } };
                throw new Error(NONINTERACTIVE_UNSETTLED_ERROR);
              }
            }
            assistantTurnComplete = true;
            yield { type: "text", text: finalText, streamed: this.streamedResponses.has(response) };
            throwIfAborted(options?.signal);
          }
          if (!finalText) {
            this.restoreAdapterSessionState(
              finalizerStateBefore,
              "empty_tool_round_finalizer_rolled_back",
              finalizerContext,
            );
          }
          this.session.append({
            type: "step/completed",
            data: {
              outcome: "completed",
              reason: finalText ? "tool_round_finalizer" : "empty_tool_round_finalizer",
            },
            ...finalizerContext,
          });
          activeStepId = undefined;
        }

        if (!finalText) {
          finalText = maxRounds < 0
            ? "(tool round limit reached before the model produced a final answer)"
            : "(empty response from model)";
          yield { type: "text", text: finalText };
          throwIfAborted(options?.signal);
        }

        if (!assistantTurnComplete && effectHistoryCheckpoint === undefined) {
          this.session.replaceHistory(
            historyBefore,
            "turn_without_assistant_rolled_back",
            baseContext,
          );
          this.restoreAdapterSessionState(
            adapterStateBefore,
            "turn_without_assistant_rolled_back",
            baseContext,
          );
        }
        throwIfAborted(options?.signal);
        let completedRun = completeRun(run, { limitReached: maxRounds < 0 });
        completedRun = attachToolEffects(
          completedRun,
          toolCalls,
          [...effectReceipts.values()],
        );
        const outcome = completedRun.status === "completed" && assistantTurnComplete
          ? createOutcomeClaim(completedRun, finalText)
          : undefined;
        this.session.append({
          type: "turn/completed",
          data: {
            reason: completedRun.stopReason,
            rounds,
            finalText,
            assistantTurnComplete,
            runStatus: completedRun.status,
          },
          ...baseContext,
        });
        terminalRecorded = true;
        // Keep the mutable execution record running until the terminal event
        // is durable. If that append fails, the catch path can still produce a
        // failed RunExecutionError with every prior tool-effect receipt.
        run = completedRun;
        if (this.conversationMemory && (assistantTurnComplete || effectHistoryCheckpoint !== undefined)) {
          projectConversationHistory();
        }
        if (assistantTurnComplete) {
          try {
            this.appendTurnRollout(message, finalText);
          } catch (error) {
            console.warn(`Legacy rollout projection failed: ${errorMessage(error)}`);
          }
        }
        yield {
          type: "done",
          result: {
            text: finalText,
            ...(verification ? {verification} : {}),
            providerReceipts: [...this.providerReceipts],
            toolCalls,
            rounds,
            run,
            ...(outcome && { outcome }),
            metadata: {
              provider: this.provider,
              model: this.model,
              threadId: currentThreadId,
            },
          },
        };
      } catch (error) {
        recoverInterruptedBatch(error);
        let failure: RunExecutionError;
        if (isAbortInterruption(error, options?.signal)) {
          interruptionReason = options?.signal?.aborted
            ? abortedTurnReason(options.signal)
            : `chat turn interrupted: ${errorMessage(error)}`;
          run = cancelRun(run, {
            effects: toolExecutionStarted ? "partial" : "none",
            reason: interruptionReason,
            ...(toolExecutionStarted
              ? { verificationRequired: "verify tool side effects before deciding whether any retry is safe" }
              : {}),
          });
          run = attachToolEffects(run, toolCalls, [...effectReceipts.values()]);
          failure = new RunExecutionError(
            `Chat agent "${this.name}" was cancelled: ${interruptionReason}`,
            run,
            { cause: error },
          );
          pendingTerminal = { outcome: "interrupted", reason: interruptionReason };
        } else if (error instanceof RunExecutionError) {
          failure = error;
          pendingTerminal = { outcome: "failed", reason: errorMessage(error) };
        } else {
          run = failRun(run, error);
          run = attachToolEffects(run, toolCalls, [...effectReceipts.values()]);
          failure = new RunExecutionError(
            `Chat agent "${this.name}" failed: ${errorMessage(error)}`,
            run,
            { cause: error },
          );
          pendingTerminal = { outcome: "failed", reason: errorMessage(error) };
        }
        pendingFailure = failure;
        try {
          terminateTurn(pendingTerminal.outcome, pendingTerminal.reason);
        } catch (terminalError) {
          failure = new RunExecutionError(
            failure.message,
            failure.run,
            {
              cause: new AggregateError(
                [error, terminalError],
                "Chat turn failed and its journal terminalization also failed",
              ),
            },
          );
          pendingFailure = failure;
        }
        throw failure;
      } finally {
        // Async-generator return() does not enter the catch block. Balance a
        // turn whose stream consumer stops at a yield boundary.
        recoverInterruptedBatch(
          pendingFailure
          ?? new Error(interruptionReason ?? "stream consumer closed before turn completed"),
        );
        if (turnStarted && !terminalRecorded && !journalRecoveryRequired) {
          const terminal = pendingTerminal ?? {
            outcome: "interrupted" as const,
            reason: interruptionReason ?? "stream consumer closed before turn completed",
          };
          try {
            terminateTurn(terminal.outcome, terminal.reason);
          } catch (terminalError) {
            if (pendingFailure === undefined) throw terminalError;
          }
        }
      }
    } finally {
      this.providerListener = undefined;
      release();
    }
  }

  // ── Interactive CLI ────────────────────────────────────────────────────

  async interactive(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const toolCount = this.registry.listNames().length;

    console.log(`\n╔══════════════════════════════════════════════════╗`);
    console.log(`║         Siftable Agent Harness — AI Chat         ║`);
    console.log(`╚══════════════════════════════════════════════════╝\n`);
    console.log(`  Agent:    ${this.name}`);
    console.log(`  Provider: ${this.provider}`);
    console.log(`  Model:    ${this.model}`);
    console.log(`  Tools:    ${toolCount} registered`);
    console.log(`  Memory:   ${this.conversationMemory ? "on" : "off"}`);
    console.log(`  Thread:   ${this.threadId}\n`);
    console.log(`Type a message to chat. The AI can call your tools.`);
    console.log(`Commands: "reset", "history", "facts", "quit"\n`);

    const ask = () => {
      rl.question("You: ", async (input) => {
        const trimmed = input.trim();
        if (!trimmed || trimmed === "quit" || trimmed === "exit") {
          console.log("\nGoodbye!\n");
          rl.close();
          process.exit(0);
        }

        if (trimmed === "reset") {
          await this.resetAsync();
          console.log("\n  (conversation reset)\n");
          ask();
          return;
        }

        if (trimmed === "history") {
          const turns = this.session.getHistory().filter((m) => m.role === "user").length;
          console.log(`\n  ${turns} turn(s) in current session\n`);
          ask();
          return;
        }

        if (trimmed === "facts") {
          if (!this.factMemory) {
            console.log("\n  Memory is disabled\n");
          } else {
            const facts = this.factMemory.getAllFacts();
            if (facts.length === 0) {
              console.log("\n  No stored facts\n");
            } else {
              console.log(`\n  ${facts.length} stored fact(s):`);
              for (const f of facts) {
                console.log(`  - ${f.content}`);
              }
              console.log();
            }
          }
          ask();
          return;
        }

        try {
          // Use streaming for interactive mode — show tool calls as they happen
          for await (const chunk of this.chatStream(trimmed)) {
            switch (chunk.type) {
              case "tool_call":
                console.log(
                  `\n  [Tool Call] ${chunk.toolCall!.name}(${JSON.stringify(chunk.toolCall!.args)})`,
                );
                break;
              case "tool_result":
                console.log(
                  `  [Result]   ${JSON.stringify(chunk.toolResult!.data ?? chunk.toolResult!.error)}`,
                );
                break;
              case "text":
                console.log(`\n${this.provider}: ${chunk.text}\n`);
                break;
            }
          }
        } catch (err) {
          console.error(`\n  Error: ${errorMessage(err)}\n`);
        }

        ask();
      });
    };

    ask();
  }

  // ── HTTP serve ─────────────────────────────────────────────────────────

  async serve(options?: ServeOptions): Promise<void> {
    const { serveChatAgent } = await import("./chat-agent-http.js");
    return serveChatAgent(this, options);
  }

  // ── State management ───────────────────────────────────────────────────

  /**
   * If a different threadId is requested AND conversation memory is on,
   * replace the journal's model-history projection from the persisted thread
   * and switch the agent to that thread. Without this, options.threadId on
   * chat() and the HTTP /chat endpoint silently did nothing.
   *
   * ChatAgent serializes turns so a detached or slow transport cannot race a
   * second call against the same journal. Create one agent per independently
   * cancellable tenant/session; serialization is an integrity boundary, not a
   * multi-tenant scheduler.
   */
  private switchThreadIfNeeded(requestedThreadId: string | undefined): void {
    if (!requestedThreadId || requestedThreadId === this.threadId) return;
    if (!this.conversationMemory) {
      // With no backing memory there is nothing to rehydrate for the new
      // thread, so it must begin with an empty model projection.
      this.session.switchThread(requestedThreadId, [], "thread_switched");
      this.threadId = requestedThreadId;
      return;
    }
    if (this.currentHistory().length > 0) {
      this.conversationMemory.replaceMessages(this.threadId, this.currentHistory());
    }
    const thread = this.conversationMemory.getThread(requestedThreadId);
    this.session.switchThread(requestedThreadId, [...thread.messages], "thread_switched");
    this.threadId = requestedThreadId;
  }

  getHistory(): ChatMessage[] {
    return this.currentHistory();
  }

  async runVerification(input: CandidateVerificationInput): Promise<CandidateVerificationReceipt> {
    const release = await this.acquireTurn(input.context.signal);
    try {
      return await this.recordVerification(input);
    } finally { release(); }
  }

  private async recordVerification(
    input: CandidateVerificationInput,
    observe?: (receipt: CandidateVerificationReceipt) => void,
  ): Promise<CandidateVerificationReceipt> {
    if (input.context.sessionId !== this.session.sessionId) throw new Error("Verification belongs to another session");
    const receipt = await verifyCandidate({...input, onPrepared: prepared => {
      this.session.append({type: "verification/started", data: {receipt: prepared}});
      observe?.(structuredClone(prepared));
    }});
    this.session.append({type: "verification/recorded", data: {receipt}});
    observe?.(structuredClone(receipt));
    return receipt;
  }

  getSessionEvents() {
    return this.session.getEvents();
  }

  reset(options: { threadId?: string } = {}): void {
    if (this.pendingTurnOperations > 0) {
      throw new Error("Cannot reset while agent work is active; use resetAsync() to queue the reset");
    }
    this.resetNow(options);
  }

  async resetAsync(options: { threadId?: string } = {}): Promise<void> {
    const release = await this.acquireTurn();
    try {
      this.resetNow(options);
    } finally {
      release();
    }
  }

  private resetNow(options: { threadId?: string }): void {
    const priorThreadId = this.threadId;
    const nextThreadId = options.threadId?.trim()
      || this.pinnedThreadId
      || randomUUID();
    if (
      this.conversationMemory
      && nextThreadId !== priorThreadId
      && this.currentHistory().length > 0
    ) {
      this.conversationMemory.replaceMessages(this.threadId, this.currentHistory());
    }
    if (this.conversationMemory) {
      // Projection first closes the crash gap: before the journal reset, the
      // old journal can rebuild this clear; after it, both authorities agree.
      this.conversationMemory.replaceMessages(nextThreadId, []);
    }
    this.session.append({
      type: "session/reset",
      data: { reason: "chat_agent_reset", threadId: nextThreadId },
    });
    this.threadId = nextThreadId;
  }

  async ingestExternalMessage(
    message: ChatContent,
    options: { id: string },
  ): Promise<boolean> {
    const externalId = options.id.trim();
    if (!externalId) throw new Error("External message id must not be empty");
    const correlationId = `external-message:${externalId}`;
    const release = await this.acquireTurn();
    try {
      // Legacy rollout migration must happen before the first mailbox event.
      // Otherwise that event makes the journal look initialized and the prior
      // conversation is silently skipped on the first post-upgrade turn.
      this.ensureSeeded();
      if (this.session.getEvents().some((event) =>
        event.type === "message/appended" && event.correlationId === correlationId
      )) {
        return false;
      }
      this.session.appendMessage(
        { role: "user", content: message },
        { correlationId },
      );
      return true;
    } finally {
      release();
    }
  }

  listThreads(): string[] {
    return this.conversationMemory?.listThreads() ?? [];
  }

  deleteThread(threadId: string): boolean {
    if (this.pendingTurnOperations > 0) {
      throw new Error(
        "Cannot delete a thread while agent work is active; use deleteThreadAsync() to queue the deletion",
      );
    }
    return this.deleteThreadNow(threadId);
  }

  async deleteThreadAsync(threadId: string): Promise<boolean> {
    const release = await this.acquireTurn();
    try {
      return this.deleteThreadNow(threadId);
    } finally {
      release();
    }
  }

  private deleteThreadNow(threadId: string): boolean {
    if (!this.conversationMemory) return false;
    const isActive = threadId === this.threadId;
    const deleted = this.conversationMemory.deleteThread(threadId);
    if (!deleted && !isActive) return false;
    // Delete the compatibility projection before committing the authoritative
    // reset. A crash before reset leaves the old journal able to rebuild it.
    if (isActive) {
      const nextThreadId = this.pinnedThreadId ?? randomUUID();
      this.session.append({
        type: "session/reset",
        data: { reason: "active_thread_deleted", threadId: nextThreadId },
      });
      this.threadId = nextThreadId;
    }
    return true;
  }

  private async disconnectProviders(): Promise<void> {
    // Withdraw the tools before disconnecting, so nothing can dispatch into
    // a provider that is shutting down.
    for (const registration of this.providerRegistrations) {
      registration.dispose();
    }
    this.providerRegistrations = [];
    for (const provider of this.connectedProviders) {
      try {
        await provider.disconnect?.();
      } catch {
        // Best-effort cleanup
      }
    }
    this.connectedProviders = [];
  }

  async close(): Promise<void> {
    const release = await this.acquireTurn();
    try {
      this.stopSpillCollection();
      await this.disconnectProviders();
    } finally {
      release();
    }
  }

  async destroy(): Promise<void> {
    const release = await this.acquireTurn();
    try {
      this.stopSpillCollection();
      await this.disconnectProviders();
      if (this.session.getEvents().at(-1)?.type !== "session/destroyed") {
        this.session.append({
          type: "session/destroyed",
          data: { reason: "chat_agent_destroyed" },
        });
      }
      if (this.toolOutput?.spillDir !== undefined) {
        if (!cleanupToolOutputSpillSession(this.toolOutput.spillDir)) {
          throw new Error("Failed to remove the session tool-output spill directory safely");
        }
        this.protectedSpillRefs.clear();
      }
    } finally {
      release();
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

interface CreateRunManifestInput extends RunContext {
  actor: RunRecord["manifest"]["actor"];
  adapter: AIAdapter;
  instructions: string;
  tools: ReturnType<ToolRegistry["getAll"]>;
  maxRounds: number;
  maxParallelTools: number;
  toolOutput?: ToolOutputConfig;
}

function createRunManifest(input: CreateRunManifestInput): RunRecord {
  const spillPolicy = resolveToolOutputSpillPolicy(input.toolOutput?.spillPolicy);
  const tools = input.tools
    .map((tool) => ({
      name: tool.name,
      definitionDigest: digestJson({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        tags: tool.tags ?? [],
      }),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    manifest: {
      schemaVersion: RUN_SCHEMA_VERSION,
      runId: input.runId ?? randomUUID(),
      ...(input.taskId && { taskId: input.taskId }),
      ...(input.workItemId && { workItemId: input.workItemId }),
      ...(input.parentRunId && { parentRunId: input.parentRunId }),
      correlationId: input.correlationId ?? randomUUID(),
      attempt: input.attempt ?? 1,
      actor: input.actor,
      model: { provider: input.adapter.name, model: input.adapter.model },
      instructionsDigest: digestJson(input.instructions),
      capabilities: {
        digest: digestJson(tools),
        tools,
      },
      authorityGrantRefs: [...(input.authorityGrantRefs ?? [])],
      ...(input.authorizationContextId && {
        authorizationContextId: input.authorizationContextId,
      }),
      limits: { maxRounds: input.maxRounds },
      execution: {
        scheduling: {
          policyVersion: RUN_TOOL_SCHEDULING_POLICY_VERSION,
          maxParallelTools: input.maxParallelTools,
          failClosedMode: "exclusive",
        },
        output: {
          policyVersion: RUN_TOOL_OUTPUT_POLICY_VERSION,
          maxBytes: input.toolOutput?.maxBytes ?? DEFAULT_TOOL_OUTPUT_MAX_BYTES,
          maxLines: input.toolOutput?.maxLines ?? DEFAULT_TOOL_OUTPUT_MAX_LINES,
          spill: {
            enabled: input.toolOutput?.spillDir !== undefined,
            ...spillPolicy,
          },
        },
      },
    },
    status: "running",
    startedAt: new Date().toISOString(),
  };
}

function createOutcomeClaim(run: RunRecord, output: string): OutcomeClaim {
  if (run.status !== "completed") {
    throw new Error(
      `Cannot claim an outcome from run "${run.manifest.runId}" with status ${run.status}.`,
    );
  }
  return {
    claimId: randomUUID(),
    runId: run.manifest.runId,
    ...(run.manifest.taskId && { taskId: run.manifest.taskId }),
    claimedAt: new Date().toISOString(),
    output,
    artifacts: [],
    stateChanges: [],
    warnings: [],
    nextActions: [],
  };
}

function attachToolEffects(
  run: RunRecord,
  toolCalls: ChatResult["toolCalls"],
  trackedReceipts: RunToolEffectReceipt[] = [],
): RunRecord {
  // Both normal completion and exhausting the configured round budget are
  // durable terminal outcomes. Their run evidence is safe to retain, but it
  // must not copy arbitrary tool args/data into the long-lived run record.
  // Failed/cancelled turns remain partial because recovery still needs their
  // minimum effect payload to decide whether a retry is safe.
  const terminalEvidence = run.status === "completed" || run.status === "limit_reached";
  const receipts = trackedReceipts.length > 0
    ? trackedReceipts.map((receipt) => ({
        callId: receipt.callId,
        name: receipt.name,
        executionMode: receipt.executionMode,
        ...(terminalEvidence || receipt.args === undefined ? {} : { args: { ...receipt.args } }),
        result: terminalEvidence
          ? {
              success: receipt.result.success,
              ...(receipt.result.executionOutcome === undefined
                ? {}
                : { executionOutcome: receipt.result.executionOutcome }),
              ...(receipt.result.error === undefined
                ? {}
                : { error: bytePrefix(receipt.result.error, 2048) }),
            }
          : { ...receipt.result },
      }))
    : toolCalls.map((call) => ({
        callId: call.callId,
        name: call.name,
        executionMode: call.executionMode,
        ...(terminalEvidence ? {} : { args: { ...call.args } }),
        result: terminalEvidence
          ? {
              success: call.result.success,
              ...(call.result.executionOutcome === undefined
                ? {}
                : { executionOutcome: call.result.executionOutcome }),
              ...(call.result.error === undefined
                ? {}
                : { error: bytePrefix(call.result.error, 2048) }),
            }
          : { ...call.result },
      }));
  if (receipts.length === 0) return run;
  const certainty = receipts.some(
    (receipt) => receipt.result.executionOutcome === "unknown",
  ) ? "unknown" as const : "known" as const;
  return {
    ...run,
    toolEffects: {
      state: terminalEvidence ? "complete" : "partial",
      certainty,
      receipts,
      ...(certainty === "unknown"
        ? { verificationRequired: "verify tool side effects before deciding whether any retry is safe" }
        : {}),
    },
  };
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

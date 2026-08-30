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
import type {
  AdapterResponse,
  AdapterSessionState,
  ChatContent,
  ChatMessage,
  ToolCall,
} from "./adapters/types.js";
import { validatedAdapterToolCalls } from "./adapters/types.js";
import { chatContentToText } from "./adapters/content.js";
import type { AIAdapter } from "./adapters/types.js";
import { ToolRegistry } from "./registry.js";
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
} from "./compaction.js";
import { appendTurn, loadHistory, persistEnabled, rolloutPathForThread } from "./rollout.js";
import type { ConnectedProvider } from "./context.js";
import { connectProvider, contextPrompt } from "./context.js";
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
  ServeOptions,
  MemoryConfig,
} from "./chat-agent-types.js";
import {
  RUN_SCHEMA_VERSION,
  RunExecutionError,
} from "./chat-agent-types.js";
import { digestJson, SessionKernel } from "./session.js";
import type { SessionEventContext } from "./session.js";
import { classifyToolCall, runToolBatch } from "./tool-scheduler.js";
import {
  boundToolOutput,
  bytePrefix,
  MIN_TOOL_OUTPUT_MAX_BYTES,
  MIN_TOOL_OUTPUT_MAX_LINES,
} from "./tool-output.js";
import type { ToolOutputConfig } from "./tool-output.js";
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
  // Track which tool names each provider added so destroy() can clean
  // them out of the registry. Without this, long-lived processes that
  // create and destroy agents accumulate ghost tools.
  const providerToolNames: string[] = [];
  let contextBlock: string | undefined;

  if (config.providers && config.providers.length > 0) {
    const resolved = await resolveContextProviders(config.providers);
    for (const provider of resolved) {
      try {
        const before = new Set(agentRegistry.listNames());
        const connected = await connectProvider(provider, agentRegistry);
        connectedProviders.push(connected);
        for (const name of agentRegistry.listNames()) {
          if (!before.has(name)) providerToolNames.push(name);
        }
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

    return new ChatAgentImpl({
      name: config.name ?? "agent",
      adapter,
      registry: agentRegistry,
      systemPrompt,
      conversationMemory,
      factMemory,
      connectedProviders,
      providerToolNames,
      threadId,
      threadIdExplicit,
      maxToolRounds: config.maxToolRounds ?? 10,
      maxParallelTools: config.maxParallelTools ?? 4,
      toolOutput: config.toolOutput,
      persistKey: config.persistKey,
      session: config.session,
    });
  } catch (error) {
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

interface ChatAgentInternals {
  name: string;
  adapter: AIAdapter;
  registry: ToolRegistry;
  systemPrompt: string;
  conversationMemory?: ConversationMemory;
  factMemory?: FactMemory;
  connectedProviders: ConnectedProvider[];
  providerToolNames: string[];
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
  private registry: ToolRegistry;
  private systemPrompt: string;
  private conversationMemory?: ConversationMemory;
  private factMemory?: FactMemory;
  private connectedProviders: ConnectedProvider[];
  private providerToolNames: string[];
  private threadId: string;
  private pinnedThreadId?: string;
  private maxToolRounds: number;
  private maxParallelTools: number;
  private toolOutput?: ToolOutputConfig;
  private session: SessionKernel;
  private turnTail: Promise<void> = Promise.resolve();
  private pendingTurnOperations = 0;
  private rolloutPath?: string;
  private writeLegacyRollout = true;
  private seeded = false;

  constructor(internals: ChatAgentInternals) {
    this.name = internals.name;
    this.adapter = internals.adapter;
    this.registry = internals.registry;
    this.systemPrompt = internals.systemPrompt;
    this.conversationMemory = internals.conversationMemory;
    this.factMemory = internals.factMemory;
    this.connectedProviders = internals.connectedProviders;
    this.providerToolNames = internals.providerToolNames;
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

    const plan = planCompaction(toPlanMessages(history), {
      ...buildCompactionConfig(this.model),
      force,
    });
    if (!plan) return unchanged("native thread engine unavailable — rebuild with scripts/build-native.sh");
    if (!plan.needsCompaction) return unchanged("already within the context budget");

    let summaryText: string | null = null;
    const summarizeEnd = plan.summarizeRange[1];
    if (summarizeEnd > 0) {
      const transcript = buildSummarizeTranscript(history, summarizeEnd);
      try {
        throwIfAborted(signal);
        const resp = await this.adapter.chat([{ role: "user", content: `${COMPACTION_SUMMARY_INSTRUCTION}\n\n<conversation>\n${transcript}\n</conversation>` }], new ToolRegistry(), {
          systemPrompt: COMPACTION_SUMMARY_SYSTEM,
          oneShot: true,
          ...(signal === undefined ? {} : { signal }),
        });
        throwIfAborted(signal);
        summaryText = resp.text?.trim() || null;
      } catch (error) {
        if (isAbortInterruption(error, signal)) throw error;
        summaryText = null; // fall back to prune-only
      }
    }

    throwIfAborted(signal);
    const compacted = applyCompactionPlan(history, plan, summaryText);
    this.session.replaceHistoryAndClearAdapterStates(compacted, "compaction_applied");
    return {
      ran: true,
      beforeTokens: before,
      afterTokens: estimateHistoryTokens(compacted),
      prunedMessages: plan.prune.length,
      summarized: summaryText != null && summarizeEnd > 0,
    };
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

  private modelToolSnapshot() {
    return this.registry.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      tags: tool.tags ?? [],
    }));
  }

  private recordModelRequest(
    messages: ChatMessage[],
    systemPrompt: string,
    toolSnapshot: Array<{ name: string }>,
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
        tools: {
          names: toolSnapshot.map((tool) => tool.name).sort(),
          sha256: digestJson(toolSnapshot),
        },
        options,
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
    const response = await this.adapter.chat(messages, registry, {
      systemPrompt,
      ...(signal === undefined ? {} : { signal }),
      ...(projectedState === undefined ? {} : { sessionState: { ...projectedState } }),
    });
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
    context: SessionEventContext,
    rememberEffect: (
      call: ToolCall,
      result: RunToolEffectReceipt["result"],
      context: SessionEventContext,
    ) => void,
  ): Promise<{
    result: Awaited<ReturnType<ToolRegistry["execute"]>>;
    modelContent: string;
  }> {
    this.session.append({ type: "tool/call", data: { call }, ...context });
    this.session.append({ type: "tool/execution-started", data: { call }, ...context });
    rememberEffect(call, {
      success: false,
      error: "Tool execution started without a durable result receipt",
      executionOutcome: "unknown",
    }, context);

    let result: Awaited<ReturnType<ToolRegistry["execute"]>>;
    try {
      result = await this.registry.execute(call.name, call.args);
    } catch (error) {
      return this.recordUncertainToolResult(call, error, context, rememberEffect);
    }

    const execution = normalizeToolResult(call.name, result);
    const normalizedResult = sanitizeToolResult(execution.result);
    // Every result crosses ONE output boundary: identical under the caps,
    // head+tail preview (with a spill ref when configured) over them. The
    // bounded string is what the model, history, and journal all see.
    const bounded = boundToolOutput(JSON.stringify(normalizedResult), this.toolOutput, call.id);
    const modelContent = bounded.content;
    const executionOutcome = execution.outcome;
    const normalizedRecord = normalizedResult as unknown as Record<string, unknown>;
    rememberEffect(call, {
      success: normalizedResult.success,
      ...(Object.prototype.hasOwnProperty.call(normalizedRecord, "data")
        ? { data: normalizedRecord.data }
        : {}),
      ...(normalizedResult.error === undefined ? {} : { error: normalizedResult.error }),
      executionOutcome,
    }, context);

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
  private declareCancelledToolCall(call: ToolCall, context: SessionEventContext): void {
    this.session.append({ type: "tool/call", data: { call }, ...context });
  }

  /**
   * Close a started execution even when the executor pipeline itself fails.
   * The underlying side effect may have happened, so this is deliberately an
   * unknown outcome rather than a synthetic failed tool result.
   */
  private recordUncertainToolResult(
    call: ToolCall,
    error: unknown,
    context: SessionEventContext,
    rememberEffect: (
      call: ToolCall,
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
    rememberEffect(call, result, context);
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
    const release = await this.acquireTurn(options?.signal);
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
      });
      const baseContext = this.eventContext(run);
      const historyBefore = this.currentHistory();
      const adapterStateBefore = this.snapshotAdapterSessionState();
      const userMessage: ChatMessage = { role: "user", content: message };
      const toolCalls: ChatResult["toolCalls"] = [];
      const effectReceipts = new Map<string, RunToolEffectReceipt>();
      const effectReceiptKey = (
        stepId: string | undefined,
        callId: string,
      ): string => `${stepId ?? ""}\0${callId}`;
      const rememberEffect = (
        call: ToolCall,
        result: RunToolEffectReceipt["result"],
        context: SessionEventContext,
      ): void => {
        effectReceipts.set(effectReceiptKey(context.stepId, call.id), {
          name: call.name,
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
      let assistantTurnComplete = false;
      let activeStepId: string | undefined;
      let turnStarted = false;
      let terminalRecorded = false;
      let interruptionReason: string | undefined;
      let toolExecutionStarted = false;
      let journalRecoveryRequired = false;
      let effectHistoryCheckpoint: ChatMessage[] | undefined;
      let effectStateCheckpoint: AdapterSessionState | undefined;
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

      try {
        this.session.append({
          type: "turn/started",
          data: { input: userMessage },
          ...baseContext,
        });
        turnStarted = true;
        this.session.appendMessage(userMessage, baseContext);
        throwIfAborted(options?.signal);

        while (maxRounds-- > 0) {
          throwIfAborted(options?.signal);
          rounds += 1;
          const nextStepId = randomUUID();
          const stepContext = this.eventContext(run, nextStepId);
          this.session.append({
            type: "step/started",
            data: { index: rounds - 1 },
            ...stepContext,
          });
          activeStepId = nextStepId;
          const requestMessages = this.currentHistory();
          const toolSnapshot = this.modelToolSnapshot();
          this.recordModelRequest(
            requestMessages,
            prompt,
            toolSnapshot,
            { toolChoice: "auto" },
            stepContext,
          );
          const stepAdapterStateBefore = this.snapshotAdapterSessionState();
          const response = await this.callAdapter(
            requestMessages,
            this.registry,
            prompt,
            stepContext,
            options?.signal,
          );
          throwIfAborted(options?.signal);

          const calls = validatedAdapterToolCalls(response);
          if (response.text && calls.length > 0) {
            yield { type: "text", text: response.text };
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
            // Bounded admission: parallel-safe calls share a capped pool,
            // exclusive calls (the fail-closed default) run alone as
            // barriers. Abort stops admissions — started calls drain, and a
            // never-started call is only DECLARED (tool/call event): the
            // kernel's interruption repair closes it with a definitive
            // failed/not-started receipt when the aborted turn ends.
            const batchOutcomes = await runToolBatch(calls, {
              mode: (call) => classifyToolCall(this.registry.get(call.name), call.args),
              execute: (call) => this.executeTool(call, stepContext, rememberEffect),
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
                this.declareCancelledToolCall(calls[index], stepContext);
                executions.push(null);
              } else {
                executions.push(outcome.value);
              }
            }
            const resultChunks: ChatStreamChunk[] = [];
            let uncertainExecution = false;
            for (let index = 0; index < calls.length; index += 1) {
              const call = calls[index];
              const execution = executions[index];
              // Cancelled-before-start: declared above, closed by the
              // kernel's interruption repair — no message or chunk here.
              if (execution === null) continue;
              this.session.appendMessage({
                role: "tool",
                content: execution.modelContent,
                toolCallId: call.id,
                toolName: call.name,
              }, stepContext);
              toolCalls.push({
                name: call.name,
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
            journalRecoveryRequired = batchOutcomes.some(
              (outcome) => outcome.status === "cancelled",
            );
            // Journal every result before yielding any result chunk. A stream
            // consumer may close at a yield boundary, but completed effects
            // must still have model-facing receipts in call order.
            for (const chunk of resultChunks) {
              yield chunk;
              throwIfAborted(options?.signal);
            }
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
            continue;
          }

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
            assistantTurnComplete = true;
            yield { type: "text", text: response.text };
            throwIfAborted(options?.signal);
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
          break;
        }

        if (!finalText && maxRounds < 0) {
          const finalizerStepId = randomUUID();
          const finalizerContext = this.eventContext(run, finalizerStepId);
          const finalizerPrompt = this.exhaustedToolRoundSystemPrompt(options?.systemPrompt);
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
            assistantTurnComplete = true;
            yield { type: "text", text: finalText };
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
        if (completedRun.status === "limit_reached") {
          completedRun = attachToolEffects(
            completedRun,
            toolCalls,
            [...effectReceipts.values()],
          );
        }
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
        if (journalRecoveryRequired) {
          markUndurableEffectsUnknown(error);
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
        }
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
    for (const provider of this.connectedProviders) {
      try {
        await provider.disconnect?.();
      } catch {
        // Best-effort cleanup
      }
    }
    for (const name of this.providerToolNames) {
      this.registry.unregister(name);
    }
    this.providerToolNames = [];
    this.connectedProviders = [];
  }

  async close(): Promise<void> {
    const release = await this.acquireTurn();
    try {
      await this.disconnectProviders();
    } finally {
      release();
    }
  }

  async destroy(): Promise<void> {
    const release = await this.acquireTurn();
    try {
      await this.disconnectProviders();
      if (this.session.getEvents().at(-1)?.type !== "session/destroyed") {
        this.session.append({
          type: "session/destroyed",
          data: { reason: "chat_agent_destroyed" },
        });
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
}

function createRunManifest(input: CreateRunManifestInput): RunRecord {
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
    },
    status: "running",
    startedAt: new Date().toISOString(),
  };
}

function requireRunning(run: RunRecord): void {
  if (run.status !== "running") {
    throw new Error(
      `Run "${run.manifest.runId}" is already terminal (${run.status}).`,
    );
  }
}

function completeRun(
  run: RunRecord,
  options: { limitReached?: boolean } = {},
): RunRecord {
  requireRunning(run);
  return {
    ...run,
    status: options.limitReached ? "limit_reached" : "completed",
    completedAt: new Date().toISOString(),
    stopReason: options.limitReached ? "max_rounds" : "model_response",
  };
}

function failRun(run: RunRecord, error: unknown): RunRecord {
  requireRunning(run);
  const normalized = error instanceof Error
    ? { name: redactSensitiveText(error.name), message: errorMessage(error) }
    : { name: "Error", message: errorMessage(error) };
  return {
    ...run,
    status: "failed",
    completedAt: new Date().toISOString(),
    stopReason: "error",
    error: normalized,
  };
}

function cancelRun(
  run: RunRecord,
  cancellation: NonNullable<RunRecord["cancellation"]>,
): RunRecord {
  requireRunning(run);
  return {
    ...run,
    status: "cancelled",
    completedAt: new Date().toISOString(),
    stopReason: "cancelled",
    cancellation: { ...cancellation },
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
  const receipts = trackedReceipts.length > 0
    ? trackedReceipts.map((receipt) => ({
        name: receipt.name,
        args: { ...receipt.args },
        result: { ...receipt.result },
      }))
    : toolCalls.map((call) => ({
        name: call.name,
        args: { ...call.args },
        result: { ...call.result },
      }));
  if (receipts.length === 0) return run;
  const certainty = receipts.some(
    (receipt) => receipt.result.executionOutcome === "unknown",
  ) ? "unknown" as const : "known" as const;
  return {
    ...run,
    toolEffects: {
      state: "partial",
      certainty,
      receipts,
      ...(certainty === "unknown"
        ? { verificationRequired: "verify tool side effects before deciding whether any retry is safe" }
        : {}),
    },
  };
}

function errorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(abortedTurnReason(signal));
  error.name = "AbortError";
  return error;
}

function waitForTurn(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return previous;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function isAbortInterruption(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function abortedTurnReason(signal: AbortSignal): string {
  if (signal.reason instanceof Error && signal.reason.message) {
    return `chat turn aborted: ${signal.reason.message}`;
  }
  if (typeof signal.reason === "string" && signal.reason.trim()) {
    return `chat turn aborted: ${signal.reason}`;
  }
  return "chat turn aborted";
}

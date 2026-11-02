import type { NoninteractiveSettlement } from "./settlement";
import type {CandidateVerificationReceipt, CandidateVerificationInput} from '../../candidateVerification';
/**
 * ChatAgent — Type Definitions
 *
 * All types for the composable ChatAgent system.
 * The ChatAgent composes tools, memory, context providers, and AI adapters
 * into a single configurable, embeddable agent.
 */

import type { ToolDefinition } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import type { ContextProvider } from "./context.js";
import type { PromptOptions } from "./prompts.js";
import type { AIAdapter, AdapterConfig, AdapterEvent, ProviderReceipt, ChatContent, ChatMessage, ReasoningEffort } from "./adapters/types.js";
import type { Store } from "./store.js";
import type { SessionEvent, SessionEventStore } from "./session.js";
import type { ToolOutputSpillPolicy } from "./tool-output.js";

import type { ToolExecutionContext } from "./execution-context.js";

// ─── Legible Run Records ──────────────────────────────────────────────────

export const RUN_SCHEMA_VERSION = "siftable.agent-harness.run/1" as const;
export const RUN_TOOL_SCHEDULING_POLICY_VERSION = "siftable.tool-scheduling/1" as const;
export const RUN_TOOL_OUTPUT_POLICY_VERSION = "siftable.tool-output/2" as const;

export type RunToolExecutionMode = "exclusive" | "parallel-safe";

export type RunStatus =
  | "running"
  | "completed"
  | "limit_reached"
  | "failed"
  | "cancelled";

export interface RunToolEffectReceipt {
  /** Present on receipts produced by current harnesses; absent on legacy records. */
  callId?: string;
  name: string;
  /** Resolved per call after fail-closed classification. */
  executionMode?: RunToolExecutionMode;
  /** Omitted from completed/limit-reached evidence; retained for partial-effect recovery. */
  args?: Record<string, unknown>;
  result: {
    success: boolean;
    data?: unknown;
    error?: string;
    executionOutcome?: "succeeded" | "failed" | "unknown";
  };
}

export interface RunToolEffects {
  /** Complete on completed/limit-reached runs; partial on interrupted/failed runs. */
  state: "complete" | "partial";
  certainty: "known" | "unknown";
  receipts: RunToolEffectReceipt[];
  verificationRequired?: string;
}

export interface RunManifest {
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  runId: string;
  taskId?: string;
  workItemId?: string;
  parentRunId?: string;
  correlationId: string;
  attempt: number;
  actor: { kind: "chat_agent"; name: string };
  model: { provider: string; model: string };
  instructionsDigest: string;
  capabilities: {
    digest: string;
    tools: Array<{ name: string; definitionDigest: string }>;
  };
  authorityGrantRefs: string[];
  authorizationContextId?: string;
  limits: { maxRounds: number };
  /** Effective execution contract. Absent only on legacy schema-v1 records. */
  execution?: {
    scheduling: {
      policyVersion: typeof RUN_TOOL_SCHEDULING_POLICY_VERSION;
      maxParallelTools: number;
      failClosedMode: "exclusive";
    };
    output: {
      policyVersion: typeof RUN_TOOL_OUTPUT_POLICY_VERSION;
      maxBytes: number;
      maxLines: number;
      spill: {
        enabled: boolean;
        maxBytes: number;
        maxFiles: number;
        maxAgeMs: number;
        orphanGraceMs: number;
      };
    };
  };
}

export interface RunRecord {
  manifest: RunManifest;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  stopReason?: "model_response" | "max_rounds" | "error" | "cancelled";
  error?: { name: string; message: string };
  toolEffects?: RunToolEffects;
  cancellation?: {
    effects: "none" | "partial" | "committed";
    reason: string;
    verificationRequired?: string;
  };
}

export interface RunContext {
  runId?: string;
  taskId?: string;
  workItemId?: string;
  parentRunId?: string;
  correlationId?: string;
  attempt?: number;
  authorityGrantRefs?: string[];
  authorizationContextId?: string;
}

export interface OutcomeClaim {
  claimId: string;
  runId: string;
  taskId?: string;
  claimedAt: string;
  output: string;
  artifacts: Array<{ uri: string; digest?: string }>;
  stateChanges: Array<{ resource: string; before?: unknown; after?: unknown }>;
  warnings: string[];
  nextActions: string[];
}

/** Error that keeps the terminal run and partial-effect receipts attached. */
export class RunExecutionError extends Error {
  readonly run: RunRecord;
  readonly toolEffects?: RunToolEffects;

  constructor(message: string, run: RunRecord, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunExecutionError";
    this.run = run;
    this.toolEffects = run.toolEffects;
  }
}

// ─── Memory Config ─────────────────────────────────────────────────────────

export interface MemoryConfig {
  /** Enable conversation memory (default: true) */
  conversation?: boolean;
  /** Enable fact memory (default: true) */
  facts?: boolean;
  /** Thread ID for conversation persistence (auto-generated if omitted) */
  threadId?: string;
  /** Custom store for conversation threads */
  conversationStore?: Store<any>;
  /** Custom store for facts */
  factStore?: Store<any>;
}

// ─── Peer Config (schema-ready for future A2A) ────────────────────────────

export interface PeerConfig {
  /** Peer agent name */
  name: string;
  /** Description of what this peer does (for routing prompts) */
  description: string;
  /** Path to peer's config file */
  config?: string;
  /** URL or reference for future A2A routing */
  endpoint?: string;
  /** Task status trigger (Routa-style state-driven orchestration) */
  trigger?: { taskStatus?: string };
}

// ─── Session Config ────────────────────────────────────────────────────────

/**
 * Event-journal configuration for a chat agent. The journal is always the
 * in-process source of truth for model history; callers can provide a durable
 * store and stable id when the session must survive process restarts.
 */
export interface ChatSessionConfig {
  /** Stable journal id. A new UUID is allocated when omitted. */
  id?: string;

  /** Explicit logical thread identity for durable reopen validation. */
  threadId?: string;

  /** Optional durable or observable event store. Defaults to in-memory. */
  store?: SessionEventStore;

  /** Recover an interrupted prior turn without retrying uncertain tools. */
  recoverInterrupted?: boolean;
}

// ─── Agent Config ──────────────────────────────────────────────────────────

export interface ChatAgentConfig {
  /** Trusted turn-scoped execution settings; never model-supplied arguments. */
  executionContext?: () => Omit<ToolExecutionContext, "sessionId" | "turnId" | "callId" | "signal">;
  /** Explicit transport configuration, kept out of journal envelopes. */
  adapterConfig?: Partial<AdapterConfig>;
  /** Agent name (used in banners and metadata) */
  name?: string;

  /** Load a bundled prompt preset by name (e.g., "study-buddy") */
  preset?: string;

  /** Explicit prompt: inline string, path to .md file, or structured PromptOptions */
  prompt?: string | PromptOptions;

  /** AI provider: "gemini", "openai", "anthropic", "xai", "openrouter" */
  provider?: string;

  /** Model override (e.g., "gemini-3.8-flash", "gpt-6.1-sol", "gpt-5.4-mini") */
  model?: string;

  /**
   * Reasoning effort for models that support it. Forwarded to the adapter,
   * which maps it to the provider-native control (OpenAI/OpenRouter
   * `reasoning.effort`, Anthropic `output_config.effort`).
   */
  reasoningEffort?: ReasoningEffort;

  /**
   * Pre-built adapter. When set, `provider`/`model` are ignored and the
   * built-in adapter resolution is skipped. Useful for tests (mock adapters)
   * or for plugging in a custom AI provider.
   */
  adapter?: AIAdapter;

  /** Explicit tool list or registry (defaults to global registry) */
  tools?: ToolDefinition<any, any>[] | ToolRegistry;

  /** Filter tools by tag (e.g., ["tasks", "calendar"]) */
  toolTags?: string[];

  /** Exclude specific tools by name */
  excludeTools?: string[];

  /** Memory config. Default: ON (conversation + facts). Set false to disable. */
  memory?: boolean | MemoryConfig;

  /** Context providers: string names (e.g., "siftable") or ContextProvider instances */
  providers?: (string | ContextProvider)[];

  /** Max tool-calling rounds per turn (default: 10) */
  maxToolRounds?: number;

  /** Concurrent parallel-safe tool executions per batch (default: 4, min 1). */
  maxParallelTools?: number;

  /**
   * Model-facing tool output bounding: byte/line caps and an optional spill
   * directory that retains the complete output of truncated results.
   */
  toolOutput?: {
    maxBytes?: number;
    maxLines?: number;
    spillDir?: string;
    spillPolicy?: ToolOutputSpillPolicy;
  };

  /** Event-sourced session journal configuration. */
  session?: ChatSessionConfig;

  /**
   * Stable key for the legacy rollout compatibility path. A configured event
   * session is the durable authority and persists independently of compaction.
   */
  persistKey?: string;

  /** Skip agent reasoning — plain tool calling only (saves tokens) */
  raw?: boolean;

  /** Peer agents for future multi-agent routing (schema-ready) */
  peers?: PeerConfig[];

  /** Inherit from another config (phase 2 — YAML config files) */
  extends?: string;
}

// ─── Chat Results ──────────────────────────────────────────────────────────

export interface ChatResult {
  providerReceipts?: ProviderReceipt[];
  /** Last explicitly configured candidate check, independently of run status. */
  verification?: CandidateVerificationReceipt;
  /** Final text response */
  text: string;

  /** Tool calls made during this turn */
  toolCalls: Array<{
    /** Provider call id; absent only on legacy results. */
    callId?: string;
    name: string;
    /** Resolved per-call scheduling mode; absent only on legacy results. */
    executionMode?: RunToolExecutionMode;
    args: Record<string, unknown>;
    result: {
      success: boolean;
      data?: unknown;
      error?: string;
      executionOutcome?: "succeeded" | "failed" | "unknown";
    };
  }>;

  /** Number of LLM rounds consumed */
  rounds: number;

  /** Immutable record of this execution attempt. */
  run: RunRecord;

  /** What a completed run claims it produced. */
  outcome?: OutcomeClaim;

  /** Metadata about the turn */
  metadata: {
    provider: string;
    model: string;
    threadId?: string;
  };
}

export interface ChatStreamChunk {
  /** Event type */
  type: "text" | "tool_call" | "tool_result" | "settlement" | "done";

  /** Incremental text (for type: "text") */
  text?: string;
  /** Already delivered through the provider-event callback. */
  streamed?: boolean;

  /** A noninteractive run withdrew the model's last answer because it asked
   * the absent user to act (for type: "settlement"). `streamed` says whether
   * that answer's deltas already reached the provider-event callback, so a
   * live transcript can mark it as withdrawn instead of presenting it. */
  settlement?: { action: "feedback" | "failed"; cue: string; streamed: boolean };

  /** Tool call info (for type: "tool_call"). `callId` is the provider call id;
   * results carry the same id so parallel same-name calls stay correlated. */
  toolCall?: { name: string; args: Record<string, unknown>; callId?: string };

  /** Tool result (for type: "tool_result") */
  toolResult?: {
    name: string;
    success: boolean;
    data?: unknown;
    error?: string;
    executionOutcome?: "succeeded" | "failed" | "unknown";
    callId?: string;
    /** Bounded, display-safe serialization of the result (what the model saw). */
    outputPreview?: string;
  };

  /** Final result (for type: "done") */
  result?: ChatResult;
}

// ─── Chat Options ──────────────────────────────────────────────────────────

export interface ChatAgentChatOptions {
  /** Headless execution: no person can answer during the turn. A user-directed
   * final answer gets one bounded feedback round, then fails the run (CLI-044). */
  noninteractive?: NoninteractiveSettlement;
  /** Trusted user-supplied check; never an evaluator's held-out grader. */
  completionVerification?: Omit<CandidateVerificationInput, 'context' | 'onPrepared'> & {
    context: Omit<ToolExecutionContext, 'sessionId' | 'turnId' | 'callId' | 'signal'>;
  };
  /** Prepared and settled receipts, emitted only after their journal writes. */
  onVerification?: (receipt: CandidateVerificationReceipt) => void;
  /** Live provider progress; receipt events are also persisted. */
  onProviderEvent?: (event: AdapterEvent) => void;
  /** Enable streaming response (returns AsyncIterable<ChatStreamChunk>) */
  stream?: boolean;

  /** Cancel queued or in-flight harness work at safe execution boundaries. */
  signal?: AbortSignal;

  /**
   * Corrections the user sent while this turn runs. Read before each model
   * step, after the previous step's tool batch has settled, and once more
   * before the turn would end. Each id is appended to history at most once
   * per turn; the caller owns durability and acknowledgement.
   */
  steering?: SteeringSource;

  /** Override system prompt for this turn only */
  systemPrompt?: string;

  /** Override thread ID for this turn */
  threadId?: string;

  /** Optional IDs and grants that bind this turn to larger Siftable work. */
  run?: RunContext;
}

export interface ChatAgentResetOptions {
  /** Stable logical thread identity to retain after clearing history. */
  threadId?: string;
}

export interface SteeringMessage {
  /** Caller-owned id, stable across retries of the same correction. */
  id: string;
  message: string;
}

export interface SteeringSource {
  /** Corrections accepted so far and not yet acknowledged, oldest first. */
  pending(): readonly SteeringMessage[];
  /** Called after the correction is durably appended to this turn's history. */
  onDelivered?(id: string): void;
}

export interface ExternalMessageOptions {
  /** Stable, caller-owned id used to make durable inbox delivery idempotent. */
  id: string;
}

// ─── Serve Options ─────────────────────────────────────────────────────────

export interface ServeOptions {
  /** Port to listen on (default: 3000) */
  port?: number;

  /** Host to bind to (default: "localhost") */
  host?: string;

  /** Enable CORS headers (default: false) */
  cors?: boolean;
}

// ─── ChatAgent Interface ───────────────────────────────────────────────────

export interface ChatAgent {
  /** Agent name */
  readonly name: string;

  /** AI provider name */
  readonly provider: string;

  /** AI model name */
  readonly model: string;

  /** Send a message and get a response */
  chat(message: ChatContent, options?: ChatAgentChatOptions & { stream?: false }): Promise<ChatResult>;

  /** Send a message and stream the response */
  chat(message: ChatContent, options: ChatAgentChatOptions & { stream: true }): AsyncIterable<ChatStreamChunk>;

  /** Send a message (unified signature) */
  chat(message: ChatContent, options?: ChatAgentChatOptions): Promise<ChatResult> | AsyncIterable<ChatStreamChunk>;

  /** Start an interactive CLI session */
  interactive(): Promise<void>;

  /** Start an HTTP server */
  serve(options?: ServeOptions): Promise<void>;

  /** Get current conversation history */
  getHistory(): ChatMessage[];

  /** Immutable execution journal backing the projected model history. */
  getSessionEvents(): readonly SessionEvent[];
  runVerification(input: CandidateVerificationInput): Promise<CandidateVerificationReceipt>;

  /** Clear immediately; throws while agent work is active. */
  reset(options?: ChatAgentResetOptions): void;

  /** Queue a reset behind active agent work. */
  resetAsync(options?: ChatAgentResetOptions): Promise<void>;

  /** Append an externally delivered user message exactly once. */
  ingestExternalMessage(message: ChatContent, options: ExternalMessageOptions): Promise<boolean>;

  /**
   * List all persisted thread IDs known to conversation memory.
   * Returns an empty array when memory is disabled.
   */
  listThreads(): string[];

  /**
   * Delete a persisted thread from conversation memory. Returns true
   * when the thread existed and was removed, false otherwise (or when
   * memory is disabled).
   */
  deleteThread(threadId: string): boolean;

  /** Queue a thread deletion behind active agent work. */
  deleteThreadAsync(threadId: string): Promise<boolean>;

  /**
   * Explicitly compact the conversation now (the TUI's `/compact`). Forces a
   * prune+summarize pass even when still within the context budget and reports
   * what changed. No-ops (ran=false with a reason) when compaction is disabled,
   * the native thread engine is unavailable, or there is nothing to compact.
   */
  compact(options?: { force?: boolean; signal?: AbortSignal }): Promise<CompactionOutcome>;

  /** Release provider resources without making the durable session terminal. */
  close(): Promise<void>;

  /** Shut down — disconnect providers, clean up */
  destroy(): Promise<void>;
}

/** Result of an explicit {@link ChatAgent.compact} call. Token counts are the
 *  thread engine's heuristic estimate, not a billing-accurate BPE count. */
export interface CompactionOutcome {
  /** True when history was actually rewritten (pruned and/or summarized). */
  ran: boolean;
  /** When ran=false, why nothing happened. */
  reason?: string;
  beforeTokens: number;
  afterTokens: number;
  /** Count of messages whose tool output was cleared. */
  prunedMessages: number;
  /** True when an LLM summary replaced the older-turn prefix. */
  summarized: boolean;
}

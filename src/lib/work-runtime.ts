import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {sanitizeTerminalLine, truncate} from './output.js';
import {renderCollaborationEventLine} from './work-collaboration.js';

/*
 * Client side of following and steering a running work item through the Sift
 * API (AGENT-RUNTIME-17). Every call here is an HTTPS request to the Sift API;
 * nothing talks to a T3 socket or port and nothing starts a model process. The
 * only process this module may start is the platform's URL opener, so a person
 * can decide a runtime request in the web app with their own session.
 *
 * The record types mirror packages/shared/src/types/agentWorkRuntimeRequests.ts,
 * agentWorkRuntimeControls.ts, agentWorkExecution.ts and agentWorkCollaboration.ts.
 * The CLI does not depend on the shared package at runtime, so keep these in step.
 */

export const WORK_RUNTIME_OUTPUT_VERSION = 1 as const;

export type RuntimeRequestKind = 'approval' | 'user_input';
export type RuntimeRequestState = 'pending' | 'resolved' | 'expired' | 'superseded';
export type RuntimeRequestDeliveryState = 'pending' | 'delivered' | 'already_resolved' | 'failed' | 'unconfirmed';
export type RuntimeControlKind = 'instruction' | 'interrupt';
export type RuntimeControlState =
  | 'queued' | 'dispatching' | 'delivered' | 'acknowledged' | 'cancelled' | 'failed' | 'expired' | 'unconfirmed';

export const RUNTIME_INSTRUCTION_MAX_CHARS = 16_000;
export const EVENT_PAGE_LIMIT = 100;
export const MAX_EVENT_WAIT_MS = 30_000;
/** Pages read after an attempt ends before the watch stops (100 events each). */
export const MAX_DRAIN_PAGES = 100;

export interface RuntimeQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{label: string; description: string; value?: string}>;
  optionsOmitted?: number;
  allowCustomAnswer?: boolean;
  multiSelect?: boolean;
}

export interface RuntimeRequest {
  id: string;
  workItemId: string;
  attemptId: string;
  runtimeId: string;
  leaseGeneration: number;
  providerRequestId: string;
  kind: RuntimeRequestKind;
  blocking: boolean;
  category: string | null;
  summary: string;
  detail: {text?: string; questions?: RuntimeQuestion[]} | null;
  state: RuntimeRequestState;
  resolution: {decision: string} | {answers: Record<string, string | string[]>} | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  closeReason: string | null;
  closedAt: string | null;
  externalDecision: string | null;
  deliveryState: RuntimeRequestDeliveryState;
  deliveryAttempts: number;
  deliveredAt: string | null;
  deliveryError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeControl {
  id: string;
  workItemId: string;
  attemptId: string;
  runtimeId: string;
  leaseGeneration: number;
  kind: RuntimeControlKind;
  instruction: string | null;
  ordinal: number;
  state: RuntimeControlState;
  failureReason: string | null;
  requestedBy: string | null;
  cancelledBy: string | null;
  dispatchedAt: string | null;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeControlResult {
  version: 1;
  applied: boolean;
  control: RuntimeControl;
}

export interface ExecutionAttempt {
  id: string;
  runtimeId: string;
  leaseGeneration: number;
  claimOwner: string;
  host: string | null;
  model: string | null;
  harness: string | null;
  state: 'starting' | 'running' | 'interrupted' | 'ended' | 'superseded';
  endReason: string | null;
  startedAt: string;
  runningAt: string | null;
  endedAt: string | null;
  updatedAt: string;
  [key: string]: unknown;
}

export interface WorkExecution {
  version: 1;
  workspace: Record<string, unknown> | null;
  currentAttempt: ExecutionAttempt | null;
  currentLeaseActive: boolean;
  attempts: ExecutionAttempt[];
}

export interface LedgerEvent {
  id: string;
  workItemId: string;
  sequence: number;
  kind: string;
  [key: string]: unknown;
}

export interface LedgerPage {
  events: LedgerEvent[];
  nextSequence: number | null;
  timedOut?: boolean;
}

// ---------------------------------------------------------------------------
// Transport

export interface RuntimeApiContext {
  apiUrl: string;
  token: string;
  workspaceId?: string;
}

/** A failed call keeps the HTTP status (0 for a transport failure) and the raw error body. */
export type ApiResult<T> =
  | {ok: true; status: number; body: T}
  | {ok: false; status: number; error: string};

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || (error as {code?: unknown}).code === 'ABORT_ERR');
}

export class WorkRuntimeApi {
  constructor(private readonly context: RuntimeApiContext) {}

  get apiUrl(): string {
    return this.context.apiUrl;
  }

  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: {query?: Record<string, string | number | undefined>; body?: unknown; idempotencyKey?: string; signal?: AbortSignal} = {},
  ): Promise<ApiResult<T>> {
    const url = new URL(`${this.context.apiUrl.replace(/\/+$/, '')}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.context.token}`,
      Accept: 'application/json',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    if (this.context.workspaceId) headers['X-Workspace-Id'] = this.context.workspaceId;
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        signal: options.signal,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw error;
      return {ok: false, status: 0, error: JSON.stringify({error: `Request failed: ${error instanceof Error ? error.message : String(error)}`})};
    }
    // A connection that drops while the body streams is a transport failure
    // too: the server may have applied the request, so the caller retries with
    // the same Idempotency-Key and receives the stored result.
    try {
      if (!response.ok) return {ok: false, status: response.status, error: await response.text()};
      return {ok: true, status: response.status, body: (await response.json()) as T};
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw error;
      return {ok: false, status: 0, error: JSON.stringify({error: `Response could not be read: ${error instanceof Error ? error.message : String(error)}`})};
    }
  }

  private workPath(workItemId: string, suffix: string): string {
    return `/api/v1/work-items/${encodeURIComponent(workItemId)}${suffix}`;
  }

  getExecution(workItemId: string, signal?: AbortSignal): Promise<ApiResult<WorkExecution>> {
    return this.request('GET', this.workPath(workItemId, '/execution'), {signal});
  }

  listRequests(workItemId: string, options: {open?: boolean; signal?: AbortSignal} = {}): Promise<ApiResult<{version: 1; requests: RuntimeRequest[]}>> {
    return this.request('GET', this.workPath(workItemId, '/runtime-requests'), {
      query: {open: options.open ? 'true' : undefined},
      signal: options.signal,
    });
  }

  /** One request by ID with its true stored state; not limited by the list cap. */
  getRequest(workItemId: string, requestId: string, signal?: AbortSignal): Promise<ApiResult<{version: 1; request: RuntimeRequest}>> {
    return this.request('GET', this.workPath(workItemId, `/runtime-requests/${encodeURIComponent(requestId)}`), {signal});
  }

  /**
   * Pending requests and all known requests. The general list is capped and
   * newest first, so an older pending request is read from `?open=true`.
   */
  async listRequestsWithOpen(workItemId: string, signal?: AbortSignal): Promise<ApiResult<{open: RuntimeRequest[]; all: RuntimeRequest[]}>> {
    const [open, all] = await Promise.all([
      this.listRequests(workItemId, {open: true, signal}),
      this.listRequests(workItemId, {signal}),
    ]);
    if (!open.ok) return open;
    if (!all.ok) return all;
    const merged = new Map<string, RuntimeRequest>();
    for (const request of all.body.requests) merged.set(request.id, request);
    for (const request of open.body.requests) merged.set(request.id, request);
    const byNewest = [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {ok: true, status: 200, body: {open: open.body.requests, all: byNewest}};
  }

  listControls(workItemId: string, signal?: AbortSignal): Promise<ApiResult<{version: 1; controls: RuntimeControl[]; truncated: boolean}>> {
    return this.request('GET', this.workPath(workItemId, '/runtime-controls'), {signal});
  }

  /** Reads the ledger after an explicit sequence; never reads or advances a durable consumer cursor. */
  listEvents(workItemId: string, afterSequence: number, limit = EVENT_PAGE_LIMIT, signal?: AbortSignal): Promise<ApiResult<LedgerPage>> {
    return this.request('GET', this.workPath(workItemId, '/events'), {query: {afterSequence, limit}, signal});
  }

  /** Long-polls the ledger after an explicit sequence; never reads or advances a durable consumer cursor. */
  waitEvents(workItemId: string, afterSequence: number, waitMs: number, signal?: AbortSignal): Promise<ApiResult<LedgerPage>> {
    return this.request('GET', this.workPath(workItemId, '/events/wait'), {
      query: {afterSequence, waitMs, limit: EVENT_PAGE_LIMIT},
      signal,
    });
  }

  sendControl(
    workItemId: string,
    input: {kind: 'instruction'; instruction: string} | {kind: 'interrupt'},
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<RuntimeControlResult>> {
    return this.request('POST', this.workPath(workItemId, '/runtime-controls'), {body: input, idempotencyKey, signal});
  }
}

// ---------------------------------------------------------------------------
// Runtime controls: send with a stable Idempotency-Key

/** Transport failures, 408, 429 and every 5xx may be retried with the same key. */
export type ControlUnconfirmedCause = 'signal' | 'timeout' | 'transport' | 'http';

/**
 * True when a failed control POST may still have been stored: no readable
 * response, a timeout or server error, or a 4xx without a parseable refusal.
 * Only a 4xx with a JSON error body is a definite refusal.
 */
export function isAmbiguousControlFailure(failure: {status: number; error: string}): boolean {
  if (failure.status === 0 || failure.status === 408 || failure.status >= 500) return true;
  if (failure.status >= 400 && failure.status < 500) {
    try {
      const parsed = JSON.parse(failure.error) as unknown;
      return parsed === null || typeof parsed !== 'object';
    } catch {
      return true;
    }
  }
  return true;
}

export function isRetryableControlStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || (status >= 500 && status <= 599);
}
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function newControlIdempotencyKey(kind: RuntimeControlKind): string {
  return `cli-${kind}-${randomUUID()}`;
}

export function normalizeControlIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!IDEMPOTENCY_KEY.test(normalized)) {
    throw new Error('Idempotency key must be 1-128 letters, numbers, dots, colons, underscores, or hyphens, starting with a letter or number.');
  }
  return normalized;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Aborted'), {name: 'AbortError'}));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), {name: 'AbortError'}));
    };
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

/**
 * Posts one control. The key is generated once by the caller and reused for
 * every retry, so a retry after a lost response returns the stored control
 * (`applied: false`) instead of queueing a second instruction.
 */
export async function sendControlWithRetry(
  api: WorkRuntimeApi,
  workItemId: string,
  input: {kind: 'instruction'; instruction: string} | {kind: 'interrupt'},
  options: {idempotencyKey: string; retries: number; retryDelayMs: number; signal?: AbortSignal},
): Promise<{
  result: ApiResult<RuntimeControlResult>;
  requestAttempts: number;
  /**
   * The first failed attempt that may have been stored, if any. Once set, only
   * a success confirms the outcome: a later definite refusal (for example a
   * 429 or 409 on a retry) does not prove the earlier attempt was not queued.
   */
  ambiguousFailure: {status: number; error: string} | null;
}> {
  let requestAttempts = 0;
  let ambiguousFailure: {status: number; error: string} | null = null;
  for (;;) {
    requestAttempts += 1;
    const result = await api.sendControl(workItemId, input, options.idempotencyKey, options.signal);
    if (!result.ok && !ambiguousFailure && isAmbiguousControlFailure(result)) {
      ambiguousFailure = {status: result.status, error: result.error};
    }
    if (result.ok || !isRetryableControlStatus(result.status) || requestAttempts > options.retries) {
      return {result, requestAttempts, ambiguousFailure};
    }
    await sleep(options.retryDelayMs * 2 ** (requestAttempts - 1), options.signal);
  }
}

const INSTRUCTION_SETTLED: ReadonlySet<RuntimeControlState> = new Set(['delivered', 'cancelled', 'failed', 'expired', 'unconfirmed']);
const INTERRUPT_SETTLED: ReadonlySet<RuntimeControlState> = new Set(['acknowledged', 'cancelled', 'failed', 'expired', 'unconfirmed']);

export function isControlSettled(control: Pick<RuntimeControl, 'kind' | 'state'>): boolean {
  return (control.kind === 'interrupt' ? INTERRUPT_SETTLED : INSTRUCTION_SETTLED).has(control.state);
}

/** True only for the state the server records when T3 accepted the control. */
export function isControlSuccess(control: Pick<RuntimeControl, 'kind' | 'state'>): boolean {
  return control.kind === 'interrupt' ? control.state === 'acknowledged' : control.state === 'delivered';
}

/** Describes only what the server has recorded; never infers delivery or acknowledgement. */
export function describeControlState(control: Pick<RuntimeControl, 'kind' | 'state' | 'failureReason' | 'ordinal'>): string {
  const noun = control.kind === 'interrupt' ? 'Interrupt' : 'Instruction';
  const reason = control.failureReason ? ` (${sanitizeTerminalLine(control.failureReason)})` : '';
  switch (control.state) {
    case 'queued':
      return control.kind === 'interrupt'
        ? 'Interrupt requested; the agent has not acknowledged it yet.'
        : `Instruction queued at position ${control.ordinal}; not delivered yet. It runs after the current turn settles.`;
    case 'dispatching':
      return `${noun} is being dispatched; delivery is not confirmed yet.`;
    case 'delivered':
      return 'Delivered: the agent accepted the instruction as its next turn.';
    case 'acknowledged':
      return 'Acknowledged: the agent accepted the interrupt.';
    case 'cancelled':
      return `${noun} was cancelled before dispatch.`;
    case 'failed':
      return `${noun} failed${reason}.`;
    case 'expired':
      return `${noun} expired${reason}; the attempt ended before it was dispatched.`;
    case 'unconfirmed':
      return `${noun} is unconfirmed: the attempt ended during dispatch, so the agent may or may not have received it.`;
    default:
      return `${noun} state: ${sanitizeTerminalLine(control.state)}.`;
  }
}

export function renderControlLine(control: RuntimeControl): string {
  const text = control.kind === 'instruction' && control.instruction
    ? ` "${truncate(sanitizeTerminalLine(control.instruction), 120)}"`
    : '';
  return `[control ${sanitizeTerminalLine(control.id)}] ${control.kind} ${sanitizeTerminalLine(control.state)}${text} — ${describeControlState(control)}`;
}

// ---------------------------------------------------------------------------
// Runtime requests: browser-mediated decisions

/** Mirrors agentWorkRuntimeRequestDecisionPath in packages/shared. */
export function runtimeRequestDecisionPath(workItemId: string, requestId: string): string {
  return `/work/${encodeURIComponent(workItemId)}?request=${encodeURIComponent(requestId)}`;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The web app origin for decision links. An explicit --app-url or SIFT_APP_URL
 * wins; otherwise the API origin serves `/app/` (siftable.io), except the
 * local API on :8080, whose web client runs on :3000.
 */
export function resolveAppOrigin(apiUrl: string, override?: string): string {
  const raw = override?.trim() || apiUrl;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid app URL: ${sanitizeTerminalLine(raw)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('App URL must use http or https.');
  if (url.username || url.password) throw new Error('App URL must not contain credentials.');
  if (!override?.trim() && LOOPBACK_HOSTS.has(url.hostname) && url.port === '8080') url.port = '3000';
  return url.origin;
}

export function runtimeRequestDecisionUrl(appOrigin: string, workItemId: string, requestId: string): string {
  return `${appOrigin}/app${runtimeRequestDecisionPath(workItemId, requestId)}`;
}

export const BROWSER_OPEN_TIMEOUT_MS = 3_000;

/**
 * Opens an http(s) URL with the platform opener, without a shell. Resolves true
 * only when the opener process started; false when the URL is not http(s), the
 * opener is missing (`error`), or neither outcome arrives within the bound.
 */
export async function openUrlInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  timeoutMs = BROWSER_OPEN_TIMEOUT_MS,
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const target = parsed.toString();
  const [command, args] = platform === 'darwin'
    ? ['open', [target]]
    : platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', target]]
      : ['xdg-open', [target]];
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, {stdio: 'ignore', detached: true});
  } catch {
    return false;
  }
  return new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref?.();
      resolve(opened);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('spawn', () => finish(true));
    // A missing opener reports ENOENT here, after spawn() has returned.
    child.once('error', () => finish(false));
  });
}

export function describeResolution(request: Pick<RuntimeRequest, 'resolution'>): string {
  const resolution = request.resolution;
  if (!resolution) return 'no decision recorded';
  if ('decision' in resolution) return `decision ${sanitizeTerminalLine(resolution.decision)}`;
  const count = Object.keys(resolution.answers ?? {}).length;
  return `${count} answer${count === 1 ? '' : 's'}`;
}

export function describeRequestDelivery(request: Pick<RuntimeRequest, 'deliveryState' | 'deliveryError'>): string {
  switch (request.deliveryState) {
    case 'pending':
      return 'not delivered to the agent yet';
    case 'delivered':
      return 'delivered to the agent';
    case 'already_resolved':
      return 'the agent had already received another answer';
    case 'failed':
      return `delivery failed${request.deliveryError ? ` (${sanitizeTerminalLine(request.deliveryError)})` : ''}`;
    case 'unconfirmed':
      return 'delivery unconfirmed: the attempt ended before the host recorded an outcome';
    default:
      return `delivery ${sanitizeTerminalLine(request.deliveryState)}`;
  }
}

export function requestCommandHint(request: Pick<RuntimeRequest, 'kind' | 'workItemId' | 'id'>): string {
  const verb = request.kind === 'approval' ? 'approve' : 'answer';
  return `sift work ${verb} ${sanitizeTerminalLine(request.workItemId)} ${sanitizeTerminalLine(request.id)}`;
}

export function renderRequestLines(request: RuntimeRequest): string[] {
  const id = sanitizeTerminalLine(request.id);
  const summary = truncate(sanitizeTerminalLine(request.summary), 300);
  if (request.state === 'pending') {
    const label = request.kind === 'approval' ? 'Approval needed' : 'Question';
    const lines = [`[request ${id}] ${label}: ${summary}`];
    if (request.detail?.text) lines.push(`  ${truncate(sanitizeTerminalLine(request.detail.text), 500)}`);
    for (const question of request.detail?.questions ?? []) {
      lines.push(`  ${sanitizeTerminalLine(question.header)}: ${truncate(sanitizeTerminalLine(question.question), 300)}`);
      for (const option of question.options) lines.push(`    - ${sanitizeTerminalLine(option.label)}`);
    }
    lines.push(`  Decide in the browser: ${requestCommandHint(request)}`);
    return lines;
  }
  if (request.state === 'resolved') {
    return [`[request ${id}] resolved: ${describeResolution(request)}${request.resolvedBy ? ` by ${sanitizeTerminalLine(request.resolvedBy)}` : ''}; ${describeRequestDelivery(request)}`];
  }
  const reason = request.closeReason ? ` (${sanitizeTerminalLine(request.closeReason)})` : '';
  const external = request.externalDecision ? `; answered in T3: ${sanitizeTerminalLine(request.externalDecision)}` : '';
  return [`[request ${id}] ${sanitizeTerminalLine(request.state)}${reason}${external}`];
}

// ---------------------------------------------------------------------------
// Following the ledger

export type WatchEndReason = 'attempt_ended' | 'drain_incomplete' | 'timeout' | 'once' | 'signal';

export type WatchRecord =
  | {
    version: 1;
    type: 'snapshot';
    workItemId: string;
    afterSequence: number;
    attempt: ExecutionAttempt | null;
    leaseActive: boolean;
    openRequests: RuntimeRequest[];
    openControls: RuntimeControl[];
  }
  | {version: 1; type: 'event'; event: LedgerEvent}
  | {version: 1; type: 'attempt'; attempt: ExecutionAttempt | null; leaseActive: boolean}
  | {version: 1; type: 'request'; request: RuntimeRequest}
  | {version: 1; type: 'control'; control: RuntimeControl}
  /**
   * attach only: a typed control whose POST was cut short by Ctrl-C or
   * --timeout. The server may or may not have stored it; resending with the
   * same `idempotencyKey` returns the stored control instead of a second one.
   */
  | {
    version: 1;
    type: 'control_unconfirmed';
    kind: RuntimeControlKind;
    instruction: string | null;
    idempotencyKey: string;
    /**
     * `signal` / `timeout`: the watch stopped mid-send. `transport`: no
     * readable response after every retry. `http`: retries ended on a status
     * that does not prove the server refused it (408, 5xx, or an unparsed 4xx).
     */
    cause: ControlUnconfirmedCause;
    /** The last HTTP status, or null when no response was read. */
    httpStatus: number | null;
  }
  /** The attempt ended but ledger events remain after `afterSequence`: the final read hit its page cap or the timeout. */
  | {version: 1; type: 'drain_incomplete'; cause: 'page_limit' | 'timeout'; afterSequence: number}
  | {version: 1; type: 'end'; reason: WatchEndReason; afterSequence: number};

export class WorkRuntimeApiError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`API error (${status})`);
  }
}

function unwrap<T>(result: ApiResult<T>): T {
  if (!result.ok) throw new WorkRuntimeApiError(result.status, result.error);
  return result.body;
}

export function isLiveAttempt(attempt: ExecutionAttempt | null | undefined): boolean {
  return attempt?.state === 'starting' || attempt?.state === 'running';
}

function attemptSignature(execution: WorkExecution): string {
  const attempt = execution.currentAttempt;
  return attempt ? `${attempt.id}|${attempt.state}|${attempt.endReason ?? ''}|${execution.currentLeaseActive}` : `none|${execution.currentLeaseActive}`;
}

function requestSignature(request: RuntimeRequest): string {
  return `${request.state}|${request.deliveryState}|${request.updatedAt}`;
}

function controlSignature(control: RuntimeControl): string {
  return `${control.state}|${control.updatedAt}`;
}

export interface WatchOptions {
  workItemId: string;
  /** Start after this sequence instead of the ledger's current end. */
  afterSequence?: number;
  /** Ledger events before the start point to replay first. */
  backlog: number;
  waitMs: number;
  /** Overall limit in milliseconds; 0 means none. */
  timeoutMs: number;
  once: boolean;
  /** Stop when an attempt seen live during the watch is no longer live. */
  exitOnAttemptEnd: boolean;
  signal: AbortSignal;
  emit: (record: WatchRecord) => void;
  /** Awaited before the end record, so work the caller started (attach's controls) settles first. */
  beforeEnd?: () => Promise<void>;
  now?: () => number;
}

/** Pages read to find the ledger end when no --after-sequence is given (100 events each). */
export const MAX_START_PAGES = 1_000;

export class LedgerEndNotFoundError extends Error {
  constructor(readonly afterSequence: number) {
    super(`The ledger has more than ${MAX_START_PAGES * EVENT_PAGE_LIMIT} events after the start; its end was not reached at #${afterSequence}. Pass --after-sequence to follow from a known sequence.`);
  }
}

/**
 * Follows a work item: the ledger by long-poll from an explicit cursor, plus
 * changes to the execution attempt, runtime requests and runtime controls.
 * Read-only: it sends no control and resolves no request.
 */
export class WorkItemFollower {
  private readonly requests = new Map<string, string>();
  private readonly controls = new Map<string, string>();
  private attempt = '';
  private sawLive = false;
  /** Aborts on the caller's signal (Ctrl-C) or when --timeout elapses; every read uses it. */
  private runSignal: AbortSignal = new AbortController().signal;
  private deadlineHit = false;
  /** Aborts the run signal as a timeout; set by run() for its own controller. */
  private expire: () => void = () => undefined;
  cursor = 0;

  constructor(private readonly api: WorkRuntimeApi, private readonly options: WatchOptions) {}

  /** Aborts when the watch is stopped by Ctrl-C or --timeout; attach bounds its control posts with it. */
  get activeSignal(): AbortSignal {
    return this.runSignal;
  }

  /** Why the run signal fired, or null while it has not. */
  get stopCause(): 'signal' | 'timeout' | null {
    if (this.options.signal.aborted) return 'signal';
    if (this.deadlineHit) return 'timeout';
    return null;
  }

  /** Records a control the caller just sent so the next refresh does not repeat it. */
  noteControl(control: RuntimeControl): void {
    this.controls.set(control.id, controlSignature(control));
  }

  private emit(record: WatchRecord): void {
    this.options.emit(record);
  }

  private async startCursor(): Promise<LedgerEvent[]> {
    const {workItemId, backlog} = this.options;
    const signal = this.runSignal;
    if (this.options.afterSequence !== undefined) {
      this.cursor = this.options.afterSequence;
      return [];
    }
    const tail: LedgerEvent[] = [];
    let after = 0;
    // The API has no "latest sequence" read, so the end is found by reading
    // forward. Nothing is reported until a short page confirms the end.
    for (let page = 0; page < MAX_START_PAGES; page += 1) {
      const result = unwrap(await this.api.listEvents(workItemId, after, EVENT_PAGE_LIMIT, signal));
      for (const event of result.events) {
        if (event.sequence > after) after = event.sequence;
        if (backlog > 0) {
          tail.push(event);
          if (tail.length > backlog) tail.shift();
        }
      }
      if (result.events.length < EVENT_PAGE_LIMIT) {
        this.cursor = after;
        return tail;
      }
    }
    throw new LedgerEndNotFoundError(after);
  }

  private async refresh(initial: boolean): Promise<WorkExecution> {
    const {workItemId} = this.options;
    const signal = this.runSignal;
    const [execution, requestLists, controlList] = await Promise.all([
      this.api.getExecution(workItemId, signal).then(unwrap),
      this.api.listRequestsWithOpen(workItemId, signal).then(unwrap),
      this.api.listControls(workItemId, signal).then(unwrap),
    ]);
    const attemptKey = attemptSignature(execution);
    if (!initial && attemptKey !== this.attempt) {
      this.emit({version: 1, type: 'attempt', attempt: execution.currentAttempt, leaseActive: execution.currentLeaseActive});
    }
    this.attempt = attemptKey;
    // Oldest first, so a reader sees requests and controls in the order they arose.
    for (const request of [...requestLists.all].reverse()) {
      const signature = requestSignature(request);
      if (this.requests.get(request.id) === signature) continue;
      this.requests.set(request.id, signature);
      if (!initial) this.emit({version: 1, type: 'request', request});
    }
    for (const control of [...controlList.controls].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.ordinal - b.ordinal)) {
      const signature = controlSignature(control);
      if (this.controls.get(control.id) === signature) continue;
      this.controls.set(control.id, signature);
      if (!initial) this.emit({version: 1, type: 'control', control});
    }
    if (initial) {
      this.emit({
        version: 1,
        type: 'snapshot',
        workItemId,
        afterSequence: this.cursor,
        attempt: execution.currentAttempt,
        leaseActive: execution.currentLeaseActive,
        openRequests: [...requestLists.open].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        openControls: controlList.controls.filter(control => control.state === 'queued' || control.state === 'dispatching'),
      });
    }
    return execution;
  }

  /**
   * Reads every ledger page after the cursor so no event is left behind at the
   * end. Returns the reason it stopped early, or null when it reached the end.
   */
  private async drain(deadline: number, now: () => number): Promise<'page_limit' | 'timeout' | null> {
    const {workItemId, signal} = this.options;
    for (let page = 0; page < MAX_DRAIN_PAGES; page += 1) {
      if (deadline - now() <= 0) {
        // The clock passed the deadline before the timer fired: abort as a
        // timeout so work still pending at shutdown (attach's controls) stops too.
        this.expire();
        return 'timeout';
      }
      let response: ApiResult<LedgerPage>;
      try {
        // The run signal aborts a stalled request at the deadline or on Ctrl-C.
        response = await this.api.listEvents(workItemId, this.cursor, EVENT_PAGE_LIMIT, this.runSignal);
      } catch (error) {
        if (this.deadlineHit && !signal.aborted) return 'timeout';
        throw error;
      }
      const result = unwrap(response);
      for (const event of result.events) {
        if (event.sequence <= this.cursor) continue;
        this.cursor = event.sequence;
        this.emit({version: 1, type: 'event', event});
      }
      if (result.events.length < EVENT_PAGE_LIMIT) return null;
    }
    return 'page_limit';
  }

  async run(): Promise<WatchEndReason> {
    const {workItemId, signal, once, exitOnAttemptEnd} = this.options;
    const now = this.options.now ?? Date.now;
    const deadline = this.options.timeoutMs > 0 ? now() + this.options.timeoutMs : Number.POSITIVE_INFINITY;
    const run = new AbortController();
    const onAbort = () => run.abort();
    signal.addEventListener('abort', onAbort, {once: true});
    if (signal.aborted) run.abort();
    this.deadlineHit = false;
    this.expire = () => {
      this.deadlineHit = true;
      run.abort();
    };
    const timer = this.options.timeoutMs > 0 ? setTimeout(this.expire, this.options.timeoutMs) : undefined;
    this.runSignal = run.signal;
    const end = async (requested: WatchEndReason): Promise<WatchEndReason> => {
      await this.options.beforeEnd?.();
      // Ctrl-C or the deadline may fire while beforeEnd (attach's control queue)
      // is still settling; report that stop rather than the earlier reason.
      const stopped = this.stopCause;
      const reason = stopped && (requested === 'attempt_ended' || requested === 'once') ? stopped : requested;
      this.emit({version: 1, type: 'end', reason, afterSequence: this.cursor});
      return reason;
    };
    const finish = async (): Promise<WatchEndReason> => {
      const incomplete = await this.drain(deadline, now);
      if (incomplete) {
        this.emit({version: 1, type: 'drain_incomplete', cause: incomplete, afterSequence: this.cursor});
        return await end('drain_incomplete');
      }
      return await end('attempt_ended');
    };
    try {
      // Read the execution before the ledger scan too, so an attempt that ends
      // while the scan runs still counts as one this watch saw live.
      const before = unwrap(await this.api.getExecution(workItemId, this.runSignal));
      const backlog = await this.startCursor();
      const execution = await this.refresh(true);
      for (const event of backlog) this.emit({version: 1, type: 'event', event});
      const known = new Set(before.attempts.map(attempt => attempt.id));
      if (before.currentAttempt) known.add(before.currentAttempt.id);
      this.sawLive = isLiveAttempt(execution.currentAttempt)
        || isLiveAttempt(before.currentAttempt)
        // Started and ended during the scan: absent before, ended after.
        || execution.attempts.some(attempt => !known.has(attempt.id) && !isLiveAttempt(attempt));
      if (once) return await end('once');
      if (exitOnAttemptEnd && this.sawLive && !isLiveAttempt(execution.currentAttempt)) return await finish();
      for (;;) {
        const remaining = deadline - now();
        if (remaining <= 0) {
          // Abort as a timeout before shutting down, so attach's pending
          // controls are cut short too; cleanup in finally waits for end().
          this.expire();
          return await end('timeout');
        }
        const waitMs = Math.max(0, Math.min(this.options.waitMs, MAX_EVENT_WAIT_MS, remaining));
        const page = unwrap(await this.api.waitEvents(workItemId, this.cursor, waitMs, this.runSignal));
        for (const event of page.events) {
          if (event.sequence <= this.cursor) continue;
          this.cursor = event.sequence;
          this.emit({version: 1, type: 'event', event});
        }
        const current = await this.refresh(false);
        const live = isLiveAttempt(current.currentAttempt);
        if (exitOnAttemptEnd && this.sawLive && !live) return await finish();
        if (live) this.sawLive = true;
      }
    } catch (error) {
      // A timeout and a user interrupt end differently, whichever read they cut short.
      if (signal.aborted) return await end('signal');
      if (this.deadlineHit) return await end('timeout');
      if (isAbortError(error)) return await end('signal');
      // A failed watch cuts short attach's in-flight controls and stops its
      // queue before the error surfaces, as the other ends do.
      run.abort();
      await this.options.beforeEnd?.().catch(() => undefined);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      // Nothing reads after the watch returns; release anything still pending.
      run.abort();
    }
  }
}

export function renderAttemptLine(attempt: ExecutionAttempt | null, leaseActive: boolean): string {
  if (!attempt) return 'No live execution attempt.';
  const parts = [`Attempt ${sanitizeTerminalLine(attempt.id)} ${sanitizeTerminalLine(attempt.state)}`];
  if (attempt.endReason) parts.push(`end reason ${sanitizeTerminalLine(attempt.endReason)}`);
  if (attempt.harness) parts.push(`harness ${sanitizeTerminalLine(attempt.harness)}`);
  if (attempt.model) parts.push(`model ${sanitizeTerminalLine(attempt.model)}`);
  if (attempt.host) parts.push(`host ${sanitizeTerminalLine(attempt.host)}`);
  parts.push(leaseActive ? 'lease active' : 'lease not active');
  return parts.join(' · ');
}

const END_TEXT: Record<WatchEndReason, string> = {
  attempt_ended: 'The execution attempt is no longer live; stopped following.',
  drain_incomplete: 'The execution attempt ended, but ledger events remain unread.',
  timeout: 'Stopped following: the timeout elapsed.',
  once: 'Printed the current state once.',
  signal: 'Stopped following.',
};

export function renderWatchRecord(record: WatchRecord): string[] {
  switch (record.type) {
    case 'snapshot': {
      const lines = [
        `Work ${sanitizeTerminalLine(record.workItemId)} · ledger at #${record.afterSequence}`,
        renderAttemptLine(record.attempt, record.leaseActive),
      ];
      if (record.openRequests.length === 0) lines.push('No open runtime requests.');
      for (const request of record.openRequests) lines.push(...renderRequestLines(request));
      for (const control of record.openControls) lines.push(renderControlLine(control));
      return lines;
    }
    case 'event':
      return [renderCollaborationEventLine(record.event as unknown as Record<string, unknown>)];
    case 'attempt':
      return [renderAttemptLine(record.attempt, record.leaseActive)];
    case 'request':
      return renderRequestLines(record.request);
    case 'control':
      return [renderControlLine(record.control)];
    case 'control_unconfirmed': {
      const noun = record.kind === 'interrupt' ? 'Interrupt' : 'Instruction';
      const cause = record.cause === 'timeout'
        ? 'the timeout elapsed while it was being sent'
        : record.cause === 'signal'
          ? 'you stopped the command while it was being sent'
          : record.cause === 'transport'
            ? 'no response could be read after every retry'
            : `retries ended on HTTP ${record.httpStatus ?? '?'}`;
      const retry = record.kind === 'interrupt'
        ? `sift work interrupt <id> --idempotency-key ${record.idempotencyKey}`
        : `sift work send <id> <same text> --idempotency-key ${record.idempotencyKey}`;
      return [`${noun} outcome unknown: ${cause}, so the server may or may not have queued it. To check or retry without a duplicate: ${retry}`];
    }
    case 'drain_incomplete':
      return [`Stopped before the end of the ledger (${record.cause === 'timeout' ? 'the timeout elapsed' : 'page limit reached'}); events after #${record.afterSequence} were not read.`];
    case 'end':
      return [`${END_TEXT[record.reason]} Resume with --after-sequence ${record.afterSequence}.`];
  }
}

/**
 * Sends typed attach lines as controls one at a time, in input order, so the
 * server queues them in the order the person typed. `idle()` resolves once
 * every accepted line has been sent and reported.
 */
export class ControlInputQueue {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly handle: (line: string) => Promise<void>) {}

  submit(line: string): void {
    if (this.closed) return;
    this.tail = this.tail.then(() => this.handle(line)).catch(() => undefined);
  }

  /** Stops accepting lines and waits for the ones already submitted. */
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}

/**
 * One signal for a command's wait loop: aborts on Ctrl-C or when `timeoutMs`
 * elapses, and says which happened. Call dispose() when the wait ends.
 */
export function waitScope(timeoutMs: number): {
  signal: AbortSignal;
  cause: () => 'signal' | 'timeout' | null;
  dispose: () => void;
} {
  const controller = new AbortController();
  let cause: 'signal' | 'timeout' | null = null;
  const onSigint = () => {
    cause ??= 'signal';
    controller.abort();
  };
  process.once('SIGINT', onSigint);
  const timer = setTimeout(() => {
    cause ??= 'timeout';
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    cause: () => cause,
    dispose: () => {
      clearTimeout(timer);
      process.off('SIGINT', onSigint);
    },
  };
}

export type AttachControlResult =
  | {status: 'sent'; record: WatchRecord}
  | {status: 'unconfirmed'; record: WatchRecord}
  | {status: 'refused'; httpStatus: number}
  | {status: 'not_sent'};

/**
 * Sends one control typed into attach, bounded by the follower's run signal.
 * A POST cut short by Ctrl-C or --timeout is reported as unconfirmed, never
 * as accepted or refused; its Idempotency-Key lets the person retry safely.
 */
export async function submitAttachControl(
  api: WorkRuntimeApi,
  workItemId: string,
  input: {kind: 'instruction'; instruction: string} | {kind: 'interrupt'},
  follower: Pick<WorkItemFollower, 'activeSignal' | 'stopCause'>,
  options: {retries?: number; retryDelayMs?: number; idempotencyKey?: string} = {},
): Promise<AttachControlResult> {
  const signal = follower.activeSignal;
  // Lines still queued after the watch stopped are never sent.
  if (signal.aborted) return {status: 'not_sent'};
  const idempotencyKey = options.idempotencyKey ?? newControlIdempotencyKey(input.kind);
  try {
    const {result, ambiguousFailure} = await sendControlWithRetry(api, workItemId, input, {
      idempotencyKey,
      retries: options.retries ?? 2,
      retryDelayMs: options.retryDelayMs ?? 500,
      signal,
    });
    if (!result.ok) {
      if (!ambiguousFailure) return {status: 'refused', httpStatus: result.status};
      const failure = ambiguousFailure;
      // The server may have stored it: keep the key so a resend cannot duplicate it.
      return {
        status: 'unconfirmed',
        record: {
          version: 1,
          type: 'control_unconfirmed',
          kind: input.kind,
          instruction: input.kind === 'instruction' ? input.instruction : null,
          idempotencyKey,
          cause: failure.status === 0 ? 'transport' : 'http',
          httpStatus: failure.status === 0 ? null : failure.status,
        },
      };
    }
    return {status: 'sent', record: {version: 1, type: 'control', control: result.body.control}};
  } catch (error) {
    if (!isAbortError(error) && !signal.aborted) throw error;
    return {
      status: 'unconfirmed',
      record: {
        version: 1,
        type: 'control_unconfirmed',
        kind: input.kind,
        instruction: input.kind === 'instruction' ? input.instruction : null,
        idempotencyKey,
        cause: follower.stopCause ?? 'signal',
        httpStatus: null,
      },
    };
  }
}

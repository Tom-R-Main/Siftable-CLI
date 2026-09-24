/**
 * Long-lived harness session over newline-delimited JSON on stdin/stdout
 * (AGENT-RUNTIME-31). One process owns one session and at most one active
 * tool loop. See packages/exf-cli/docs/sift-harness-session-protocol.md for the contract.
 *
 * Client lines are commands `{id, type, ...}` and receive exactly one
 * `{type: "response", id, ok, ...}` line. Server events carry the headless
 * envelope `{schemaVersion, seq, session, ts, type, ...}`, are appended to a
 * per-session wire log and fsynced before they are written, and can be replayed
 * from a cursor, including by a later process that resumes the session.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { BrainAskResult, BrainEvent } from './brain';
import type { ApprovalDecision, ConfirmRequest } from './confirmGate';
import type { QuestionRequest } from './questionGate';

export const SESSION_PROTOCOL_VERSION = 1;
export const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_PROMPT_CHARS = 256 * 1024;
const MAX_ANSWER_CHARS = 64 * 1024;
const MAX_REPLAY_PAGE = 10_000;
const DEFAULT_REPLAY_PAGE = 1_000;
const DECISIONS: readonly ApprovalDecision[] = ['deny', 'allow', 'always', 'bypass'];

export type WireEvent = {schemaVersion: 1; seq: number; session: string; ts: string; type: string; [key: string]: unknown};

/**
 * The engine seam: production wraps brain.agentHarnessAsk; tests script it.
 * `kind` selects how results are read, because the engines report differently:
 * the harness always sets `status` and returns only after its tool loop has
 * unwound; Codex omits `status` on normal completion and stops asynchronously,
 * reporting `stopConfirmed` after an interrupt.
 */
export interface SessionEngine {
  readonly kind: 'harness' | 'codex';
  ask(input: string, onEvent: (event: BrainEvent) => void, signal: AbortSignal): Promise<BrainAskResult>;
  close(): Promise<void>;
}

/** The subset of confirmGate/questionGate the server drives (injectable for tests). */
export interface SessionGates {
  setConfirmListener(listener: ((request: ConfirmRequest) => void) | null): void;
  setConfirmCancellationListener(listener: ((id: string) => void) | null): void;
  resolveApproval(id: string, decision: ApprovalDecision): void;
  rejectAllConfirms(): void;
  setQuestionListener(listener: ((request: QuestionRequest) => void) | null): void;
  setQuestionCancellationListener(listener: ((id: string) => void) | null): void;
  resolveQuestion(id: string, answer: string | null): boolean;
  rejectAllQuestions(): void;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
}

// ── Durable wire log ─────────────────────────────────────────────────────────

interface LeaseStore { acquireLease(sessionId: string): {release(): void} }

/**
 * Append-only JSONL of emitted wire events, one file per session under
 * `<session-event-root>/wire/`. The directory is initialized and leased by the
 * session journal's own store, so a second process cannot serve the same
 * session and a crashed owner's lease is recovered by the journal's protocol.
 * The newline after each event is its commit marker; a torn final fragment is
 * truncated on open. The server fsyncs before it sends any event it appended.
 */
export class WireEventLog {
  readonly path: string;
  private readonly events: WireEvent[] = [];
  private fd: number | undefined;
  private lease: {release(): void} | undefined;
  private synced = 0;

  constructor(private readonly options: {rootDir: string; session: string; leaseStore: (rootDir: string) => LeaseStore}) {
    const dir = join(options.rootDir, 'wire');
    const store = options.leaseStore(dir);
    const digest = createHash('sha256').update(options.session, 'utf8').digest('hex');
    this.path = join(dir, `${digest}.wire.jsonl`);
    this.lease = store.acquireLease(`wire:${options.session}`);
    try {
      this.load();
      const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
      this.fd = openSync(this.path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow, 0o600);
      if ((fstatSync(this.fd).mode & 0o077) !== 0) throw new Error('Wire event log must not be group or world accessible');
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private load(): void {
    let raw: string;
    try {
      if (lstatSync(this.path).isSymbolicLink()) throw new Error('Wire event log must not be a symbolic link');
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const committed = raw.lastIndexOf('\n') + 1;
    if (committed < raw.length) {
      // A crash mid-append left a fragment without its commit newline.
      const fd = openSync(this.path, constants.O_RDWR);
      try { ftruncateSync(fd, Buffer.byteLength(raw.slice(0, committed), 'utf8')); fsyncSync(fd); } finally { closeSync(fd); }
    }
    for (const line of raw.slice(0, committed).split('\n')) {
      if (!line) continue;
      const event = JSON.parse(line) as WireEvent;
      if (!event || typeof event !== 'object' || event.seq !== this.events.length + 1 || event.session !== this.options.session) {
        throw new Error(`Wire event log is not contiguous at seq ${this.events.length + 1}`);
      }
      this.events.push(event);
    }
    this.synced = this.events.length;
  }

  get lastSeq(): number {
    return this.events.length;
  }

  last(): WireEvent | undefined {
    return this.events.at(-1);
  }

  append(event: WireEvent): void {
    if (this.fd === undefined) throw new Error('Wire event log is closed');
    if (event.seq !== this.events.length + 1) throw new Error('Wire event sequence must be contiguous');
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset);
    this.events.push(event);
  }

  after(cursor: number, limit: number): WireEvent[] {
    return this.events.slice(cursor, cursor + limit);
  }

  /** Highest seq known to be on disk. */
  get durableSeq(): number {
    return this.synced;
  }

  sync(): void {
    if (this.fd === undefined || this.synced === this.events.length) return;
    const through = this.events.length;
    fsyncSync(this.fd);
    this.synced = through;
  }

  close(): void {
    if (this.fd !== undefined) {
      try { fsyncSync(this.fd); } catch { /* best effort */ }
      closeSync(this.fd);
      this.fd = undefined;
    }
    try { this.lease?.release(); } catch { /* lease recovery handles a failed release */ }
    this.lease = undefined;
  }
}

// ── Protocol server ──────────────────────────────────────────────────────────

type CommandId = string | number;
type ErrorCode = 'parse_error' | 'invalid_request' | 'unsupported_version' | 'not_initialized' | 'unknown_command'
  | 'turn_in_progress' | 'stop_unconfirmed' | 'unknown_request' | 'decision_not_offered' | 'shutting_down' | 'line_too_long';

interface ActiveTurn {
  turnId: string;
  controller: AbortController;
  cancelReason?: 'client' | 'deadline' | 'shutdown';
  done: Promise<void>;
}

interface ApprovalRecord { turnId?: string; state: 'pending' | 'resolved'; decision?: ApprovalDecision; source?: 'client' | 'cancelled'; allowAlways: boolean; allowBypass: boolean }
interface QuestionRecord { turnId?: string; state: 'pending' | 'resolved'; outcome?: 'answered' | 'declined' | 'cancelled' }

export interface SessionServerOptions {
  session: string;
  provider: string;
  model: string;
  cwd: string;
  deadlineMs: number;
  engine: SessionEngine;
  gates: SessionGates;
  log: WireEventLog;
  write: (line: string) => void;
  clock?: () => Date;
}

type TurnStatus = 'completed' | 'failed' | 'interrupted' | 'limit_reached';

/** Read one engine's result into a turn status and whether a stop is proven. */
export function interpretEngineResult(kind: SessionEngine['kind'], result: BrainAskResult): {status: TurnStatus; stopConfirmed: boolean} {
  if (kind === 'codex') {
    const status: TurnStatus = result.status === 'interrupted' ? 'interrupted' : result.status === 'failed' || result.error ? 'failed'
      : result.status === 'limit_reached' ? 'limit_reached' : 'completed';
    return {status, stopConfirmed: result.stopConfirmed === true};
  }
  const status: TurnStatus = result.status === 'limit_reached' ? 'limit_reached' : result.status === 'interrupted' ? 'interrupted'
    : result.error ? 'failed' : result.status || 'failed';
  // agentHarnessAsk resolves only after the loop returned and session jobs were stopped.
  return {status, stopConfirmed: result.stopConfirmed !== false};
}

function zeroUsage(): UsageTotals {
  return {requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0};
}

export class SessionServer {
  private initialized = false;
  private shuttingDown: Promise<number> | undefined;
  private active: ActiveTurn | undefined;
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly questions = new Map<string, QuestionRecord>();
  private readonly usage = zeroUsage();
  private lastTurnUsage: UsageTotals | undefined;
  private turns = 0;
  /** A cancelled turn whose engine never confirmed it stopped; no new turn may start. */
  private unconfirmedStop: string | undefined;
  /** Protocol lines waiting for the log to be durable through their seq. */
  private outbound: string[] = [];
  private flushScheduled = false;
  private readonly clock: () => Date;
  private markClosed!: (exitCode: number) => void;
  /** Resolves with the exit code once the session has shut down, whatever asked it to. */
  readonly closed = new Promise<number>(resolve => { this.markClosed = resolve; });

  constructor(private readonly options: SessionServerOptions) {
    this.clock = options.clock ?? (() => new Date());
    const {gates} = options;
    gates.setConfirmListener(request => this.onApprovalRequest(request));
    gates.setConfirmCancellationListener(id => this.onApprovalCancelled(id));
    gates.setQuestionListener(request => this.onQuestionRequest(request));
    gates.setQuestionCancellationListener(id => this.onQuestionCancelled(id));
    this.restoreFromLog();
  }

  /** True while a turn's tool loop is running. */
  get busy(): boolean {
    return this.active !== undefined;
  }

  /**
   * Group commit: an event is appended to the log at once but written to the
   * client only after an fsync covers it, so a client never holds a seq that
   * a restart could lose. Events emitted in the same tick share one fsync;
   * responses flush immediately so they never overtake earlier events.
   */
  private emit(event: {type: string; [key: string]: unknown}): WireEvent {
    const envelope = {...event, schemaVersion: 1 as const, seq: this.options.log.lastSeq + 1,
      session: this.options.session, ts: this.clock().toISOString()} as WireEvent;
    this.options.log.append(envelope);
    this.outbound.push(`${JSON.stringify(envelope)}\n`);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => this.flush());
    }
    return envelope;
  }

  /** fsync the log through every queued event, then write the queue in order. */
  flush(): void {
    this.flushScheduled = false;
    if (!this.outbound.length) return;
    this.options.log.sync();
    const lines = this.outbound;
    this.outbound = [];
    for (const line of lines) this.options.write(line);
  }

  private respond(id: CommandId | null, body: Record<string, unknown>): void {
    this.outbound.push(`${JSON.stringify({type: 'response', id, ok: true, ...body})}\n`);
    this.flush();
  }

  private fail(id: CommandId | null, code: ErrorCode, message: string): void {
    this.outbound.push(`${JSON.stringify({type: 'response', id, ok: false, error: {code, message}})}\n`);
    this.flush();
  }

  /** Reject a command line the reader could not frame. */
  rejectLine(code: 'line_too_long', message: string): void {
    this.fail(null, code, message);
  }

  /**
   * Resume from the wire log: carry cumulative usage and the turn count
   * forward, and close once a turn left open by a process that died.
   */
  private restoreFromLog(): void {
    let open: string | undefined;
    for (const event of this.options.log.after(0, Number.MAX_SAFE_INTEGER)) {
      if (event.type === 'turn.started') {
        open = String(event.turnId);
        this.turns += 1;
      } else if (event.type === 'usage') {
        const session = event.cumulative as Partial<UsageTotals> | undefined;
        const turn = event.turn as Partial<UsageTotals> | undefined;
        for (const key of Object.keys(this.usage) as Array<keyof UsageTotals>) {
          const value = session?.[key];
          if (Number.isSafeInteger(value) && (value as number) >= 0) this.usage[key] = value as number;
        }
        if (turn) this.lastTurnUsage = {...zeroUsage(), ...Object.fromEntries(Object.entries(turn).filter(([, value]) => Number.isSafeInteger(value)))};
      } else if (typeof event.type === 'string' && event.type.startsWith('turn.') && event.turnId === open) open = undefined;
    }
    if (open) {
      this.emit({type: 'turn.stopped', turnId: open, status: 'interrupted', confirmed: true, reason: 'process_exit', recovered: true});
      this.flush();
    }
  }

  private onApprovalRequest(request: ConfirmRequest): void {
    const allowAlways = request.allowAlways !== false;
    const allowBypass = request.allowBypass !== false;
    this.approvals.set(request.id, {turnId: this.active?.turnId, state: 'pending', allowAlways, allowBypass});
    const decisions = DECISIONS.filter(decision => (decision !== 'always' || allowAlways) && (decision !== 'bypass' || allowBypass));
    this.emit({type: 'approval.request', turnId: this.active?.turnId, requestId: request.id, kind: request.kind,
      path: request.path, detail: request.detail, decisions});
  }

  private onApprovalCancelled(id: string): void {
    const record = this.approvals.get(id);
    if (!record || record.state !== 'pending') return;
    Object.assign(record, {state: 'resolved', decision: 'deny', source: 'cancelled'});
    this.emit({type: 'approval.resolved', turnId: record.turnId, requestId: id, decision: 'deny', source: 'cancelled'});
  }

  private onQuestionRequest(request: QuestionRequest): void {
    this.questions.set(request.id, {turnId: this.active?.turnId, state: 'pending'});
    this.emit({type: 'question.request', turnId: this.active?.turnId, requestId: request.id, question: request.question,
      ...(request.options?.length ? {options: request.options} : {})});
  }

  private onQuestionCancelled(id: string): void {
    const record = this.questions.get(id);
    if (!record || record.state !== 'pending') return;
    Object.assign(record, {state: 'resolved', outcome: 'cancelled'});
    this.emit({type: 'question.resolved', turnId: record.turnId, requestId: id, outcome: 'cancelled'});
  }

  /** Handle one client line. Resolves when the command's response is written. */
  async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: unknown;
    try { message = JSON.parse(line); } catch {
      return this.fail(null, 'parse_error', 'Command is not valid JSON');
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return this.fail(null, 'invalid_request', 'Command must be a JSON object');
    const command = message as Record<string, unknown>;
    const id = command.id;
    if (!((typeof id === 'string' && id.length > 0 && id.length <= 128) || (typeof id === 'number' && Number.isSafeInteger(id)))) {
      return this.fail(null, 'invalid_request', 'Command id must be a nonempty string (max 128) or a safe integer');
    }
    if (typeof command.type !== 'string') return this.fail(id, 'invalid_request', 'Command type must be a string');
    if (this.shuttingDown && command.type !== 'shutdown') return this.fail(id, 'shutting_down', 'Session is shutting down');
    if (command.type === 'initialize') return this.initialize(id, command);
    if (command.type === 'shutdown') {
      const exitCode = await this.shutdown('client');
      return this.respond(id, {status: 'closed', exitCode});
    }
    if (!this.initialized) return this.fail(id, 'not_initialized', 'Send initialize first');
    switch (command.type) {
      case 'prompt': return this.prompt(id, command);
      case 'approval.respond': return this.approvalRespond(id, command);
      case 'question.answer': return this.questionAnswer(id, command);
      case 'cancel': return this.cancel(id, command);
      case 'replay': return this.replay(id, command);
      case 'usage': return this.respond(id, {usage: {session: {...this.usage}, lastTurn: this.lastTurnUsage ?? null, turns: this.turns}});
      default: return this.fail(id, 'unknown_command', `Unknown command type: ${command.type.slice(0, 64)}`);
    }
  }

  private initialize(id: CommandId, command: Record<string, unknown>): void {
    if (command.protocolVersion !== SESSION_PROTOCOL_VERSION) {
      return this.fail(id, 'unsupported_version', `protocolVersion must be ${SESSION_PROTOCOL_VERSION}`);
    }
    this.initialized = true;
    this.respond(id, {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      session: this.options.session,
      lastSeq: this.options.log.lastSeq,
      resumed: this.options.log.lastSeq > 0,
      busy: this.busy,
      agent: {provider: this.options.provider, model: this.options.model, cwd: this.options.cwd},
      capabilities: {
        prompt: {followUp: true, concurrentTurns: 1, input: ['text']},
        approvals: {decisions: [...DECISIONS], idempotentResponses: true},
        questions: true,
        cancel: {confirmedStop: true},
        replay: {durable: true, maxPage: MAX_REPLAY_PAGE},
        usage: true,
        limits: {maxCommandBytes: MAX_COMMAND_BYTES, turnDeadlineMs: this.options.deadlineMs},
      },
    });
  }

  private prompt(id: CommandId, command: Record<string, unknown>): void {
    const input = command.input;
    if (typeof input !== 'string' || !input.trim() || input.length > MAX_PROMPT_CHARS) {
      return this.fail(id, 'invalid_request', `input must be a nonempty string of at most ${MAX_PROMPT_CHARS} characters`);
    }
    if (this.active) return this.fail(id, 'turn_in_progress', `Turn ${this.active.turnId} is still running; cancel it or wait for its terminal event`);
    if (this.unconfirmedStop) {
      return this.fail(id, 'stop_unconfirmed', `Turn ${this.unconfirmedStop} was not confirmed stopped; shut down and resume the session`);
    }
    const turnId = randomUUID();
    const controller = new AbortController();
    const turn: ActiveTurn = {turnId, controller, done: Promise.resolve()};
    this.active = turn;
    this.turns += 1;
    this.respond(id, {turnId});
    this.emit({type: 'turn.started', turnId});
    turn.done = this.runTurn(turn, input);
  }

  private async runTurn(turn: ActiveTurn, input: string): Promise<void> {
    const timer = setTimeout(() => this.requestCancel('deadline'), this.options.deadlineMs);
    let result: BrainAskResult;
    try {
      result = await this.options.engine.ask(input, event => {
        this.emit({...event, turnId: turn.turnId});
      }, turn.controller.signal);
    } catch (error) {
      result = {text: '', status: turn.controller.signal.aborted ? 'interrupted' : 'failed', error: error instanceof Error ? error.message : String(error)};
    } finally {
      clearTimeout(timer);
    }
    // The tool loop has returned. Anything still pending belongs to it and
    // can no longer be acted on; revoke before the terminal event.
    this.options.gates.rejectAllConfirms();
    this.options.gates.rejectAllQuestions();
    const turnUsage = zeroUsage();
    for (const receipt of result.providerReceipts ?? []) {
      turnUsage.requests += 1;
      turnUsage.inputTokens += receipt.usage?.inputTokens ?? 0;
      turnUsage.outputTokens += receipt.usage?.outputTokens ?? 0;
      turnUsage.cachedInputTokens += receipt.usage?.cachedInputTokens ?? 0;
      turnUsage.totalTokens += receipt.usage?.totalTokens ?? ((receipt.usage?.inputTokens ?? 0) + (receipt.usage?.outputTokens ?? 0));
    }
    for (const key of Object.keys(turnUsage) as Array<keyof UsageTotals>) this.usage[key] += turnUsage[key];
    this.lastTurnUsage = turnUsage;
    // `session` is the envelope's session id, so the running total is `cumulative`.
    this.emit({type: 'usage', turnId: turn.turnId, turn: turnUsage, cumulative: {...this.usage}});
    const {status, stopConfirmed} = interpretEngineResult(this.options.engine.kind, result);
    if (turn.cancelReason) {
      const detail = {turnId: turn.turnId, status: 'interrupted', reason: turn.cancelReason,
        text: result.text, ...(result.progressText ? {progressText: result.progressText} : {}),
        ...(result.jobCleanup ? {jobCleanup: result.jobCleanup} : {}), ...(result.error ? {error: result.error} : {})};
      if (stopConfirmed) this.emit({type: 'turn.stopped', ...detail, confirmed: true});
      else {
        // The engine could not prove its turn ended. Say so, and refuse new
        // turns so a second tool loop cannot start beside a running one.
        this.unconfirmedStop = turn.turnId;
        this.emit({type: 'turn.stop_unconfirmed', ...detail, confirmed: false});
      }
    } else {
      const {stopConfirmed: _omit, ...rest} = result;
      this.emit({...rest, type: `turn.${status}`, turnId: turn.turnId, status});
    }
    this.flush();
    this.active = undefined;
  }

  private requestCancel(reason: NonNullable<ActiveTurn['cancelReason']>): 'stopping' | 'already_stopping' | 'no_active_turn' {
    const turn = this.active;
    if (!turn) return 'no_active_turn';
    if (turn.cancelReason) return 'already_stopping';
    turn.cancelReason = reason;
    this.emit({type: 'status', status: 'stopping', turnId: turn.turnId, reason});
    turn.controller.abort(new DOMException('Turn cancelled', 'AbortError'));
    return 'stopping';
  }

  private cancel(id: CommandId, command: Record<string, unknown>): void {
    if (command.turnId !== undefined && command.turnId !== this.active?.turnId) {
      return this.respond(id, {status: 'no_active_turn', turnId: command.turnId});
    }
    const turnId = this.active?.turnId;
    this.respond(id, {status: this.requestCancel('client'), ...(turnId ? {turnId} : {})});
  }

  private approvalRespond(id: CommandId, command: Record<string, unknown>): void {
    const {requestId, decision} = command;
    if (typeof requestId !== 'string' || !DECISIONS.includes(decision as ApprovalDecision)) {
      return this.fail(id, 'invalid_request', 'approval.respond needs requestId and decision (deny, allow, always, bypass)');
    }
    const record = this.approvals.get(requestId);
    if (!record) return this.fail(id, 'unknown_request', 'No approval request with that id');
    if (record.state === 'resolved') {
      return this.respond(id, {status: 'already_resolved', requestId, decision: record.decision, source: record.source});
    }
    if ((decision === 'always' && !record.allowAlways) || (decision === 'bypass' && !record.allowBypass)) {
      return this.fail(id, 'decision_not_offered', `Decision ${decision} is not offered for this request`);
    }
    Object.assign(record, {state: 'resolved', decision, source: 'client'});
    this.options.gates.resolveApproval(requestId, decision as ApprovalDecision);
    this.emit({type: 'approval.resolved', turnId: record.turnId, requestId, decision, source: 'client'});
    this.respond(id, {status: 'applied', requestId, decision});
  }

  private questionAnswer(id: CommandId, command: Record<string, unknown>): void {
    const {requestId, answer, decline} = command;
    const declining = decline === true;
    if (typeof requestId !== 'string' || (!declining && (typeof answer !== 'string' || answer.length > MAX_ANSWER_CHARS))) {
      return this.fail(id, 'invalid_request', `question.answer needs requestId and an answer string (max ${MAX_ANSWER_CHARS}) or decline: true`);
    }
    const record = this.questions.get(requestId);
    if (!record) return this.fail(id, 'unknown_request', 'No question with that id');
    if (record.state === 'resolved') return this.respond(id, {status: 'already_resolved', requestId, outcome: record.outcome});
    const outcome = declining ? 'declined' : 'answered';
    Object.assign(record, {state: 'resolved', outcome});
    this.options.gates.resolveQuestion(requestId, declining ? null : answer as string);
    this.emit({type: 'question.resolved', turnId: record.turnId, requestId, outcome});
    this.respond(id, {status: 'applied', requestId, outcome});
  }

  private replay(id: CommandId, command: Record<string, unknown>): void {
    const after = command.after ?? 0;
    const limit = command.limit ?? DEFAULT_REPLAY_PAGE;
    if (!Number.isSafeInteger(after) || (after as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_REPLAY_PAGE) {
      return this.fail(id, 'invalid_request', `replay needs integer after >= 0 and limit 1..${MAX_REPLAY_PAGE}`);
    }
    const lastSeq = this.options.log.lastSeq;
    if ((after as number) > lastSeq) return this.fail(id, 'invalid_request', `Cursor ${after} is past the last event ${lastSeq}`);
    const events = this.options.log.after(after as number, limit as number);
    const through = events.at(-1)?.seq ?? after;
    this.respond(id, {events, through, lastSeq, more: (through as number) < lastSeq});
  }

  /** Stop any active turn (awaiting its confirmed stop), close the engine, and seal the log. */
  shutdown(reason: 'client' | 'eof' | 'signal'): Promise<number> {
    this.shuttingDown ??= (async () => {
      const turn = this.active;
      if (turn) {
        this.requestCancel('shutdown');
        await turn.done;
      }
      const {gates} = this.options;
      gates.rejectAllConfirms();
      gates.rejectAllQuestions();
      gates.setConfirmListener(null);
      gates.setConfirmCancellationListener(null);
      gates.setQuestionListener(null);
      gates.setQuestionCancellationListener(null);
      let exitCode = 0;
      let error: string | undefined;
      try { await this.options.engine.close(); } catch (failure) {
        exitCode = 1;
        error = `Session shutdown failed: ${failure instanceof Error ? failure.message : String(failure)}`;
      }
      this.emit({type: 'session.closed', reason, ...(error ? {error} : {}), usage: {...this.usage}, turns: this.turns});
      this.flush();
      this.options.log.close();
      this.markClosed(exitCode);
      return exitCode;
    })();
    return this.shuttingDown;
  }
}

/**
 * Feed newline-delimited commands from `input` to the server, in order. EOF
 * shuts the session down. An oversized line is rejected and skipped through
 * its newline. Resolves with the exit code once the session has closed.
 */
export function serveLines(server: SessionServer, input: Readable): Promise<number> {
  let buffer = '';
  let discarding = false;
  let chain: Promise<unknown> = Promise.resolve();
  const tooLong = () => server.rejectLine('line_too_long', `Command exceeds ${MAX_COMMAND_BYTES} bytes`);
  const enqueue = (line: string) => { chain = chain.then(() => server.handleLine(line)).catch(() => undefined); };
  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (discarding) { discarding = false; continue; }
      if (Buffer.byteLength(line) > MAX_COMMAND_BYTES) { tooLong(); continue; }
      enqueue(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    if (discarding) buffer = '';
    else if (Buffer.byteLength(buffer) > MAX_COMMAND_BYTES) {
      tooLong();
      buffer = '';
      discarding = true;
    }
  };
  const onEnd = () => {
    if (buffer.trim() && !discarding) enqueue(buffer);
    buffer = '';
    chain = chain.then(() => server.shutdown('eof'));
  };
  input.on('data', onData);
  input.once('end', onEnd);
  input.once('error', onEnd);
  return server.closed.then(exitCode => {
    input.removeListener('data', onData);
    input.removeListener('end', onEnd);
    input.removeListener('error', onEnd);
    input.pause();
    return exitCode;
  });
}

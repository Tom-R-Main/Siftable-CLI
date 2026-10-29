/**
 * Needs you, supervisor side (first-run U5b-3). The writer asks through the
 * relay sidecar; the supervisor opens the question on the server as a
 * blocking user_input runtime request, polls for the person's answer, and
 * offers it to the writer's long poll. Only the writer's own receipt counts
 * as delivery: the supervisor then records `delivered` once, under a fixed
 * idempotency key.
 *
 * Every step is journaled (asked, opened, offered, received, acknowledged).
 * A restart never resumes an attempt, so on any stop the open questions are
 * closed (`session_ended`) and the journal is reconciled: a received answer
 * is recorded delivered, an offered but unconfirmed one failed, and nothing
 * is offered again. A blocking question unanswered for two hours seals the
 * attempt.
 */
import {createHash} from 'node:crypto';
import {QUESTION_PATHS} from './relaySidecar.js';

export {QUESTION_PATHS};
export const QUESTION_SEAL_MS = 2 * 60 * 60 * 1000;
const POLL_HOLD_MS = 25_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface JournalQuestion {
  questionId: string;
  questions: unknown[];
  summary: string;
  state: 'asked' | 'opened' | 'offered' | 'received' | 'acknowledged';
  /** Monotonic time the server confirmed the open; the two-hour seal counts from here. */
  openedMono?: number;
  requestId?: string;
  answerId?: string;
  answers?: Record<string, string | string[]>;
}

export interface QuestionCredential {runtimeId: string; leaseGeneration: number; claimOwner: string; claimToken: string}

export type QuestionCall = (method: 'GET' | 'POST', route: string, body?: unknown, options?: {key?: string; timeoutMs?: number})
  => Promise<{status: number; body: Record<string, unknown>}>;

type Reply = {status: number; body: string};
const reply = (status: number, value?: object): Reply => ({status, body: value === undefined ? '' : JSON.stringify(value)});

/** answerId binds an answer to its request and content, so the writer can tell a repeat from a new one. */
export function answerIdOf(requestId: string, answers: Record<string, string | string[]>): string {
  const canonical = JSON.stringify(Object.keys(answers).sort().map((key) => [key, answers[key]]));
  return `${requestId}:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

export class QuestionDesk {
  private readonly waiters = new Set<() => void>();
  private sealed = false;

  constructor(
    private questions: JournalQuestion[],
    private readonly persist: (questions: JournalQuestion[]) => Promise<void>,
    private readonly monoMs: () => number,
    private readonly holdMs = POLL_HOLD_MS,
  ) {}

  list(): JournalQuestion[] { return this.questions; }

  private async update(questionId: string, change: Partial<JournalQuestion>) {
    this.questions = this.questions.map((q) => (q.questionId === questionId ? {...q, ...change} : q));
    await this.persist(this.questions);
    for (const wake of [...this.waiters]) wake();
  }

  /** The sidecar's three routes. */
  async handle(path: string, raw: string, signal: AbortSignal): Promise<Reply> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw || '{}') as Record<string, unknown>;
    } catch {
      return reply(400, {error: 'Body must be JSON'});
    }
    const questionId = typeof body.questionId === 'string' && IDENTIFIER.test(body.questionId) ? body.questionId : undefined;
    if (!questionId) return reply(400, {error: 'questionId must be an identifier'});
    const known = this.questions.find((q) => q.questionId === questionId);
    if (path === QUESTION_PATHS.ask) {
      if (known) return reply(202, {});
      if (this.sealed) return reply(410, {});
      const questions = Array.isArray(body.questions) ? body.questions : [];
      const first = questions[0] as {question?: unknown} | undefined;
      if (questions.length < 1 || questions.length > 50 || typeof first?.question !== 'string') {
        return reply(400, {error: 'questions must hold 1 to 50 questions'});
      }
      this.questions = [...this.questions, {questionId, questions, summary: first.question.slice(0, 2000), state: 'asked'}];
      await this.persist(this.questions);
      return reply(202, {});
    }
    if (!known) return reply(404, {});
    if (path === QUESTION_PATHS.poll) return this.poll(questionId, signal);
    if (path === QUESTION_PATHS.received) {
      if (known.answerId === undefined || body.answerId !== known.answerId) return reply(409, {error: 'No such answer'});
      if (known.state === 'offered') await this.update(questionId, {state: 'received'});
      return reply(200, {});
    }
    return reply(404, {});
  }

  private async poll(questionId: string, signal: AbortSignal): Promise<Reply> {
    const until = this.monoMs() + this.holdMs;
    for (;;) {
      const current = this.questions.find((q) => q.questionId === questionId);
      if (current?.answerId && current.answers) return reply(200, {answerId: current.answerId, answers: current.answers});
      if (this.sealed) return reply(410, {});
      const left = until - this.monoMs();
      if (left <= 0 || signal.aborted) return reply(204);
      await this.waitForChange(left, signal);
    }
  }

  /** Resolves on the next change to any question, on abort, or after `ms`. */
  private waitForChange(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal.addEventListener('abort', done, {once: true});
    });
  }

  /**
   * One cycle against the server: open what was asked, pick up answers, record
   * receipts. Returns true when a blocking question has waited past the seal.
   */
  async tick(call: QuestionCall, workItemId: string, credential: QuestionCredential): Promise<boolean> {
    for (const q of this.questions.filter((entry) => entry.state === 'asked')) {
      const opened = await call('POST', `/api/v1/work-items/${workItemId}/runtime-requests/sync`, {...credential, observations: [{
        type: 'opened', providerRequestId: q.questionId, kind: 'user_input', blocking: true, category: null, summary: q.summary,
        detail: {questions: q.questions}}]}, {timeoutMs: 10_000}).catch(() => null);
      if (opened?.status === 200) await this.update(q.questionId, {state: 'opened', openedMono: this.monoMs()});
    }
    if (this.questions.some((q) => q.state === 'opened')) {
      // The workspace travels in the session's header, as for every other call.
      const listed = await call('GET', `/api/v1/work-items/${workItemId}/runtime-requests?delivery=pending`
        + `&runtimeId=${encodeURIComponent(credential.runtimeId)}&leaseGeneration=${credential.leaseGeneration}`,
      undefined, {timeoutMs: 10_000}).catch(() => null);
      const requests = (listed?.status === 200 ? listed.body.requests : []) as Array<{id?: string; providerRequestId?: string;
        resolution?: {answers?: Record<string, string | string[]>}}> | undefined;
      for (const request of requests ?? []) {
        const q = this.questions.find((entry) => entry.questionId === request.providerRequestId && entry.state === 'opened');
        if (!q || !request.id || !request.resolution?.answers) continue;
        await this.update(q.questionId, {state: 'offered', requestId: request.id, answers: request.resolution.answers,
          answerId: answerIdOf(request.id, request.resolution.answers)});
      }
    }
    await this.recordReceipts(call, workItemId, credential);
    const now = this.monoMs();
    if (this.questions.some((q) => q.state === 'opened' && q.openedMono !== undefined && now - q.openedMono >= QUESTION_SEAL_MS)) {
      this.sealed = true;
      for (const wake of [...this.waiters]) wake();
      return true;
    }
    return false;
  }

  private async recordReceipts(call: QuestionCall, workItemId: string, credential: QuestionCredential) {
    for (const q of this.questions.filter((entry) => entry.state === 'received' && entry.requestId)) {
      const recorded = await call('POST', `/api/v1/work-items/${workItemId}/runtime-requests/${q.requestId}/delivery`,
        {...credential, delivery: {outcome: 'delivered'}}, {key: `${q.requestId}:delivered`, timeoutMs: 10_000}).catch(() => null);
      if (recorded?.status === 200) await this.update(q.questionId, {state: 'acknowledged'});
    }
  }

  /**
   * At any stop, while the claim still holds: confirmed answers are recorded
   * delivered, unconfirmed offers failed, and the session's open requests
   * closed. Nothing is offered again.
   */
  async close(call: QuestionCall, workItemId: string, credential: QuestionCredential): Promise<void> {
    this.sealed = true;
    for (const wake of [...this.waiters]) wake();
    if (this.questions.length === 0) return;
    await this.recordReceipts(call, workItemId, credential);
    for (const q of this.questions.filter((entry) => entry.state === 'offered' && entry.requestId)) {
      await call('POST', `/api/v1/work-items/${workItemId}/runtime-requests/${q.requestId}/delivery`,
        {...credential, delivery: {outcome: 'failed', error: 'not_received'}}, {key: `${q.requestId}:not_received`, timeoutMs: 10_000})
        .catch(() => null);
    }
    await call('POST', `/api/v1/work-items/${workItemId}/runtime-requests/sync`, {...credential, observations: [{type: 'session_ended'}]},
      {timeoutMs: 10_000}).catch(() => null);
  }
}

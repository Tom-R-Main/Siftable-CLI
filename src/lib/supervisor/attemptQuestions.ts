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
/** Questions one attempt may ask; more are refused, so one cycle's work stays bounded. */
export const MAX_QUESTIONS = 20;
const POLL_HOLD_MS = 25_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface JournalQuestion {
  questionId: string;
  questions: unknown[];
  summary: string;
  state: 'asked' | 'opened' | 'offered' | 'received' | 'acknowledged';
  /** The server's own creation time for the request; the two-hour seal counts from it. */
  openedAt?: string;
  requestId?: string;
  answerId?: string;
  answers?: Record<string, string | string[]>;
}

export interface QuestionCredential {runtimeId: string; leaseGeneration: number; claimOwner: string; claimToken: string}

export type QuestionCall = (method: 'GET' | 'POST', route: string, body?: unknown, options?: {key?: string; timeoutMs?: number; signal?: AbortSignal})
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
    private readonly wallMs: () => number = () => Date.now(),
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
      if (this.questions.length >= MAX_QUESTIONS) return reply(429, {error: `At most ${MAX_QUESTIONS} questions per attempt`});
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
      if (opened?.status === 200) await this.update(q.questionId, {state: 'opened'});
    }
    // The seal counts from the server's creation time: a lost open reply or a retry never restarts it.
    if (this.questions.some((q) => q.state === 'opened' && !q.openedAt)) {
      const open = await call('GET', `/api/v1/work-items/${workItemId}/runtime-requests?open=true`, undefined, {timeoutMs: 10_000})
        .catch(() => null);
      const listed = (open?.status === 200 ? open.body.requests : []) as Array<{providerRequestId?: string; attemptId?: string;
        runtimeId?: string; createdAt?: string}> | undefined;
      for (const request of listed ?? []) {
        const q = this.questions.find((entry) => entry.questionId === request.providerRequestId && entry.state === 'opened' && !entry.openedAt);
        if (q && request.runtimeId === credential.runtimeId && typeof request.createdAt === 'string') {
          await this.update(q.questionId, {openedAt: request.createdAt});
        }
      }
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
    const now = this.wallMs();
    if (this.questions.some((q) => q.state === 'opened' && q.openedAt !== undefined && now - Date.parse(q.openedAt) >= QUESTION_SEAL_MS)) {
      this.sealed = true;
      for (const wake of [...this.waiters]) wake();
      return true;
    }
    return false;
  }

  /** Answers no more polls or questions. */
  seal(): void {
    this.sealed = true;
    for (const wake of [...this.waiters]) wake();
  }

  /** Records each received answer delivered, once per key; true when none is left unrecorded. */
  private async recordReceipts(call: QuestionCall, workItemId: string, credential: QuestionCredential,
    left: () => number = () => 10_000): Promise<boolean> {
    for (const q of this.questions.filter((entry) => entry.state === 'received' && entry.requestId)) {
      if (left() <= 0) return false;
      const recorded = await call('POST', `/api/v1/work-items/${workItemId}/runtime-requests/${q.requestId}/delivery`,
        {...credential, delivery: {outcome: 'delivered'}}, {key: `${q.requestId}:delivered`, timeoutMs: left()}).catch(() => null);
      if (recorded?.status === 200) await this.update(q.questionId, {state: 'acknowledged'});
    }
    return !this.questions.some((entry) => entry.state === 'received');
  }

  /**
   * At any stop, while the claim still holds, within `budgetMs`: received
   * answers are recorded delivered first, unconfirmed offers failed, and only
   * then is the session ended, since ending it fails every answer whose
   * delivery is still pending. Returns false when anything is left unrecorded:
   * the caller then keeps the attempt unsettled for the next start to finish
   * under the same claim. Nothing is offered again.
   */
  async close(call: QuestionCall, workItemId: string, credential: QuestionCredential, budgetMs = 30_000): Promise<boolean> {
    this.seal();
    if (this.questions.length === 0) return true;
    const until = this.monoMs() + budgetMs;
    const left = () => Math.floor(Math.min(10_000, until - this.monoMs()));
    if (!await this.recordReceipts(call, workItemId, credential, left)) return false;
    for (const q of this.questions.filter((entry) => entry.state === 'offered' && entry.requestId)) {
      if (left() <= 0) return false;
      await call('POST', `/api/v1/work-items/${workItemId}/runtime-requests/${q.requestId}/delivery`,
        {...credential, delivery: {outcome: 'failed', error: 'not_received'}}, {key: `${q.requestId}:not_received`, timeoutMs: left()})
        .catch(() => null);
    }
    if (left() <= 0) return false;
    const ended = await call('POST', `/api/v1/work-items/${workItemId}/runtime-requests/sync`,
      {...credential, observations: [{type: 'session_ended'}]}, {timeoutMs: left()}).catch(() => null);
    return ended?.status === 200;
  }
}

/** Closes a recovered attempt's questions under its recovered claim, journaling progress; false leaves it unsettled. */
export function closeRecoveredQuestions(questions: JournalQuestion[], persist: (questions: JournalQuestion[]) => Promise<void>,
  monoMs: () => number, call: QuestionCall, workItemId: string, credential: QuestionCredential, budgetMs: number): Promise<boolean> {
  return new QuestionDesk(questions, persist, monoMs).close(call, workItemId, credential, budgetMs);
}

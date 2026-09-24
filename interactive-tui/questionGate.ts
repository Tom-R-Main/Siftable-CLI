/**
 * Question gate: the model asks the connected client a question and waits for
 * the answer. It mirrors confirmGate's request-id round trip. A listener is
 * registered only by a host that can deliver the question to a person (today
 * the session-mode wire protocol); without one, `requestAnswer` declines
 * immediately, so a question can never hang a noninteractive run.
 */
import { randomUUID } from 'node:crypto';

export interface QuestionSpec {
  question: string;
  /** Optional suggested answers; the client may still answer freely. */
  options?: string[];
}

export interface QuestionRequest extends QuestionSpec {
  id: string;
}

export type QuestionOutcome =
  | { answered: true; answer: string }
  | { answered: false; reason: 'no_client' | 'cancelled' | 'declined' };

type Listener = (request: QuestionRequest) => void;
type CancellationListener = (id: string) => void;

interface PendingQuestion {
  resolve: (outcome: QuestionOutcome) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

let listener: Listener | null = null;
let cancellationListener: CancellationListener | null = null;
const pending = new Map<string, PendingQuestion>();

export function setQuestionListener(next: Listener | null): void {
  listener = next;
}

export function setQuestionCancellationListener(next: CancellationListener | null): void {
  cancellationListener = next;
}

export function hasQuestionListener(): boolean {
  return listener !== null;
}

function notifyCancellation(id: string): void {
  try { cancellationListener?.(id); } catch { /* best effort; never keeps a question pending */ }
}

/** Ask the client. Never rejects; an abort or missing client declines. */
export function requestAnswer(spec: QuestionSpec, signal?: AbortSignal): Promise<QuestionOutcome> {
  if (signal?.aborted) return Promise.resolve({answered: false, reason: 'cancelled'});
  const active = listener;
  if (!active) return Promise.resolve({answered: false, reason: 'no_client'});
  const id = randomUUID();
  return new Promise<QuestionOutcome>((resolve) => {
    const entry: PendingQuestion = {resolve, signal};
    if (signal) {
      entry.onAbort = () => {
        if (pending.get(id) !== entry) return;
        pending.delete(id);
        notifyCancellation(id);
        resolve({answered: false, reason: 'cancelled'});
      };
      signal.addEventListener('abort', entry.onAbort, {once: true});
    }
    pending.set(id, entry);
    try {
      active({...spec, id});
    } catch {
      if (pending.get(id) !== entry) return;
      pending.delete(id);
      if (signal && entry.onAbort) signal.removeEventListener('abort', entry.onAbort);
      notifyCancellation(id);
      resolve({answered: false, reason: 'no_client'});
    }
  });
}

/**
 * Deliver an answer (or a decline, with `answer === null`). Returns false for
 * an unknown or already-settled id, so a duplicate answer is never applied.
 */
export function resolveQuestion(id: string, answer: string | null): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
  if (entry.signal?.aborted) {
    entry.resolve({answered: false, reason: 'cancelled'});
    return true;
  }
  entry.resolve(answer === null ? {answered: false, reason: 'declined'} : {answered: true, answer});
  return true;
}

/** Decline and clear every pending question (teardown). */
export function rejectAllQuestions(): void {
  const revoked = [...pending.entries()];
  pending.clear();
  for (const [, entry] of revoked) {
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
  }
  for (const [id, entry] of revoked) {
    entry.resolve({answered: false, reason: 'cancelled'});
    notifyCancellation(id);
  }
}

export function pendingQuestionCount(): number {
  return pending.size;
}

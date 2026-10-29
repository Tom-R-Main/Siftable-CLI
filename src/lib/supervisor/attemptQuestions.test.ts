import {describe, expect, it} from 'vitest';
import {answerIdOf, type JournalQuestion, QUESTION_PATHS, QUESTION_SEAL_MS, QuestionDesk, type QuestionCall} from './attemptQuestions.js';

const credential = {runtimeId: 'machine:e:d', leaseGeneration: 1, claimOwner: 'mobile-runner:r', claimToken: 'claim'};
const ask = {questionId: 'q-1', questions: [{id: 'name', header: 'Name', question: 'Which branch?', options: []}]};
const answers = {name: 'main'};

/** The server's runtime-request routes, recording what the supervisor sent. */
function server(options: {answered?: boolean; openedAt?: string; deliveryStatus?: number} = {}) {
  const sent: Array<{route: string; body?: unknown; key?: string}> = [];
  let answered = options.answered ?? false;
  const call: QuestionCall = async (_method, route, body, opts) => {
    sent.push({route, body, key: opts?.key});
    if (route.includes('open=true')) {
      return {status: 200, body: {requests: [{providerRequestId: 'q-1', runtimeId: credential.runtimeId, createdAt: options.openedAt ?? new Date().toISOString()}]}};
    }
    if (route.includes('delivery=pending')) {
      return {status: 200, body: {requests: answered ? [{id: 'req-1', providerRequestId: 'q-1', resolution: {answers}}] : []}};
    }
    if (route.endsWith('/delivery') && options.deliveryStatus) return {status: options.deliveryStatus, body: {}};
    return {status: 200, body: {}};
  };
  return {sent, call, answer: () => { answered = true; }};
}

function desk(monoMs = () => performance.now(), holdMs = 50) {
  const journaled: JournalQuestion[][] = [];
  const d = new QuestionDesk([], async (questions) => { journaled.push(questions); }, monoMs, holdMs);
  return {d, journaled};
}
const send = (d: QuestionDesk, path: string, body: object, signal = new AbortController().signal) => d.handle(path, JSON.stringify(body), signal);

describe('QuestionDesk', () => {
  it('opens a question, hands the answer to the writer, and records delivery once on its receipt', async () => {
    const {d, journaled} = desk();
    const api = server();
    expect(await send(d, QUESTION_PATHS.ask, ask)).toEqual({status: 202, body: '{}'});
    expect(await send(d, QUESTION_PATHS.ask, ask)).toEqual({status: 202, body: '{}'});
    expect(d.list()).toHaveLength(1);
    expect(journaled.at(-1)?.[0]).toMatchObject({questionId: 'q-1', state: 'asked'});
    // Opened as a blocking user_input request; no answer yet, so the poll ends empty.
    expect(await d.tick(api.call, 'w-1', credential)).toBe(false);
    expect(api.sent[0]).toMatchObject({route: '/api/v1/work-items/w-1/runtime-requests/sync', body: {...credential,
      observations: [{type: 'opened', providerRequestId: 'q-1', kind: 'user_input', blocking: true, summary: 'Which branch?',
        detail: {questions: ask.questions}}]}});
    expect(await send(d, QUESTION_PATHS.poll, {questionId: 'q-1'})).toEqual({status: 204, body: ''});
    // A waiting poll is answered as soon as the answer arrives.
    api.answer();
    const waiting = new QuestionDesk(d.list(), async () => undefined, () => performance.now(), 5_000);
    const pending = send(waiting, QUESTION_PATHS.poll, {questionId: 'q-1'});
    await waiting.tick(api.call, 'w-1', credential);
    const answerId = answerIdOf('req-1', answers);
    expect(await pending).toEqual({status: 200, body: JSON.stringify({answerId, answers})});
    // Only the writer's receipt of that answer is delivery; it is recorded once, under a fixed key.
    expect((await send(waiting, QUESTION_PATHS.received, {questionId: 'q-1', answerId: 'other'})).status).toBe(409);
    expect((await send(waiting, QUESTION_PATHS.received, {questionId: 'q-1', answerId})).status).toBe(200);
    await waiting.tick(api.call, 'w-1', credential);
    await waiting.tick(api.call, 'w-1', credential);
    const deliveries = api.sent.filter((s) => s.route.endsWith('/delivery'));
    expect(deliveries).toEqual([{route: '/api/v1/work-items/w-1/runtime-requests/req-1/delivery',
      body: {...credential, delivery: {outcome: 'delivered'}}, key: 'req-1:delivered'}]);
    expect(waiting.list()[0].state).toBe('acknowledged');
  });

  it('seals a blocking question two hours after the server opened it, whatever the local clock saw', async () => {
    const opened = Date.parse('2026-10-29T00:00:00.000Z');
    let wall = opened + QUESTION_SEAL_MS - 1;
    const d = new QuestionDesk([], async () => undefined, () => performance.now(), 50, () => wall);
    const api = server({openedAt: '2026-10-29T00:00:00.000Z'});
    await send(d, QUESTION_PATHS.ask, ask);
    expect(await d.tick(api.call, 'w-1', credential)).toBe(false);
    expect(d.list()[0].openedAt).toBe('2026-10-29T00:00:00.000Z');
    wall = opened + QUESTION_SEAL_MS;
    expect(await d.tick(api.call, 'w-1', credential)).toBe(true);
    expect((await send(d, QUESTION_PATHS.poll, {questionId: 'q-1'})).status).toBe(410);
    expect((await send(d, QUESTION_PATHS.ask, {...ask, questionId: 'q-2'})).status).toBe(410);
    // A replayed open of a request the server created two hours ago seals at once.
    const late = new QuestionDesk([], async () => undefined, () => performance.now(), 50, () => opened + QUESTION_SEAL_MS + 1);
    await send(late, QUESTION_PATHS.ask, ask);
    expect(await late.tick(api.call, 'w-1', credential)).toBe(true);
  });

  it('at a stop, records a received answer delivered and an unconfirmed one failed, then ends the session', async () => {
    const api = server({answered: true});
    const received: JournalQuestion = {questionId: 'q-1', questions: ask.questions, summary: 's', state: 'received', requestId: 'req-1',
      answerId: 'a', answers};
    const offered: JournalQuestion = {...received, questionId: 'q-2', state: 'offered', requestId: 'req-2'};
    const d = new QuestionDesk([received, offered], async () => undefined, () => 0);
    expect(await d.close(api.call, 'w-1', credential)).toBe(true);
    expect(api.sent.map((s) => [s.route.split('/').slice(-2).join('/'), s.key, (s.body as {delivery?: unknown}).delivery
      ?? (s.body as {observations?: unknown}).observations])).toEqual([
      // Receipts first: ending the session fails every answer whose delivery is still pending.
      ['req-1/delivery', 'req-1:delivered', {outcome: 'delivered'}],
      ['req-2/delivery', 'req-2:not_received', {outcome: 'failed', error: 'not_received'}],
      ['runtime-requests/sync', undefined, [{type: 'session_ended'}]],
    ]);
    // Nothing is offered again after a stop.
    expect((await d.handle(QUESTION_PATHS.poll, JSON.stringify({questionId: 'q-3'}), new AbortController().signal)).status).toBe(404);
  });

  it('refuses malformed questions', async () => {
    const {d} = desk();
    expect((await send(d, QUESTION_PATHS.ask, {questionId: 'bad id', questions: ask.questions})).status).toBe(400);
    expect((await send(d, QUESTION_PATHS.ask, {questionId: 'q-1', questions: []})).status).toBe(400);
    expect((await d.handle(QUESTION_PATHS.ask, 'not json', new AbortController().signal)).status).toBe(400);
  });

  it('stops closing once its budget is spent, and says so', async () => {
    let now = 0;
    const sent: string[] = [];
    const call: QuestionCall = async (_method, route) => { sent.push(route.split('/').slice(-2).join('/')); now += 3_000; return {status: 200, body: {}}; };
    const offered: JournalQuestion = {questionId: 'q-1', questions: [], summary: 's', state: 'offered', requestId: 'req-1', answerId: 'a', answers};
    const d = new QuestionDesk([offered, {...offered, questionId: 'q-2', requestId: 'req-2'}, {...offered, questionId: 'q-3', requestId: 'req-3'}],
      async () => undefined, () => now);
    expect(await d.close(call, 'w-1', credential, 5_000)).toBe(false);
    expect(sent).toEqual(['req-1/delivery', 'req-2/delivery']);
  });

  it('never ends the session while a received answer is unrecorded', async () => {
    const api = server({deliveryStatus: 503});
    const received: JournalQuestion = {questionId: 'q-1', questions: [], summary: 's', state: 'received', requestId: 'req-1', answerId: 'a', answers};
    const d = new QuestionDesk([received], async () => undefined, () => performance.now());
    expect(await d.close(api.call, 'w-1', credential)).toBe(false);
    expect(api.sent.map((s) => s.route.split('/').at(-1))).toEqual(['delivery']);
    expect(d.list()[0].state).toBe('received');
  });

  it('refuses a question beyond the per-attempt limit', async () => {
    const {d} = desk();
    for (let i = 0; i < 20; i += 1) expect((await send(d, QUESTION_PATHS.ask, {...ask, questionId: `q-${i}`})).status).toBe(202);
    expect((await send(d, QUESTION_PATHS.ask, {...ask, questionId: 'q-20'})).status).toBe(429);
  });
});

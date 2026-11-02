import {describe, expect, it} from 'vitest';
import {attemptRelayHandler} from './modelRelayHandler.js';
import {QuestionDesk} from './attemptQuestions.js';
import {DIAGNOSTIC_PATH, MODEL_PATHS, QUESTION_PATHS} from './relaySidecar.js';

const target = {
  apiUrl: 'https://api.example', token: 'pat-value', workspaceId: '11111111-1111-4111-8111-111111111111',
  workItemId: '22222222-2222-4222-8222-222222222222', attemptId: '33333333-3333-4333-8333-333333333333', claimToken: 'claim-value',
};
const frame = (path: string, method = 'POST', body = '{"model":"m"}') => ({id: 1, method, path, body: Buffer.from(body).toString('base64')});
const signal = new AbortController().signal;

function control(open = true) {
  let seq = 0;
  return {open: () => open, nextCallId: async () => `${target.attemptId}:${++seq}`};
}

describe('attemptRelayHandler', () => {
  it('answers the diagnostic route with the nonce, before and after the start', async () => {
    const handler = attemptRelayHandler({fetch: (() => { throw new Error('no fetch'); }) as never, diagnosticNonce: 'n1'}, target, control(false));
    expect(await handler(frame(DIAGNOSTIC_PATH, 'GET', ''), signal)).toEqual({status: 200, body: JSON.stringify({nonce: 'n1'})});
  });

  it('keeps model calls closed until the attempt is open, without spending a call ID', async () => {
    const ids: string[] = [];
    const handler = attemptRelayHandler({fetch: (() => { throw new Error('no fetch'); }) as never, diagnosticNonce: 'n'}, target,
      {open: () => false, nextCallId: async () => { ids.push('x'); return 'x'; }});
    expect((await handler(frame(MODEL_PATHS.anthropic), signal)).status).toBe(503);
    expect(ids).toEqual([]);
  });

  it('forwards to the attempt relay with the supervisor\'s credential, claim, role, call ID and workspace', async () => {
    const seen: Array<{url: string; init: RequestInit}> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({url, init});
      return new Response('event: done\n\n', {status: 200});
    }) as unknown as typeof fetch;
    const handler = attemptRelayHandler({fetch: fetchImpl, diagnosticNonce: 'n'}, target, control());
    const answer = await handler(frame(MODEL_PATHS.openai), signal);
    expect(answer.status).toBe(200);
    expect('stream' in answer).toBe(true);
    expect(seen[0].url).toBe(`https://api.example/api/v1/work-items/${target.workItemId}/execution-attempts/${target.attemptId}/model/openai/v1/responses`);
    expect(seen[0].init.headers).toEqual({
      'Authorization': 'Bearer pat-value', 'Content-Type': 'application/json', 'X-Sift-Claim-Token': 'claim-value',
      'X-Sift-Model-Role': 'writer', 'Idempotency-Key': `${target.attemptId}:1`, 'X-Workspace-Id': target.workspaceId,
    });
    expect(Buffer.from(seen[0].init.body as Buffer).toString()).toBe('{"model":"m"}');
  });

  it('never retries a call whose delivery is unknown, and passes relay refusals through', async () => {
    let calls = 0;
    const lost = attemptRelayHandler({fetch: (async () => { calls += 1; throw new TypeError('fetch failed'); }) as never, diagnosticNonce: 'n'}, target, control());
    expect((await lost(frame(MODEL_PATHS.anthropic), signal)).status).toBe(502);
    expect(calls).toBe(1);
    const refused = attemptRelayHandler({fetch: (async () => new Response('{"detail":"duplicate"}', {status: 409})) as never, diagnosticNonce: 'n'}, target, control());
    const answer = await refused(frame(MODEL_PATHS.anthropic), signal);
    expect(answer).toMatchObject({status: 409});
    expect(String((answer as {body: Buffer}).body)).not.toContain('pat-value');
  });

  it('as the reviewer (U3-2): sends role reviewer, reaches only the Responses route, and never the writer\'s questions', async () => {
    const roles: Array<string | null> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      roles.push(new Headers(init.headers).get('X-Sift-Model-Role'));
      return new Response('event: done\n\n', {status: 200});
    }) as unknown as typeof fetch;
    const desk = new QuestionDesk([], async () => undefined, () => 0);
    const reviewer = attemptRelayHandler({fetch: fetchImpl, diagnosticNonce: 'n'}, {...target, role: 'reviewer'}, {...control(), questions: desk});
    expect((await reviewer(frame(MODEL_PATHS.openai), signal)).status).toBe(200);
    expect((await reviewer(frame(MODEL_PATHS.anthropic), signal)).status).toBe(404);
    for (const path of Object.values(QUESTION_PATHS)) expect((await reviewer(frame(path), signal)).status, path).toBe(404);
    const writer = attemptRelayHandler({fetch: fetchImpl, diagnosticNonce: 'n'}, target, control());
    expect((await writer(frame(MODEL_PATHS.anthropic), signal)).status).toBe(200);
    expect(roles).toEqual(['reviewer', 'writer']);
  });

  it('refuses routes outside the fixed list', async () => {
    const handler = attemptRelayHandler({fetch: (() => { throw new Error('no fetch'); }) as never, diagnosticNonce: 'n'}, target, control());
    expect((await handler(frame('/sift/v1/model/other'), signal)).status).toBe(404);
    expect((await handler(frame(MODEL_PATHS.anthropic, 'GET'), signal)).status).toBe(404);
  });

  it('routes the writer\'s questions to the desk only while the attempt is running, never to the API', async () => {
    const noFetch = (() => { throw new Error('no fetch'); }) as never;
    const desk = new QuestionDesk([], async () => undefined, () => performance.now());
    const ask = frame(QUESTION_PATHS.ask, 'POST', JSON.stringify({questionId: 'q-1', questions: [{id: 'branch', header: 'Branch', question: 'Which branch?', options: []}]}));
    const closed = attemptRelayHandler({fetch: noFetch, diagnosticNonce: 'n'}, target, {...control(false), questions: desk});
    expect((await closed(ask, signal)).status).toBe(503);
    expect(desk.list()).toEqual([]);
    const running = attemptRelayHandler({fetch: noFetch, diagnosticNonce: 'n'}, target, {...control(), questions: desk});
    expect((await running(ask, signal)).status).toBe(202);
    expect(desk.list().map((q) => q.questionId)).toEqual(['q-1']);
  });
});

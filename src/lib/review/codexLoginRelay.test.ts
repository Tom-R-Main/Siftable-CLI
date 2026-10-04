import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {CodexLoginError, codexAuthPath, parseCodexLogin, readCodexLogin, startCodexLoginRelay, type CodexLoginRelay} from './codexLoginRelay.js';

const ACCOUNT = '00000000-1111-2222-3333-444444444444';

function jwt(exp: number): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({alg: 'none'})}.${part({exp})}.signature-part-xx`;
}

const future = Math.floor(Date.now() / 1000) + 3600;
const chatgptAuth = (exp = future) => JSON.stringify({auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: {id_token: 'x', access_token: jwt(exp), refresh_token: 'r', account_id: ACCOUNT}});

describe('Codex login parsing', () => {
  it('builds the same credential headers as the controller gateway file', () => {
    const login = parseCodexLogin(chatgptAuth());
    expect(login.kind).toBe('chatgpt');
    expect(login.upstreamUrl).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(Object.keys(login.headers).sort()).toEqual(['authorization', 'chatgpt-account-id', 'originator']);
    expect(login.headers.originator).toBe('codex_cli_rs');
    expect(login.expiresAt?.getTime()).toBe(future * 1000);
  });

  it('refuses an expired token without refreshing it and never echoes it', () => {
    const expired = chatgptAuth(Math.floor(Date.now() / 1000) - 10);
    let message = '';
    try {
      parseCodexLogin(expired);
    } catch (error) {
      expect(error).toBeInstanceOf(CodexLoginError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/expired/u);
    expect(message).not.toContain(jwt(Math.floor(Date.now() / 1000) - 10).slice(0, 20));
  });

  it('accepts an API key login and rejects malformed files', () => {
    expect(parseCodexLogin(JSON.stringify({OPENAI_API_KEY: 'sk-test-0123456789'})).upstreamUrl).toBe('https://api.openai.com/v1/responses');
    expect(() => parseCodexLogin('not json')).toThrow(CodexLoginError);
    expect(() => parseCodexLogin('{}')).toThrow(/No usable Codex login/u);
    expect(() => parseCodexLogin(JSON.stringify({tokens: {access_token: 'bad token with spaces', account_id: ACCOUNT}}))).toThrow(/malformed/u);
  });

  it('reads $CODEX_HOME/auth.json and explains a missing file', () => {
    const home = mkdtempSync(join(tmpdir(), 'sift-codex-home-'));
    try {
      expect(codexAuthPath({CODEX_HOME: home})).toBe(join(home, 'auth.json'));
      expect(() => readCodexLogin(join(home, 'auth.json'))).toThrow(/codex login/u);
      writeFileSync(join(home, 'auth.json'), chatgptAuth());
      expect(readCodexLogin(join(home, 'auth.json')).kind).toBe('chatgpt');
    } finally {
      rmSync(home, {recursive: true, force: true});
    }
  });
});

describe('Codex login relay', () => {
  let relay: CodexLoginRelay | undefined;
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  function fakeUpstream(status: number, body: string) {
    const calls: {url: string; headers: Record<string, string>; body: Record<string, unknown>}[] = [];
    const doFetch = (async (url: string, init: RequestInit) => {
      calls.push({url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown>});
      return new Response(body, {status, headers: {'content-type': status === 200 ? 'text/event-stream' : 'application/json'}});
    }) as unknown as typeof fetch;
    return {calls, doFetch};
  }

  it('forwards only POST <base>/responses for the configured model, with the credential added and the output cap removed', async () => {
    const upstream = fakeUpstream(200, 'event: response.completed\ndata: {"type":"response.completed"}\n\n');
    const login = parseCodexLogin(chatgptAuth());
    relay = await startCodexLoginRelay({login, model: 'gpt-6.1-sol', fetch: upstream.doFetch});
    expect(relay.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/v1$/u);

    const ok = await fetch(`${relay.baseUrl}/responses`, {method: 'POST', body: JSON.stringify({model: 'gpt-6.1-sol', stream: true, input: 'hi', max_output_tokens: 10})});
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('response.completed');
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(upstream.calls[0]?.headers.authorization).toBe(login.headers.authorization);
    expect(upstream.calls[0]?.body).toEqual({model: 'gpt-6.1-sol', stream: true, input: 'hi'});

    const wrongModel = await fetch(`${relay.baseUrl}/responses`, {method: 'POST', body: JSON.stringify({model: 'other', stream: true})});
    expect(wrongModel.status).toBe(400);
    const wrongPath = await fetch(`${relay.baseUrl.replace(/\/v1$/u, '')}/other/v1/responses`, {method: 'POST', body: '{}'});
    expect(wrongPath.status).toBe(404);
    const get = await fetch(`${relay.baseUrl}/responses`);
    expect(get.status).toBe(404);
    expect(upstream.calls).toHaveLength(1);
    expect(relay.stats).toMatchObject({requests: 1, refused: 3, clientClosed: 0, upstreamStatuses: {200: 1}});
  });

  it('replaces an upstream error body with fixed text, so nothing upstream reflects reaches codex', async () => {
    const login = parseCodexLogin(chatgptAuth());
    const upstream = fakeUpstream(401, JSON.stringify({error: login.headers.authorization}));
    relay = await startCodexLoginRelay({login, model: 'gpt-6.1-sol', fetch: upstream.doFetch});
    const response = await fetch(`${relay.baseUrl}/responses`, {method: 'POST', body: JSON.stringify({model: 'gpt-6.1-sol', stream: true})});
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).toBe(JSON.stringify({error: {type: 'sift_review_relay', code: 'upstream_401'}}));
    expect(relay.stats.upstreamStatuses).toEqual({401: 1});
  });
});

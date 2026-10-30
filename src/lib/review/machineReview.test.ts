import {describe, expect, it} from 'vitest';
import {REVIEW_RESULT_VERSION, runMachineReview, startForwarder, verifiedTreeGit} from './machineReview.js';
import type {LocalReviewDeps, LocalReviewOptions} from './localReview.js';
import type {GitExec, TasterRuntime} from './runtime.js';

const RELAY = 'http://sift-a-r1-review-relay:8787/sift/v1/model/openai/v1/responses';
const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);

describe('machine review (U3-2)', () => {
  it('runs every git call against the verified tree and its own git directory, whatever the caller passes', async () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const git: GitExec = async (_args, options) => { seen.push(options.env); return {code: 0, stdout: Buffer.alloc(0), stderr: '', truncated: false}; };
    await verifiedTreeGit(git)(['rev-parse', 'HEAD'], {cwd: '/verify/src', env: {GIT_DIR: '/elsewhere', LC_ALL: 'C'}});
    expect(seen[0]).toEqual({GIT_DIR: '/verify/g', GIT_WORK_TREE: '/verify/src', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C'});
  });

  it('forwards only POST /v1/responses to the relay, body and type intact, and streams the reply back', async () => {
    const calls: Array<{url: string; body: string; type: string | null}> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({url, body: Buffer.from(init.body as Uint8Array).toString(), type: new Headers(init.headers).get('content-type')});
      return new Response(new ReadableStream({start(controller) {
        controller.enqueue(new TextEncoder().encode('event: a\n\n'));
        controller.enqueue(new TextEncoder().encode('event: done\n\n'));
        controller.close();
      }}), {status: 200, headers: {'content-type': 'text/event-stream'}});
    }) as unknown as typeof fetch;
    const {baseUrl, server} = await startForwarder(RELAY, fetchImpl);
    try {
      expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      const reply = await fetch(`${baseUrl}/responses`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{"model":"m"}'});
      expect(reply.status).toBe(200);
      expect(reply.headers.get('content-type')).toBe('text/event-stream');
      expect(await reply.text()).toBe('event: a\n\nevent: done\n\n');
      expect(calls).toEqual([{url: RELAY, body: '{"model":"m"}', type: 'application/json'}]);
      expect((await fetch(`${baseUrl}/models`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/responses`)).status).toBe(404);
      expect((await fetch(`${baseUrl.replace('/v1', '')}/sift/v1/questions`, {method: 'POST', body: '{}'})).status).toBe(404);
      expect(calls).toHaveLength(1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // Release R12: a relay that drops mid-stream breaks the client's stream; nothing escapes as an unhandled rejection.
  it('breaks the stream when the relay drops after one chunk, and keeps serving', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      let sent = false;
      return new Response(new ReadableStream({pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('event: a\n\n')); return; }
        controller.error(new Error('relay connection reset'));
      }}), {status: 200, headers: {'content-type': 'text/event-stream'}});
    }) as unknown as typeof fetch;
    const {baseUrl, server} = await startForwarder(RELAY, fetchImpl);
    try {
      // Broken either before the headers or during the body, never read as complete.
      const outcome = await fetch(`${baseUrl}/responses`, {method: 'POST', body: '{}'}).then((reply) => reply.text())
        .then(() => 'complete', () => 'broken');
      expect(outcome).toBe('broken');
      // The forwarder is still up for the next call.
      await fetch(`${baseUrl}/responses`, {method: 'POST', body: '{}'}).then((reply) => reply.text()).catch(() => undefined);
      expect(calls).toBe(2);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reviews exactly the result head against the base, in proxy mode, and reports the receipt in one result', async () => {
    let options: LocalReviewOptions | undefined;
    let used: LocalReviewDeps | undefined;
    const receipt = {schema: 'taster.local-receipt/v1', verdict: {kind: 'complete', reviewedSha: HEAD}};
    const git: GitExec = async () => ({code: 0, stdout: Buffer.alloc(0), stderr: '', truncated: false});
    const result = await runMachineReview({baseSha: BASE, head: HEAD, model: 'gpt-6.1-sol'}, {
      runtime: {} as TasterRuntime, git, gitBin: '/usr/bin/git', codexBin: '/usr/local/bin/codex', path: '/usr/bin:/bin', relayResponsesUrl: RELAY,
      review: async (o, d) => { options = o; used = d; return {receipt, result: null} as never; },
    });
    expect(result).toEqual({version: REVIEW_RESULT_VERSION, ok: true, receipt});
    expect(options).toMatchObject({cwd: '/verify/src', baseRef: BASE, expectedHead: HEAD, model: 'gpt-6.1-sol', provider: 'codex-proxy'});
    // The engine's git is the verified-tree runner, not the raw one.
    expect(used?.git).not.toBe(git);
    const failed = await runMachineReview({baseSha: BASE, head: HEAD, model: 'm'}, {
      runtime: {} as TasterRuntime, git, gitBin: '/usr/bin/git', codexBin: '/c', path: '/usr/bin', relayResponsesUrl: RELAY,
      review: async () => { throw new Error('--expected-head must match'); },
    });
    expect(failed).toMatchObject({version: REVIEW_RESULT_VERSION, ok: false, code: 'review_failed', detail: '--expected-head must match'});
  });
});

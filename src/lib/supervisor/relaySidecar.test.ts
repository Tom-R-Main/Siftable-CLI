import type {Server} from 'node:http';
import {PassThrough} from 'node:stream';
import {afterEach, describe, expect, it} from 'vitest';
import {DIAGNOSTIC_PATH, MODEL_PATHS, startRelaySidecar} from './relaySidecar.js';
import {diagnosticHandler, serveSidecarFrames} from './sidecarBridge.js';

let server: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(() => resolve(undefined)) : resolve(undefined)));
  server = undefined;
});

/** The sidecar and the supervisor's bridge, joined through pipes as `docker start --attach --interactive` joins them. */
async function wired(handler = diagnosticHandler('supervisor-nonce', DIAGNOSTIC_PATH)) {
  const toSidecar = new PassThrough();
  const fromSidecar = new PassThrough();
  const forwarded: string[] = [];
  fromSidecar.on('data', (chunk: Buffer) => forwarded.push(chunk.toString()));
  server = startRelaySidecar({input: toSidecar, output: fromSidecar}, 0);
  await new Promise((resolve) => server!.once('listening', resolve));
  serveSidecarFrames(fromSidecar, toSidecar, handler);
  return {base: `http://127.0.0.1:${(server.address() as {port: number}).port}`, forwarded};
}

describe('relay sidecar and bridge', () => {
  it('returns the supervisor\'s nonce on the diagnostic route, proving the path end to end', async () => {
    const {base} = await wired();
    const response = await fetch(`${base}${DIAGNOSTIC_PATH}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({nonce: 'supervisor-nonce'});
  });

  it('answers every other route itself with 404 and forwards nothing', async () => {
    const {base, forwarded} = await wired();
    expect((await fetch(`${base}/v1/messages`, {method: 'POST', body: '{}'})).status).toBe(404);
    expect((await fetch(`${base}${DIAGNOSTIC_PATH}`, {method: 'POST', body: '{}'})).status).toBe(404);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect(forwarded).toEqual([]);
  });

  it('turns a failing supervisor handler into 502, not a hang', async () => {
    const {base} = await wired(async () => { throw new Error('relay down'); });
    expect((await fetch(`${base}${DIAGNOSTIC_PATH}`)).status).toBe(502);
  });

  it('forwards a model request body and streams the answer back in order', async () => {
    let received = '';
    const {base} = await wired(async (frame) => {
      received = Buffer.from(frame.body, 'base64').toString();
      async function* events() {
        yield Buffer.from('event: a\n\n');
        yield Buffer.alloc(200 * 1024, 'x');
        yield Buffer.from('event: done\n\n');
      }
      return {status: 200, stream: events()};
    });
    const response = await fetch(`${base}${MODEL_PATHS.anthropic}`, {method: 'POST', body: '{"model":"m"}'});
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(received).toBe('{"model":"m"}');
    expect(text.startsWith('event: a\n\n')).toBe(true);
    expect(text.endsWith('event: done\n\n')).toBe(true);
    expect(text.length).toBe('event: a\n\n'.length + 200 * 1024 + 'event: done\n\n'.length);
  });

  it('cancels the supervisor\'s call when the agent disconnects mid-stream', async () => {
    let aborted: () => void = () => {};
    const abortedPromise = new Promise<void>((resolve) => { aborted = resolve; });
    const {base} = await wired(async (_frame, signal) => {
      signal.addEventListener('abort', () => aborted());
      async function* events() {
        yield Buffer.from('event: a\n\n');
        await abortedPromise;
      }
      return {status: 200, stream: events()};
    });
    const controller = new AbortController();
    const response = await fetch(`${base}${MODEL_PATHS.openai}`, {method: 'POST', body: '{}', signal: controller.signal});
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(abortedPromise).resolves.toBeUndefined();
  });

  it('ends a broken upstream stream as a broken response, never a clean one', async () => {
    const {base} = await wired(async () => {
      async function* events() {
        yield Buffer.from('event: a\n\n');
        throw new Error('upstream reset');
      }
      return {status: 200, stream: events()};
    });
    // Depending on timing the connection breaks before or after the head; either way it never ends cleanly.
    await expect(fetch(`${base}${MODEL_PATHS.anthropic}`, {method: 'POST', body: '{}'}).then((response) => response.text())).rejects.toThrow();
  });
});

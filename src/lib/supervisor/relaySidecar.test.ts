import type {Server} from 'node:http';
import {PassThrough} from 'node:stream';
import {afterEach, describe, expect, it} from 'vitest';
import {DIAGNOSTIC_PATH, startRelaySidecar} from './relaySidecar.js';
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
});

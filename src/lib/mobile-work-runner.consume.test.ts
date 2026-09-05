import {createServer, type ServerResponse} from 'node:http';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {consumeMobileDispatch, withMobileRunnerRequestTimeout, type MobileRunnerOptions, type MobileRunnerApi} from './mobile-work-runner';
import {listenForMobileWork} from './mobile-work-listener';

const runnerId = '11111111-1111-4111-8111-111111111111';
const dispatchId = '22222222-2222-4222-8222-222222222222';
const workItemId = '33333333-3333-4333-8333-333333333333';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}
function fakeClock() {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Synthetic timeout', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
  return () => { timeout.mockRestore(); vi.useRealTimers(); };
}

async function committedClaimFixture(honorsAbort: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'mobile-consume-deadline-'));
  const marker = join(directory, 'executions');
  const bodyStarted = deferred<void>();
  const bodyCompleted = deferred<void>();
  let heldBody: ServerResponse | undefined;
  const consumers: string[] = [];
  let committedClaims = 0, runnerHeartbeats = 0, reviews = 0, leaseExpiresAt = 0;
  const claim = {dispatch: {id: dispatchId, workItemId}, workItem: {id: workItemId, claimToken: 'synthetic-claim-lease'}, controls: []};
  const responseJson = JSON.stringify(claim);
  // A real response commits the server claim, then stalls during JSON transfer.
  // Virtual time models the same 300s lease as the actual server service.
  const server = createServer(async (req, res) => {
    let bytes = '';
    for await (const chunk of req) bytes += chunk;
    const body = JSON.parse(bytes || '{}');
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.endsWith('/consume')) {
      consumers.push(body.consumerId);
      if (committedClaims === 0) {
        committedClaims = 1; leaseExpiresAt = Date.now() + 300_000; heldBody = res;
        res.writeHead(200); res.write(responseJson.slice(0, 12)); return;
      }
      if (body.consumerId !== consumers[0] || Date.now() >= leaseExpiresAt) {
        res.writeHead(409); res.end('{}'); return;
      }
      res.end(responseJson); return;
    }
    if (req.url === '/api/v1/work-items/runners/heartbeat') runnerHeartbeats += 1;
    else if (req.url?.endsWith('/heartbeat')) leaseExpiresAt = Date.now() + 300_000;
    if (req.url?.endsWith('/review')) reviews += 1;
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not start');
  const signals: AbortSignal[] = [];
  let consumeResponses = 0;
  const api: MobileRunnerApi = {async request<T>(path, body, _key, signal) {
    if (path.endsWith('/consume') && signal) signals.push(signal);
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST', body: JSON.stringify(body), headers: {'Content-Type': 'application/json'},
      signal: honorsAbort ? signal : undefined,
    });
    if (!response.ok) throw Object.assign(new Error('Synthetic HTTP failure'), {statusCode: response.status});
    const firstConsumeResponse = path.endsWith('/consume') && ++consumeResponses === 1;
    if (firstConsumeResponse) bodyStarted.resolve();
    try { return await response.json() as T; }
    finally { if (firstConsumeResponse) bodyCompleted.resolve(); }
  }};
  const options: MobileRunnerOptions = {
    api, runnerId, workspaceId: null, executable: process.execPath,
    args: ['-e', "process.stdin.resume();process.stdin.on('end',()=>require('fs').appendFileSync(process.argv[1],'once\\n'));", marker],
    cwd: directory, receiptDirectory: directory, requestTimeoutMs: honorsAbort ? undefined : 600_000,
  };
  return {options, directory, marker, bodyStarted, bodyCompleted, consumers, signals,
    state: () => ({committedClaims, runnerHeartbeats, reviews, leaseExpiresAt}),
    refreshRunner: () => api.request('/api/v1/work-items/runners/heartbeat', {runnerId, workspaceId: null}),
    releaseBody: () => heldBody?.end(responseJson.slice(12)),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(directory, {recursive: true, force: true});
    },
  };
}

describe('mobile consume deadline and claim recovery', () => {
  it('bounds registration even when the transport never observes cancellation', async () => {
    const restoreClock = fakeClock();
    let receivedSignal: AbortSignal | undefined;
    const api = withMobileRunnerRequestTimeout({request: <T>(_path: string, _body: unknown, _key?: string, signal?: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<T>(() => {});
    }});
    try {
      const result = api.request('/api/v1/work-items/runners/heartbeat', {runnerId, workspaceId: null}).catch(error => error);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toMatchObject({statusCode: 408, message: 'Host request timed out. Retry with the same host identity.'});
      expect(receivedSignal?.aborted).toBe(true);
    } finally { restoreClock(); }
  });

  it('preserves an explicit attachment deadline instead of imposing the control request cap', async () => {
    const restoreClock = fakeClock();
    const response = deferred<unknown>();
    const transport = vi.fn(<T>(_path: string, _body: unknown, _key?: string, _signal?: AbortSignal) => response.promise as Promise<T>);
    const api = withMobileRunnerRequestTimeout({request: transport});
    try {
      const signal = AbortSignal.timeout(120_000);
      const body = {workspaceId: null};
      const result = api.request('/dispatches/synthetic/attachments/synthetic', body, 'same-key', signal);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(signal.aborted).toBe(false);
      expect(transport).toHaveBeenCalledWith('/dispatches/synthetic/attachments/synthetic', body, 'same-key', signal);
      response.resolve({received: true});
      expect(await result).toEqual({received: true});
    } finally { restoreClock(); }
  });

  it.each([true, false])('recovers a committed claim before expiry without respawning after a late response (transport abort=%s)', async honorsAbort => {
    const fixture = await committedClaimFixture(honorsAbort);
    const restoreClock = fakeClock();
    const finished = new Error('Synthetic listener finished');
    const retry = vi.fn();
    let timeoutOutcome: unknown;
    const outcome = listenForMobileWork({
      once: false, onRetry: retry, wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
      poll: async () => {
        await fixture.refreshRunner();
        try {
          const state = await consumeMobileDispatch(fixture.options);
          if (state === 'reviewed') throw finished;
          return state;
        } catch (error) { if (error !== finished) timeoutOutcome = error; throw error; }
      },
    }).catch(error => error);
    try {
      await fixture.bodyStarted.promise;
      expect(fixture.state().committedClaims).toBe(1);
      await expect(readFile(join(fixture.directory, `${dispatchId}.json`))).rejects.toMatchObject({code: 'ENOENT'});
      await vi.advanceTimersByTimeAsync(10_000);
      expect(retry).toHaveBeenCalledWith(5000);
      expect(timeoutOutcome).toMatchObject({statusCode: 408});
      expect(fixture.signals[0]?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await outcome).toBe(finished);
      expect(fixture.state()).toMatchObject({committedClaims: 1, runnerHeartbeats: 2, reviews: 1});
      expect(fixture.consumers).toHaveLength(2);
      expect(new Set(fixture.consumers).size).toBe(1);
      expect(JSON.parse(await readFile(join(fixture.directory, 'consumer.json'), 'utf8')).id).toBe(fixture.consumers[0]);
      expect(Date.now()).toBeLessThan(fixture.state().leaseExpiresAt);
      expect(await readFile(fixture.marker, 'utf8')).toBe('once\n');
      // A transport ignoring cancellation cannot enter spawn after its deadline.
      fixture.releaseBody();
      await fixture.bodyCompleted.promise;
      expect(await consumeMobileDispatch(fixture.options)).toBe('reviewed');
      expect(await readFile(fixture.marker, 'utf8')).toBe('once\n');
      expect(fixture.state()).toMatchObject({committedClaims: 1, reviews: 1});
    } finally {
      fixture.releaseBody(); restoreClock(); await outcome; await fixture.close();
    }
  });
});

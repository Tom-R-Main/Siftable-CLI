import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {installIsolatedConfigDirHooks} from '../helpers/config-env';
import {restoreFetch, runCommand} from '../helpers/mock-api';
import {
  describeControlState,
  resolveAppOrigin,
  runtimeRequestDecisionUrl,
} from '../../src/lib/work-runtime';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcess = require('node:child_process') as typeof import('node:child_process');

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_REQUEST_ID = '44444444-4444-4444-8444-444444444444';
const CONTROL_ID = '55555555-5555-4555-8555-555555555555';
const BASE = `/api/v1/work-items/${WORK_ID}`;

installIsolatedConfigDirHooks('sift-cli-work-runtime-');

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
}

type Reply = {status: number; body: unknown; bodyError?: boolean};
let calls: Call[] = [];

function installApi(handler: (call: Call, calls: Call[]) => Reply | undefined): void {
  calls = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = {
      method: (init.method ?? 'GET').toUpperCase(),
      url: new URL(String(input)),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = handler(call, calls) ?? {status: 500, body: {error: `No mock for ${call.method} ${call.url.pathname}`}};
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: new Headers({'content-type': 'application/json'}),
      text: async () => {
        if (reply.bodyError) throw new TypeError('terminated');
        return JSON.stringify(reply.body);
      },
      json: async () => {
        if (reply.bodyError) throw new TypeError('terminated');
        return reply.body;
      },
    } as Response;
  }) as typeof fetch;
}

const PROCESS_APIS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
let processSpies: Record<(typeof PROCESS_APIS)[number], jest.SpyInstance>;

beforeEach(() => {
  processSpies = Object.fromEntries(PROCESS_APIS.map(name => [
    name,
    jest.spyOn(childProcess, name).mockImplementation((() => ({on: jest.fn(), unref: jest.fn()})) as never),
  ])) as typeof processSpies;
});

afterEach(() => {
  restoreFetch();
  for (const spy of Object.values(processSpies)) spy.mockRestore();
});

function expectNoProcessStarted(): void {
  for (const name of PROCESS_APIS) expect(processSpies[name]).not.toHaveBeenCalled();
}

function attempt(state = 'running', overrides: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT_ID,
    workspaceId: 'ws',
    workItemId: WORK_ID,
    orgId: null,
    runtimeId: 'runtime-1',
    leaseGeneration: 1,
    claimOwner: 'host-1',
    host: 'mac',
    model: 'gpt-test',
    harness: 't3',
    state,
    endReason: state === 'ended' ? 'terminated' : null,
    startedAt: '2026-10-01T00:00:00.000Z',
    runningAt: '2026-10-01T00:00:01.000Z',
    endedAt: null,
    updatedAt: '2026-10-01T00:00:01.000Z',
    ...overrides,
  };
}

function execution(state: string | null = 'running') {
  return {
    version: 1,
    workspace: null,
    currentAttempt: state && state !== 'ended' ? attempt(state) : null,
    currentLeaseActive: state === 'running',
    attempts: state ? [attempt(state)] : [],
  };
}

function event(sequence: number, text = `event ${sequence}`) {
  return {
    version: 1,
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    workItemId: WORK_ID,
    sequence,
    actor: {kind: 'agent', id: 'agent', label: 'worker'},
    createdAt: '2026-10-01T00:00:00.000Z',
    replyToEventId: null,
    supersedesEventId: null,
    kind: 'message',
    parts: [{kind: 'text', text}],
    details: null,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    workItemId: WORK_ID,
    attemptId: ATTEMPT_ID,
    runtimeId: 'runtime-1',
    leaseGeneration: 1,
    providerRequestId: 'provider-1',
    kind: 'approval',
    blocking: true,
    category: 'command',
    summary: 'Run npm test',
    detail: {text: 'npm test'},
    state: 'pending',
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    closeReason: null,
    closedAt: null,
    externalDecision: null,
    deliveryState: 'pending',
    deliveryAttempts: 0,
    deliveredAt: null,
    deliveryError: null,
    createdAt: '2026-10-01T00:00:02.000Z',
    updatedAt: '2026-10-01T00:00:02.000Z',
    ...overrides,
  };
}

function control(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTROL_ID,
    workItemId: WORK_ID,
    attemptId: ATTEMPT_ID,
    runtimeId: 'runtime-1',
    leaseGeneration: 1,
    kind: 'instruction',
    instruction: 'Also update the README',
    ordinal: 1,
    state: 'queued',
    failureReason: null,
    requestedBy: 'user-1',
    cancelledBy: null,
    dispatchedAt: null,
    settledAt: null,
    createdAt: '2026-10-01T00:00:03.000Z',
    updatedAt: '2026-10-01T00:00:03.000Z',
    ...overrides,
  };
}

function jsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, unknown>);
}

const isOpenList = (call: Call) => call.url.searchParams.get('open') === 'true';

const auth = ['--token', 'sift_pat_test'];

describe('sift work runtime commands', () => {
  it('publishes the six runtime command IDs in the generated manifest', () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'oclif.manifest.json'), 'utf8')) as {commands?: Record<string, unknown>};
    expect(Object.keys(manifest.commands ?? {})).toEqual(expect.arrayContaining([
      'work:watch', 'work:attach', 'work:send', 'work:interrupt', 'work:approve', 'work:answer',
    ]));
  });

  describe('watch', () => {
    it('starts at the ledger end, prints one snapshot and ends with --once', async () => {
      installApi(call => {
        const path = call.url.pathname;
        if (path === `${BASE}/events`) {
          const after = Number(call.url.searchParams.get('afterSequence'));
          return {status: 200, body: {version: 1, events: after === 0 ? [event(1), event(2), event(3)] : [], nextSequence: after === 0 ? 3 : null}};
        }
        if (path === `${BASE}/execution`) return {status: 200, body: execution('running')};
        if (path === `${BASE}/runtime-requests`) return {status: 200, body: {version: 1, requests: [request()]}};
        if (path === `${BASE}/runtime-controls`) return {status: 200, body: {version: 1, controls: [control()], truncated: false}};
        return undefined;
      });

      const result = await runCommand(['work', 'watch', WORK_ID, '--once', '--backlog', '2', '--json', ...auth]);

      expect(result.exitCode).toBe(0);
      const records = jsonLines(result.stdout);
      expect(records.map(record => record.type)).toEqual(['snapshot', 'event', 'event', 'end']);
      expect(records[0]).toMatchObject({
        version: 1,
        type: 'snapshot',
        workItemId: WORK_ID,
        afterSequence: 3,
        attempt: {id: ATTEMPT_ID, state: 'running'},
        leaseActive: true,
        openRequests: [{id: REQUEST_ID, state: 'pending'}],
        openControls: [{id: CONTROL_ID, state: 'queued'}],
      });
      expect(records.slice(1, 3).map(record => (record.event as {sequence: number}).sequence)).toEqual([2, 3]);
      expect(records[3]).toEqual({version: 1, type: 'end', reason: 'once', afterSequence: 3});
      expect(calls.some(call => call.url.pathname.endsWith('/events/wait'))).toBe(false);
      expect(calls.every(call => call.method === 'GET')).toBe(true);
      expectNoProcessStarted();
    });

    it('long-polls from an explicit cursor, advances it per event and stops when the attempt ends', async () => {
      let refreshes = 0;
      installApi(call => {
        const path = call.url.pathname;
        if (path === `${BASE}/events/wait`) {
          const after = Number(call.url.searchParams.get('afterSequence'));
          if (after === 5) return {status: 200, body: {version: 1, events: [event(6), event(7)], nextSequence: 7, consumerKey: 'default', timedOut: false}};
          return {status: 200, body: {version: 1, events: [], nextSequence: null, consumerKey: 'default', timedOut: true}};
        }
        if (path === `${BASE}/events`) return {status: 200, body: {version: 1, events: [], nextSequence: null}};
        if (path === `${BASE}/execution`) {
          refreshes += 1;
          return {status: 200, body: execution(refreshes >= 3 ? 'ended' : 'running')};
        }
        if (path === `${BASE}/runtime-requests`) {
          return {status: 200, body: {version: 1, requests: refreshes >= 2 ? [request()] : []}};
        }
        if (path === `${BASE}/runtime-controls`) return {status: 200, body: {version: 1, controls: [], truncated: false}};
        return undefined;
      });

      const result = await runCommand(['work', 'watch', WORK_ID, '--after-sequence', '5', '--wait-ms', '1000', '--json', ...auth]);

      expect(result.exitCode).toBe(0);
      const waits = calls.filter(call => call.url.pathname === `${BASE}/events/wait`);
      expect(waits.map(call => call.url.searchParams.get('afterSequence'))).toEqual(['5', '7']);
      for (const wait of waits) {
        expect(wait.url.searchParams.get('waitMs')).toBe('1000');
        // The watcher keeps its own cursor and never touches a durable consumer cursor.
        expect(wait.url.searchParams.has('consumerKey')).toBe(false);
      }
      // The only plain read is the final drain after the attempt ended.
      expect(calls.filter(call => call.url.pathname === `${BASE}/events`).map(call => call.url.searchParams.get('afterSequence'))).toEqual(['7']);
      expect(calls.some(call => call.method !== 'GET')).toBe(false);
      const records = jsonLines(result.stdout);
      expect(records.map(record => record.type)).toEqual(['snapshot', 'event', 'event', 'request', 'attempt', 'end']);
      expect(records[0]).toMatchObject({afterSequence: 5});
      expect(records[3]).toMatchObject({type: 'request', request: {id: REQUEST_ID, state: 'pending'}});
      expect(records[4]).toMatchObject({type: 'attempt', attempt: null, leaseActive: false});
      expect(records[5]).toEqual({version: 1, type: 'end', reason: 'attempt_ended', afterSequence: 7});
      expectNoProcessStarted();
    });

    it('drains every remaining ledger page before reporting that the attempt ended', async () => {
      let refreshes = 0;
      installApi(call => {
        const path = call.url.pathname;
        if (path === `${BASE}/events/wait`) return {status: 200, body: {version: 1, events: [], nextSequence: null, consumerKey: 'default', timedOut: true}};
        if (path === `${BASE}/events`) {
          const after = Number(call.url.searchParams.get('afterSequence'));
          const limit = Number(call.url.searchParams.get('limit'));
          const events = Array.from({length: 101}, (_, index) => event(index + 1)).filter(entry => entry.sequence > after).slice(0, limit);
          return {status: 200, body: {version: 1, events, nextSequence: events.at(-1)?.sequence ?? null}};
        }
        if (path === `${BASE}/execution`) {
          refreshes += 1;
          return {status: 200, body: execution(refreshes >= 2 ? 'ended' : 'running')};
        }
        if (path === `${BASE}/runtime-requests`) return {status: 200, body: {version: 1, requests: []}};
        if (path === `${BASE}/runtime-controls`) return {status: 200, body: {version: 1, controls: [], truncated: false}};
        return undefined;
      });

      const result = await runCommand(['work', 'watch', WORK_ID, '--after-sequence', '0', '--wait-ms', '1000', '--json', ...auth]);

      expect(result.exitCode).toBe(0);
      const records = jsonLines(result.stdout);
      const sequences = records.filter(record => record.type === 'event').map(record => (record.event as {sequence: number}).sequence);
      expect(sequences).toEqual(Array.from({length: 101}, (_, index) => index + 1));
      expect(records.at(-1)).toEqual({version: 1, type: 'end', reason: 'attempt_ended', afterSequence: 101});
      const drains = calls.filter(call => call.url.pathname === `${BASE}/events`);
      expect(drains.map(call => call.url.searchParams.get('afterSequence'))).toEqual(['0', '100']);
    });

    it('renders readable text with a decision hint for an open request', async () => {
      installApi(call => {
        const path = call.url.pathname;
        if (path === `${BASE}/events`) return {status: 200, body: {version: 1, events: [event(1, 'hello')], nextSequence: 1}};
        if (path === `${BASE}/execution`) return {status: 200, body: execution('running')};
        if (path === `${BASE}/runtime-requests`) return {status: 200, body: {version: 1, requests: [request()]}};
        if (path === `${BASE}/runtime-controls`) return {status: 200, body: {version: 1, controls: [], truncated: false}};
        return undefined;
      });

      const result = await runCommand(['work', 'attach', WORK_ID, '--once', '--no-input', ...auth]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Attempt ${ATTEMPT_ID} running`);
      expect(result.stdout).toContain('Approval needed: Run npm test');
      expect(result.stdout).toContain(`sift work approve ${WORK_ID} ${REQUEST_ID}`);
      expect(result.stdout).toContain('#1  message  worker  hello');
      expectNoProcessStarted();
    });
  });

  describe('send and interrupt', () => {
    it('posts an instruction control with a generated key and returns the documented JSON shape', async () => {
      installApi(call => (call.method === 'POST' && call.url.pathname === `${BASE}/runtime-controls`
        ? {status: 201, body: {version: 1, applied: true, control: control()}}
        : undefined));

      const result = await runCommand(['work', 'send', WORK_ID, 'Also update the README', '--json', ...auth]);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(Object.keys(output).sort()).toEqual(['applied', 'control', 'idempotencyKey', 'requestAttempts', 'version']);
      expect(output).toMatchObject({version: 1, applied: true, requestAttempts: 1, control: {id: CONTROL_ID, state: 'queued'}});
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toEqual({kind: 'instruction', instruction: 'Also update the README'});
      expect(calls[0].headers['Idempotency-Key']).toBe(output.idempotencyKey);
      expect(output.idempotencyKey).toMatch(/^cli-instruction-[0-9a-f-]{36}$/);
      expectNoProcessStarted();
    });

    it('reuses the same Idempotency-Key when it retries after a transient failure', async () => {
      installApi((call, all) => {
        if (call.method !== 'POST') return undefined;
        return all.length === 1
          ? {status: 503, body: {error: 'unavailable'}}
          : {status: 200, body: {version: 1, applied: false, control: control()}};
      });

      const result = await runCommand(['work', 'send', WORK_ID, 'Also update the README', '--retry-delay-ms', '0', '--json', ...auth]);

      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(2);
      expect(calls[0].headers['Idempotency-Key']).toBeDefined();
      expect(calls[1].headers['Idempotency-Key']).toBe(calls[0].headers['Idempotency-Key']);
      expect(JSON.parse(result.stdout)).toMatchObject({applied: false, requestAttempts: 2, idempotencyKey: calls[0].headers['Idempotency-Key']});
    });

    it('retries with the same key when the connection drops while the response body is read', async () => {
      installApi((call, all) => {
        if (call.method !== 'POST') return undefined;
        return all.length === 1
          ? {status: 201, body: {version: 1, applied: true, control: control()}, bodyError: true}
          : {status: 200, body: {version: 1, applied: false, control: control()}};
      });

      const result = await runCommand(['work', 'send', WORK_ID, 'Also update the README', '--retry-delay-ms', '0', '--json', ...auth]);

      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(2);
      expect(calls[1].headers['Idempotency-Key']).toBe(calls[0].headers['Idempotency-Key']);
      expect(JSON.parse(result.stdout)).toMatchObject({applied: false, requestAttempts: 2, control: {id: CONTROL_ID}});
    });

    it('uses a caller-supplied key and does not retry a conflict', async () => {
      installApi(call => (call.method === 'POST'
        ? {status: 409, body: {error: 'This work has no running execution to receive the control'}}
        : undefined));

      const result = await runCommand(['work', 'send', WORK_ID, 'hi', '--idempotency-key', 'my-key-1', '--json', ...auth]);

      expect(result.exitCode).not.toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0].headers['Idempotency-Key']).toBe('my-key-1');
    });

    it('posts an interrupt and waits only for the state the server records', async () => {
      installApi(call => {
        if (call.method === 'POST' && call.url.pathname === `${BASE}/runtime-controls`) {
          return {status: 201, body: {version: 1, applied: true, control: control({kind: 'interrupt', instruction: null, state: 'queued'})}};
        }
        if (call.method === 'GET' && call.url.pathname === `${BASE}/runtime-controls`) {
          return {status: 200, body: {version: 1, controls: [control({kind: 'interrupt', instruction: null, state: 'acknowledged'})], truncated: false}};
        }
        return undefined;
      });

      const result = await runCommand(['work', 'interrupt', WORK_ID, '--wait', '--poll-ms', '0', '--json', ...auth]);

      expect(result.exitCode).toBe(0);
      expect(calls[0].body).toEqual({kind: 'interrupt'});
      expect(calls[0].headers['Idempotency-Key']).toMatch(/^cli-interrupt-/);
      expect(JSON.parse(result.stdout)).toMatchObject({version: 1, settled: true, control: {kind: 'interrupt', state: 'acknowledged'}});
      expectNoProcessStarted();
    });

    it('reports an unconfirmed instruction as unconfirmed and exits non-zero', async () => {
      installApi(call => {
        if (call.method === 'POST') return {status: 201, body: {version: 1, applied: true, control: control()}};
        return {status: 200, body: {version: 1, controls: [control({state: 'unconfirmed'})], truncated: false}};
      });

      const result = await runCommand(['work', 'send', WORK_ID, 'Also update the README', '--wait', '--poll-ms', '0', ...auth]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('not delivered yet');
      expect(result.stdout).toContain('unconfirmed');
      expect(result.stdout).not.toContain('Delivered:');
    });
  });

  describe('approve and answer', () => {
    it('opens the decision page, never resolves with the token, and returns the stored outcome', async () => {
      let lists = 0;
      installApi(call => {
        if (call.url.pathname === `${BASE}/runtime-requests` && call.method === 'GET') {
          if (!isOpenList(call)) lists += 1;
          if (isOpenList(call)) return {status: 200, body: {version: 1, requests: lists < 3 ? [request()] : []}};
          return {status: 200, body: {version: 1, requests: [lists < 3 ? request() : request({
            state: 'resolved',
            resolution: {decision: 'accept'},
            resolvedBy: 'user-1',
            resolvedAt: '2026-10-01T00:01:00.000Z',
            deliveryState: 'delivered',
            updatedAt: '2026-10-01T00:01:01.000Z',
          })]}};
        }
        return undefined;
      });

      const result = await runCommand(['work', 'approve', WORK_ID, '--poll-ms', '0', '--json', ...auth]);

      expect(result.exitCode).toBe(0);
      const records = jsonLines(result.stdout);
      const decisionUrl = `https://siftable.io/app/work/${WORK_ID}?request=${REQUEST_ID}`;
      expect(records).toHaveLength(2);
      expect(records[0]).toEqual({
        version: 1, type: 'decision_required', workItemId: WORK_ID, requestId: REQUEST_ID, kind: 'approval', url: decisionUrl, browserOpened: true,
      });
      expect(records[1]).toEqual({
        version: 1,
        type: 'outcome',
        workItemId: WORK_ID,
        requestId: REQUEST_ID,
        kind: 'approval',
        decisionUrl,
        browserOpened: true,
        outcome: 'resolved',
        outcomeAvailable: true,
        request: expect.objectContaining({state: 'resolved', resolution: {decision: 'accept'}, deliveryState: 'delivered'}),
      });
      expect(calls.every(call => call.method === 'GET')).toBe(true);
      expect(calls.some(call => call.url.pathname.endsWith('/resolve'))).toBe(false);
      // The only process started is the platform URL opener, with exactly the decision URL.
      expect(processSpies.spawn).toHaveBeenCalledTimes(1);
      const [command, args] = processSpies.spawn.mock.calls[0] as [string, string[]];
      expect(['open', 'xdg-open', 'rundll32']).toContain(command);
      expect(args.at(-1)).toBe(decisionUrl);
      for (const name of PROCESS_APIS.filter(api => api !== 'spawn')) expect(processSpies[name]).not.toHaveBeenCalled();
    });

    it('prints the local web URL with --no-browser and starts no process', async () => {
      installApi(call => (call.url.pathname === `${BASE}/runtime-requests`
        ? {status: 200, body: {version: 1, requests: isOpenList(call) ? [] : [request({kind: 'user_input', detail: {questions: [{id: 'q1', header: 'Branch', question: 'Which branch?', options: [{label: 'main', description: ''}]}]}, state: 'resolved', resolution: {answers: {q1: 'main'}}})]}}
        : undefined));

      const result = await runCommand([
        'work', 'answer', WORK_ID, REQUEST_ID, '--no-browser', '--json', '--api-url', 'http://127.0.0.1:8080', ...auth,
      ]);

      expect(result.exitCode).toBe(0);
      const records = jsonLines(result.stdout);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        type: 'outcome',
        kind: 'user_input',
        decisionUrl: `http://127.0.0.1:3000/app/work/${WORK_ID}?request=${REQUEST_ID}`,
        browserOpened: false,
        outcome: 'resolved',
      });
      expectNoProcessStarted();
    });

    it('times out while the request is still pending and exits non-zero', async () => {
      installApi(call => (call.url.pathname === `${BASE}/runtime-requests`
        ? {status: 200, body: {version: 1, requests: [request()]}}
        : undefined));

      const result = await runCommand(['work', 'approve', WORK_ID, REQUEST_ID, '--no-browser', '--timeout', '1', '--poll-ms', '200', '--json', ...auth]);

      expect(result.exitCode).toBe(1);
      const records = jsonLines(result.stdout);
      expect(records[0]).toMatchObject({type: 'decision_required', requestId: REQUEST_ID, browserOpened: false});
      expect(records.at(-1)).toMatchObject({type: 'outcome', outcome: 'timed_out', browserOpened: false, request: {state: 'pending'}});
      expect(calls.every(call => call.method === 'GET')).toBe(true);
    });

    it('writes the decision URL as JSON before it starts waiting on a pending request', async () => {
      let polls = 0;
      installApi(call => {
        if (call.url.pathname !== `${BASE}/runtime-requests`) return undefined;
        if (!isOpenList(call)) {
          polls += 1;
          // Marks, in stdout order, the moment the command starts waiting.
          if (polls === 2) console.log('POLL-STARTED');
        }
        const resolved = polls >= 2;
        if (isOpenList(call)) return {status: 200, body: {version: 1, requests: resolved ? [] : [request()]}};
        return {status: 200, body: {version: 1, requests: [resolved ? request({state: 'resolved', resolution: {decision: 'decline'}}) : request()]}};
      });

      const result = await runCommand(['work', 'approve', WORK_ID, REQUEST_ID, '--no-browser', '--poll-ms', '0', '--json', ...auth]);

      const lines = result.stdout.split('\n').filter(Boolean);
      const requiredIndex = lines.findIndex(line => line.includes('"decision_required"'));
      expect(requiredIndex).toBeGreaterThanOrEqual(0);
      expect(requiredIndex).toBeLessThan(lines.indexOf('POLL-STARTED'));
      expect(JSON.parse(lines[requiredIndex])).toEqual({
        version: 1,
        type: 'decision_required',
        workItemId: WORK_ID,
        requestId: REQUEST_ID,
        kind: 'approval',
        url: `https://siftable.io/app/work/${WORK_ID}?request=${REQUEST_ID}`,
        browserOpened: false,
      });
      expect(jsonLines(result.stdout).at(-1)).toMatchObject({type: 'outcome', outcome: 'resolved', request: {resolution: {decision: 'decline'}}});
      expect(result.exitCode).toBe(0);
      expectNoProcessStarted();
    });

    it('finds an older pending request through the open list when 100 newer requests are closed', async () => {
      const closed = Array.from({length: 100}, (_, index) => request({
        id: `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`,
        state: 'expired',
        closeReason: 'session_ended',
        createdAt: `2026-10-01T01:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
      }));
      const older = request({createdAt: '2026-09-30T00:00:00.000Z'});
      installApi(call => {
        if (call.url.pathname === `${BASE}/runtime-requests`) {
          return {status: 200, body: {version: 1, requests: isOpenList(call) ? [older] : closed}};
        }
        if (call.url.pathname === `${BASE}/events`) return {status: 200, body: {version: 1, events: [], nextSequence: null}};
        if (call.url.pathname === `${BASE}/execution`) return {status: 200, body: execution('running')};
        if (call.url.pathname === `${BASE}/runtime-controls`) return {status: 200, body: {version: 1, controls: [], truncated: false}};
        return undefined;
      });

      const approve = await runCommand(['work', 'approve', WORK_ID, '--no-browser', '--timeout', '1', '--poll-ms', '500', '--json', ...auth]);
      expect(jsonLines(approve.stdout)[0]).toMatchObject({type: 'decision_required', requestId: REQUEST_ID});
      const named = await runCommand(['work', 'approve', WORK_ID, REQUEST_ID, '--no-browser', '--timeout', '1', '--poll-ms', '500', '--json', ...auth]);
      expect(jsonLines(named.stdout)[0]).toMatchObject({type: 'decision_required', requestId: REQUEST_ID});

      const watch = await runCommand(['work', 'watch', WORK_ID, '--once', '--json', ...auth]);
      expect(jsonLines(watch.stdout)[0]).toMatchObject({type: 'snapshot', openRequests: [{id: REQUEST_ID, state: 'pending'}]});
    });

    it('stops waiting when the older request is decided and is in neither list', async () => {
      const closed = Array.from({length: 100}, (_, index) => request({
        id: `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`,
        state: 'expired',
        createdAt: '2026-10-01T01:00:00.000Z',
      }));
      let polls = 0;
      installApi(call => {
        if (call.url.pathname !== `${BASE}/runtime-requests`) return undefined;
        if (isOpenList(call)) {
          polls += 1;
          return {status: 200, body: {version: 1, requests: polls <= 2 ? [request({createdAt: '2026-09-30T00:00:00.000Z'})] : []}};
        }
        return {status: 200, body: {version: 1, requests: closed}};
      });

      const result = await runCommand(['work', 'approve', WORK_ID, '--no-browser', '--timeout', '30', '--poll-ms', '0', '--json', ...auth]);

      expect(result.exitCode).toBe(0);
      const records = jsonLines(result.stdout);
      expect(records.map(record => record.type)).toEqual(['decision_required', 'outcome']);
      expect(records[1]).toMatchObject({
        type: 'outcome',
        requestId: REQUEST_ID,
        outcome: 'closed',
        outcomeAvailable: false,
        request: {id: REQUEST_ID, state: 'closed', resolution: null, resolvedBy: null, resolvedAt: null, deliveryState: null, deliveredAt: null, deliveryError: null},
      });
      expect(calls.every(call => call.method === 'GET')).toBe(true);
    });

    it('reports the stored outcome when the older request leaves the open list and appears in history', async () => {
      let polls = 0;
      installApi(call => {
        if (call.url.pathname !== `${BASE}/runtime-requests`) return undefined;
        if (isOpenList(call)) {
          polls += 1;
          return {status: 200, body: {version: 1, requests: polls <= 2 ? [request()] : []}};
        }
        return {status: 200, body: {version: 1, requests: polls <= 2 ? [] : [request({
          state: 'resolved', resolution: {decision: 'accept'}, resolvedBy: 'user-1', deliveryState: 'delivered',
        })]}};
      });

      const result = await runCommand(['work', 'approve', WORK_ID, REQUEST_ID, '--no-browser', '--timeout', '30', '--poll-ms', '0', '--json', ...auth]);

      expect(result.exitCode).toBe(0);
      expect(jsonLines(result.stdout).at(-1)).toMatchObject({
        type: 'outcome',
        outcome: 'resolved',
        outcomeAvailable: true,
        request: {state: 'resolved', resolution: {decision: 'accept'}, deliveryState: 'delivered'},
      });
    });

    it('asks for a request ID when several approvals are open', async () => {
      installApi(() => ({status: 200, body: {version: 1, requests: [request(), request({id: OTHER_REQUEST_ID})]}}));

      const result = await runCommand(['work', 'approve', WORK_ID, '--no-browser', ...auth]);

      expect(result.exitCode).not.toBe(0);
      expect(result.error?.message).toContain(REQUEST_ID);
      expect(result.error?.message).toContain(OTHER_REQUEST_ID);
      expectNoProcessStarted();
    });

    it('refuses to answer an approval request', async () => {
      installApi(() => ({status: 200, body: {version: 1, requests: [request()]}}));

      const result = await runCommand(['work', 'answer', WORK_ID, REQUEST_ID, '--no-browser', ...auth]);

      expect(result.exitCode).not.toBe(0);
      expect(result.error?.message).toContain('sift work approve');
    });
  });

  describe('helpers', () => {
    it('derives the web app origin from the API URL', () => {
      expect(resolveAppOrigin('https://siftable.io')).toBe('https://siftable.io');
      expect(resolveAppOrigin('http://localhost:8080')).toBe('http://localhost:3000');
      expect(resolveAppOrigin('http://localhost:8080', 'http://localhost:5173/')).toBe('http://localhost:5173');
      expect(() => resolveAppOrigin('https://siftable.io', 'javascript:alert(1)')).toThrow();
      expect(runtimeRequestDecisionUrl('https://siftable.io', 'w/1', 'r&2')).toBe('https://siftable.io/app/work/w%2F1?request=r%262');
    });

    it('never describes an unsettled control as delivered or acknowledged', () => {
      for (const state of ['queued', 'dispatching', 'unconfirmed', 'expired', 'failed', 'cancelled'] as const) {
        for (const kind of ['instruction', 'interrupt'] as const) {
          const text = describeControlState({kind, state, failureReason: null, ordinal: 1});
          expect(text).not.toMatch(/^Delivered|^Acknowledged/);
        }
      }
    });
  });
});

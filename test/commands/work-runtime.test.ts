import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {installIsolatedConfigDirHooks} from '../helpers/config-env';
import {restoreFetch, runCommand} from '../helpers/mock-api';
import {
  ControlInputQueue,
  MAX_DRAIN_PAGES,
  RUNTIME_INSTRUCTION_MAX_CHARS,
  isAmbiguousControlFailure,
  submitAttachControl,
  WorkItemFollower,
  WorkRuntimeApi,
  type WatchRecord,
  describeControlState,
  isRetryableControlStatus,
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

type Reply = {status: number; body: unknown; bodyError?: boolean} | {stall: true};

const STALL: Reply = {stall: true};
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
    if ('stall' in reply) {
      // Never answers; only an abort of the request's signal ends it.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true});
      });
    }
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
/** What the fake URL opener reports after spawn() returns: 'spawn' (started) or 'error' (ENOENT). */
let openerOutcome: 'spawn' | 'error' = 'spawn';

function fakeChild(): EventEmitter & {unref: () => void} {
  const child = Object.assign(new EventEmitter(), {unref: jest.fn()});
  process.nextTick(() => {
    if (openerOutcome === 'spawn') child.emit('spawn');
    else child.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), {code: 'ENOENT'}));
  });
  return child;
}

beforeEach(() => {
  openerOutcome = 'spawn';
  processSpies = Object.fromEntries(PROCESS_APIS.map(name => [
    name,
    jest.spyOn(childProcess, name).mockImplementation((name === 'spawn' ? fakeChild : () => ({on: jest.fn(), unref: jest.fn()})) as never),
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

/** An attempt that has already ended over a ledger that never ends. */
function endlessLedgerForApi(): void {
  installApi(call => {
    const path = call.url.pathname;
    if (path === `${BASE}/events/wait`) return {status: 200, body: {version: 1, events: [], nextSequence: null, consumerKey: 'default', timedOut: true}};
    if (path === `${BASE}/events`) {
      const after = Number(call.url.searchParams.get('afterSequence'));
      return {status: 200, body: {version: 1, events: Array.from({length: 100}, (_, index) => event(after + index + 1)), nextSequence: after + 100}};
    }
    if (path === `${BASE}/execution`) {
      const refreshes = calls.filter(entry => entry.url.pathname === `${BASE}/execution`).length;
      return {status: 200, body: execution(refreshes >= 2 ? 'ended' : 'running')};
    }
    if (path === `${BASE}/runtime-requests`) return {status: 200, body: {version: 1, requests: []}};
    if (path === `${BASE}/runtime-controls`) return {status: 200, body: {version: 1, controls: [], truncated: false}};
    return undefined;
  });
}

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
          return {status: 200, body: execution(refreshes >= 4 ? 'ended' : 'running')};
        }
        if (path === `${BASE}/runtime-requests`) {
          return {status: 200, body: {version: 1, requests: refreshes >= 3 ? [request()] : []}};
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
          return {status: 200, body: execution(refreshes >= 3 ? 'ended' : 'running')};
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

    function endlessLedger(endedAfterRefresh: number) {
      let refreshes = 0;
      installApi(call => {
        const path = call.url.pathname;
        if (path === `${BASE}/events/wait`) return {status: 200, body: {version: 1, events: [], nextSequence: null, consumerKey: 'default', timedOut: true}};
        if (path === `${BASE}/events`) {
          const after = Number(call.url.searchParams.get('afterSequence'));
          const events = Array.from({length: 100}, (_, index) => event(after + index + 1));
          return {status: 200, body: {version: 1, events, nextSequence: after + 100}};
        }
        if (path === `${BASE}/execution`) {
          refreshes += 1;
          return {status: 200, body: execution(refreshes >= endedAfterRefresh ? 'ended' : 'running')};
        }
        if (path === `${BASE}/runtime-requests`) return {status: 200, body: {version: 1, requests: []}};
        if (path === `${BASE}/runtime-controls`) return {status: 200, body: {version: 1, controls: [], truncated: false}};
        return undefined;
      });
    }

    it('reports drain_incomplete and exits non-zero when the final drain hits its page cap', async () => {
      endlessLedger(3);

      const result = await runCommand(['work', 'watch', WORK_ID, '--after-sequence', '0', '--wait-ms', '1000', '--json', ...auth]);

      expect(result.exitCode).toBe(1);
      const records = jsonLines(result.stdout);
      const last = MAX_DRAIN_PAGES * 100;
      expect(records.at(-2)).toEqual({version: 1, type: 'drain_incomplete', cause: 'page_limit', afterSequence: last});
      expect(records.at(-1)).toEqual({version: 1, type: 'end', reason: 'drain_incomplete', afterSequence: last});
      expect(records.some(record => record.type === 'end' && record.reason === 'attempt_ended')).toBe(false);
    });

    it('fails explicitly, without a snapshot, when the start scan cannot reach the ledger end', async () => {
      endlessLedger(99);

      const result = await runCommand(['work', 'watch', WORK_ID, '--json', ...auth]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain('"snapshot"');
      expect(result.stdout).toContain('--after-sequence');
      expect(calls.filter(call => call.url.pathname === `${BASE}/events`)).toHaveLength(1_000);
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

  describe('attach typed controls', () => {
    const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    afterEach(() => {
      if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
    });

    function typeLines(lines: string[]): void {
      const stdin = Object.assign(new PassThrough(), {isTTY: true});
      Object.defineProperty(process, 'stdin', {configurable: true, value: stdin});
      // Typed after attach starts reading; end of input then detaches.
      setTimeout(() => {
        for (const line of lines) stdin.write(`${line}\n`);
        stdin.end();
      }, 50);
    }

    function liveWorkItem(post: () => {status: number; body: unknown}): void {
      installApi(call => {
        const path = call.url.pathname;
        if (call.method === 'POST' && path === `${BASE}/runtime-controls`) return post();
        if (path === `${BASE}/events`) return {status: 200, body: {version: 1, events: [], nextSequence: null}};
        // A real long-poll holds until it is aborted; detaching aborts it.
        if (path === `${BASE}/events/wait`) return STALL;
        if (path === `${BASE}/execution`) return {status: 200, body: execution('running')};
        if (path === `${BASE}/runtime-requests`) return {status: 200, body: {version: 1, requests: []}};
        if (path === `${BASE}/runtime-controls`) return {status: 200, body: {version: 1, controls: [], truncated: false}};
        return undefined;
      });
    }

    it('exits 1 when a typed control ends unconfirmed', async () => {
      liveWorkItem(() => ({status: 503, body: {error: 'unavailable'}}));
      typeLines(['Also update the README']);

      const result = await runCommand(['work', 'attach', WORK_ID, '--backlog', '0', '--wait-ms', '1000', '--json', ...auth]);

      expect(result.exitCode).toBe(1);
      const records = jsonLines(result.stdout);
      expect(records.find(record => record.type === 'control_unconfirmed')).toMatchObject({cause: 'http', httpStatus: 503});
      expect(records.at(-1)).toMatchObject({type: 'end', reason: 'signal'});
    });

    it('exits 0 when every typed control is accepted', async () => {
      liveWorkItem(() => ({status: 201, body: {version: 1, applied: true, control: control()}}));
      typeLines(['Also update the README']);

      const result = await runCommand(['work', 'attach', WORK_ID, '--backlog', '0', '--wait-ms', '1000', '--json', ...auth]);

      expect(result.exitCode).toBe(0);
      expect(jsonLines(result.stdout).some(record => record.type === 'control')).toBe(true);
    });

    it('exits 1 when a typed instruction is too long to send', async () => {
      let posts = 0;
      liveWorkItem(() => {
        posts += 1;
        return {status: 201, body: {version: 1, applied: true, control: control()}};
      });
      typeLines(['x'.repeat(RUNTIME_INSTRUCTION_MAX_CHARS + 1)]);

      const result = await runCommand(['work', 'attach', WORK_ID, '--backlog', '0', '--wait-ms', '1000', '--json', ...auth]);

      expect(result.exitCode).toBe(1);
      expect(posts).toBe(0);
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

    it.each([501, 507, 520])('retries a %i with the same key', async status => {
      installApi((call, all) => {
        if (call.method !== 'POST') return undefined;
        return all.length === 1
          ? {status, body: {error: 'upstream'}}
          : {status: 200, body: {version: 1, applied: false, control: control()}};
      });

      const result = await runCommand(['work', 'send', WORK_ID, 'Also update the README', '--retry-delay-ms', '0', '--json', ...auth]);

      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(2);
      expect(calls[1].headers['Idempotency-Key']).toBe(calls[0].headers['Idempotency-Key']);
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

    it('reports an unconfirmed outcome with the key, as JSON, when every attempt ends in a 5xx', async () => {
      installApi(call => (call.method === 'POST' ? {status: 503, body: {error: 'unavailable'}} : undefined));

      const result = await runCommand(['work', 'send', WORK_ID, 'Also update the README', '--retry-delay-ms', '0', '--json', ...auth]);

      expect(result.exitCode).toBe(1);
      expect(calls).toHaveLength(3);
      const key = calls[0].headers['Idempotency-Key'];
      expect(calls.every(call => call.headers['Idempotency-Key'] === key)).toBe(true);
      expect(JSON.parse(result.stdout)).toEqual({
        version: 1, ok: false, outcome: 'unconfirmed', kind: 'instruction', idempotencyKey: key, requestAttempts: 3, cause: 'http', httpStatus: 503,
      });
    });

    it('stays unconfirmed with the key when a lost response is followed by a 429 and a 409', async () => {
      installApi((call, all) => {
        if (call.method !== 'POST') return undefined;
        const posts = all.filter(entry => entry.method === 'POST').length;
        if (posts === 1) return {status: 201, body: {version: 1, applied: true, control: control()}, bodyError: true};
        if (posts === 2) return {status: 429, body: {error: 'Too many requests'}};
        return {status: 409, body: {error: 'Idempotency key in use'}};
      });

      const result = await runCommand(['work', 'send', WORK_ID, 'Also update the README', '--retry-delay-ms', '0', '--json', ...auth]);

      expect(result.exitCode).toBe(1);
      expect(calls).toHaveLength(3);
      const key = calls[0].headers['Idempotency-Key'];
      expect(calls.every(call => call.headers['Idempotency-Key'] === key)).toBe(true);
      expect(JSON.parse(result.stdout)).toEqual({
        version: 1, ok: false, outcome: 'unconfirmed', kind: 'instruction', idempotencyKey: key, requestAttempts: 3, cause: 'transport', httpStatus: null,
      });
    });

    it('names the retry key in text when no response could be read', async () => {
      installApi(call => (call.method === 'POST' ? {status: 201, body: {version: 1, applied: true, control: control()}, bodyError: true} : undefined));

      const result = await runCommand(['work', 'interrupt', WORK_ID, '--retries', '1', '--retry-delay-ms', '0', ...auth]);

      expect(result.exitCode).toBe(1);
      expect(calls).toHaveLength(2);
      expect(result.stdout).toContain('Interrupt outcome unknown');
      expect(result.stdout).toContain(`--idempotency-key ${calls[0].headers['Idempotency-Key']}`);
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

    it('stops --wait at --timeout when a control poll read stalls, keeping the last recorded state', async () => {
      installApi(call => {
        if (call.method === 'POST') return {status: 201, body: {version: 1, applied: true, control: control()}};
        return STALL;
      });
      const started = Date.now();

      const result = await runCommand(['work', 'send', WORK_ID, 'Also update the README', '--wait', '--timeout', '1', '--poll-ms', '0', '--json', ...auth]);

      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({settled: false, stoppedBy: 'timeout', control: {state: 'queued'}});
    });

    it('stops --wait with exit 130 when Ctrl-C interrupts a stalled control poll', async () => {
      installApi(call => {
        if (call.method === 'POST') return {status: 201, body: {version: 1, applied: true, control: control({kind: 'interrupt', instruction: null})}};
        setTimeout(() => process.emit('SIGINT'), 50);
        return STALL;
      });

      const result = await runCommand(['work', 'interrupt', WORK_ID, '--wait', '--timeout', '30', '--poll-ms', '0', '--json', ...auth]);

      expect(result.exitCode).toBe(130);
      expect(JSON.parse(result.stdout)).toMatchObject({settled: false, stoppedBy: 'signal', control: {state: 'queued'}});
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
    const exactPath = `${BASE}/runtime-requests/${REQUEST_ID}`;
    const resolved = (overrides: Record<string, unknown> = {}) => request({
      state: 'resolved',
      resolution: {decision: 'accept'},
      resolvedBy: 'user-1',
      resolvedAt: '2026-10-01T00:01:00.000Z',
      deliveryState: 'delivered',
      updatedAt: '2026-10-01T00:01:01.000Z',
      ...overrides,
    });

    it('opens the decision page, never resolves with the token, and polls the exact request', async () => {
      let reads = 0;
      installApi(call => {
        if (call.url.pathname === `${BASE}/runtime-requests`) {
          return {status: 200, body: {version: 1, requests: isOpenList(call) ? [request()] : []}};
        }
        if (call.url.pathname === exactPath) {
          reads += 1;
          return {status: 200, body: {version: 1, request: reads < 3 ? request() : resolved()}};
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
        request: expect.objectContaining({state: 'resolved', resolution: {decision: 'accept'}, deliveryState: 'delivered'}),
      });
      expect(reads).toBe(3);
      expect(calls.every(call => call.method === 'GET')).toBe(true);
      expect(calls.some(call => call.url.pathname.endsWith('/resolve'))).toBe(false);
      // The only process started is the platform URL opener, with exactly the decision URL.
      expect(processSpies.spawn).toHaveBeenCalledTimes(1);
      const [command, args] = processSpies.spawn.mock.calls[0] as [string, string[]];
      expect(['open', 'xdg-open', 'rundll32']).toContain(command);
      expect(args.at(-1)).toBe(decisionUrl);
      for (const name of PROCESS_APIS.filter(api => api !== 'spawn')) expect(processSpies[name]).not.toHaveBeenCalled();
    });

    it('reports browserOpened false and prints the URL when the opener is missing', async () => {
      openerOutcome = 'error';
      installApi(call => (call.url.pathname === exactPath
        ? {status: 200, body: {version: 1, request: request()}}
        : undefined));

      const json = await runCommand(['work', 'approve', WORK_ID, REQUEST_ID, '--timeout', '1', '--poll-ms', '500', '--json', ...auth]);
      expect(jsonLines(json.stdout)[0]).toMatchObject({type: 'decision_required', browserOpened: false, url: `https://siftable.io/app/work/${WORK_ID}?request=${REQUEST_ID}`});
      expect(jsonLines(json.stdout).at(-1)).toMatchObject({type: 'outcome', browserOpened: false});

      const text = await runCommand(['work', 'approve', WORK_ID, REQUEST_ID, '--timeout', '1', '--poll-ms', '500', ...auth]);
      expect(text.stdout).toContain(`Could not open a browser. Open this page yourself: https://siftable.io/app/work/${WORK_ID}?request=${REQUEST_ID}`);
      expect(text.stdout).not.toContain('Opened ');
    });

    it('prints the local web URL with --no-browser and starts no process', async () => {
      installApi(call => (call.url.pathname === exactPath
        ? {status: 200, body: {version: 1, request: resolved({kind: 'user_input', detail: {questions: [{id: 'q1', header: 'Branch', question: 'Which branch?', options: [{label: 'main', description: ''}]}]}, resolution: {answers: {q1: 'main'}}})}}
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
      installApi(call => (call.url.pathname === exactPath ? {status: 200, body: {version: 1, request: request()}} : undefined));

      const result = await runCommand(['work', 'approve', WORK_ID, REQUEST_ID, '--no-browser', '--timeout', '1', '--poll-ms', '200', '--json', ...auth]);

      expect(result.exitCode).toBe(1);
      const records = jsonLines(result.stdout);
      expect(records[0]).toMatchObject({type: 'decision_required', requestId: REQUEST_ID, browserOpened: false});
      expect(records.at(-1)).toMatchObject({type: 'outcome', outcome: 'timed_out', browserOpened: false, request: {state: 'pending'}});
      expect(calls.every(call => call.method === 'GET')).toBe(true);
    });

    it('writes the decision URL as JSON before it starts waiting on a pending request', async () => {
      let reads = 0;
      installApi(call => {
        if (call.url.pathname !== exactPath) return undefined;
        reads += 1;
        // Marks, in stdout order, the moment the command starts waiting.
        if (reads === 2) console.log('POLL-STARTED');
        return {status: 200, body: {version: 1, request: reads >= 2 ? resolved({resolution: {decision: 'decline'}}) : request()}};
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

    describe('an older request behind 100 newer closed requests', () => {
      const closed = Array.from({length: 100}, (_, index) => request({
        id: `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`,
        state: 'expired',
        closeReason: 'session_ended',
        createdAt: `2026-10-01T01:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
      }));
      const older = (overrides: Record<string, unknown> = {}) => request({createdAt: '2026-09-30T00:00:00.000Z', ...overrides});

      function installOlder(exact: (read: number) => Record<string, unknown>): void {
        let reads = 0;
        installApi(call => {
          if (call.url.pathname === `${BASE}/runtime-requests`) {
            // The general list never contains the older request; the open list does only while it is pending.
            return {status: 200, body: {version: 1, requests: isOpenList(call) ? (reads < 2 ? [older()] : []) : closed}};
          }
          if (call.url.pathname === exactPath) {
            reads += 1;
            return {status: 200, body: {version: 1, request: exact(reads)}};
          }
          if (call.url.pathname === `${BASE}/events`) return {status: 200, body: {version: 1, events: [], nextSequence: null}};
          if (call.url.pathname === `${BASE}/execution`) return {status: 200, body: execution('running')};
          if (call.url.pathname === `${BASE}/runtime-controls`) return {status: 200, body: {version: 1, controls: [], truncated: false}};
          return undefined;
        });
      }

      it('is found through the open list by approve and by the watch snapshot', async () => {
        installOlder(() => older());
        const approve = await runCommand(['work', 'approve', WORK_ID, '--no-browser', '--timeout', '1', '--poll-ms', '500', '--json', ...auth]);
        expect(jsonLines(approve.stdout)[0]).toMatchObject({type: 'decision_required', requestId: REQUEST_ID});

        installOlder(() => older());
        const watch = await runCommand(['work', 'watch', WORK_ID, '--once', '--json', ...auth]);
        expect(jsonLines(watch.stdout)[0]).toMatchObject({type: 'snapshot', openRequests: [{id: REQUEST_ID, state: 'pending'}]});
      });

      it('reports the true stored outcome once decided, though it is in neither list', async () => {
        installOlder(read => (read < 3 ? older() : older({state: 'resolved', resolution: {decision: 'accept'}, resolvedBy: 'user-1', deliveryState: 'delivered'})));

        const result = await runCommand(['work', 'approve', WORK_ID, '--no-browser', '--timeout', '30', '--poll-ms', '0', '--json', ...auth]);

        expect(result.exitCode).toBe(0);
        const records = jsonLines(result.stdout);
        expect(records.map(record => record.type)).toEqual(['decision_required', 'outcome']);
        expect(records[1]).toMatchObject({
          outcome: 'resolved',
          request: {id: REQUEST_ID, state: 'resolved', resolution: {decision: 'accept'}, deliveryState: 'delivered'},
        });
        expect(records[1]).not.toHaveProperty('outcomeAvailable');
      });

      it.each([
        ['expired', {state: 'expired', closeReason: 'attempt_ended'}],
        ['superseded', {state: 'superseded', blocking: false, closeReason: 'attempt_ended'}],
      ])('exits non-zero when the attempt ends and the request is %s', async (outcome, closedState) => {
        installOlder(read => (read < 2 ? older() : older(closedState)));

        const result = await runCommand(['work', 'approve', WORK_ID, '--no-browser', '--timeout', '30', '--poll-ms', '0', '--json', ...auth]);

        expect(result.exitCode).toBe(1);
        expect(jsonLines(result.stdout).at(-1)).toMatchObject({type: 'outcome', outcome, request: {state: outcome, closeReason: 'attempt_ended', resolution: null}});
      });
    });

    it('ends with timed_out when a decision poll read stalls past --timeout', async () => {
      let reads = 0;
      installApi(call => {
        if (call.url.pathname !== exactPath) return undefined;
        reads += 1;
        return reads === 1 ? {status: 200, body: {version: 1, request: request()}} : STALL;
      });
      const started = Date.now();

      const result = await runCommand(['work', 'approve', WORK_ID, REQUEST_ID, '--no-browser', '--timeout', '1', '--poll-ms', '0', '--json', ...auth]);

      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.exitCode).toBe(1);
      expect(jsonLines(result.stdout).at(-1)).toMatchObject({type: 'outcome', outcome: 'timed_out', request: {state: 'pending'}});
    });

    it('ends with interrupted (exit 130) when Ctrl-C stops a stalled decision poll', async () => {
      let reads = 0;
      installApi(call => {
        if (call.url.pathname !== exactPath) return undefined;
        reads += 1;
        if (reads === 2) setTimeout(() => process.emit('SIGINT'), 50);
        return reads === 1 ? {status: 200, body: {version: 1, request: request()}} : STALL;
      });

      const result = await runCommand(['work', 'approve', WORK_ID, REQUEST_ID, '--no-browser', '--timeout', '30', '--poll-ms', '0', '--json', ...auth]);

      expect(result.exitCode).toBe(130);
      expect(jsonLines(result.stdout).at(-1)).toMatchObject({type: 'outcome', outcome: 'interrupted', request: {state: 'pending'}});
    });

    it('reports a request ID that is not on the work item as not found', async () => {
      installApi(call => (call.url.pathname === exactPath ? {status: 404, body: {error: 'Request not found'}} : undefined));

      const result = await runCommand(['work', 'approve', WORK_ID, REQUEST_ID, '--no-browser', ...auth]);

      expect(result.exitCode).toBe(4);
      expect(result.error?.message).toContain('Not found');
      expectNoProcessStarted();
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
      installApi(call => (call.url.pathname === exactPath ? {status: 200, body: {version: 1, request: request()}} : undefined));

      const result = await runCommand(['work', 'answer', WORK_ID, REQUEST_ID, '--no-browser', ...auth]);

      expect(result.exitCode).not.toBe(0);
      expect(result.error?.message).toContain('sift work approve');
    });
  });

  describe('follower and attach queue', () => {
    const followerOptions = (records: WatchRecord[], overrides: Partial<ConstructorParameters<typeof WorkItemFollower>[1]> = {}) => ({
      workItemId: WORK_ID,
      afterSequence: 0,
      backlog: 0,
      waitMs: 1000,
      timeoutMs: 0,
      once: false,
      exitOnAttemptEnd: true,
      signal: new AbortController().signal,
      emit: (record: WatchRecord) => records.push(record),
      ...overrides,
    });

    it('aborts a stalled final-drain request at the timeout and reports drain_incomplete', async () => {
      calls = [];
      global.fetch = jest.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        calls.push({method: 'GET', url, headers: {}});
        const reply = (body: unknown) => Promise.resolve({ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body), json: async () => body} as Response);
        if (url.pathname === `${BASE}/execution`) {
          // Live before the start, ended at the first refresh: the follower drains straight away.
          const reads = calls.filter(entry => entry.url.pathname === `${BASE}/execution`).length;
          return reply(execution(reads >= 2 ? 'ended' : 'running'));
        }
        if (url.pathname === `${BASE}/runtime-requests`) return reply({version: 1, requests: []});
        if (url.pathname === `${BASE}/runtime-controls`) return reply({version: 1, controls: [], truncated: false});
        // The ledger read never answers; only an abort ends it.
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true});
        });
      }) as typeof fetch;
      const records: WatchRecord[] = [];
      const started = Date.now();
      const follower = new WorkItemFollower(new WorkRuntimeApi({apiUrl: 'https://siftable.io', token: 't'}), followerOptions(records, {timeoutMs: 300}));

      await expect(follower.run()).resolves.toBe('drain_incomplete');
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(records.at(-2)).toEqual({version: 1, type: 'drain_incomplete', cause: 'timeout', afterSequence: 0});
      expect(records.at(-1)).toEqual({version: 1, type: 'end', reason: 'drain_incomplete', afterSequence: 0});
      expect(records.some(record => record.type === 'end' && record.reason === 'signal')).toBe(false);
    });

    /** Answers every read except those whose path matches `stall`, which end only on abort. */
    function stallingApi(stall: (path: string) => boolean, executionState: (reads: number) => string): void {
      calls = [];
      global.fetch = jest.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        calls.push({method: 'GET', url, headers: {}});
        if (stall(url.pathname)) {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true});
          });
        }
        const reply = (body: unknown) => Promise.resolve({ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body), json: async () => body} as Response);
        if (url.pathname === `${BASE}/execution`) {
          const reads = calls.filter(entry => entry.url.pathname === `${BASE}/execution`).length;
          return reply(execution(executionState(reads)));
        }
        if (url.pathname === `${BASE}/events`) return reply({version: 1, events: [], nextSequence: null});
        if (url.pathname === `${BASE}/runtime-requests`) return reply({version: 1, requests: []});
        if (url.pathname === `${BASE}/runtime-controls`) return reply({version: 1, controls: [], truncated: false});
        return reply({version: 1, events: [], nextSequence: null, timedOut: true});
      }) as typeof fetch;
    }

    it('ends with signal, after beforeEnd, when Ctrl-C arrives during the final drain', async () => {
      stallingApi(path => path === `${BASE}/events`, reads => (reads >= 2 ? 'ended' : 'running'));
      const caller = new AbortController();
      const records: WatchRecord[] = [];
      let settled = false;
      const follower = new WorkItemFollower(new WorkRuntimeApi({apiUrl: 'https://siftable.io', token: 't'}), followerOptions(records, {
        signal: caller.signal,
        timeoutMs: 30_000,
        beforeEnd: async () => { settled = true; },
      }));
      setTimeout(() => caller.abort(), 100);

      await expect(follower.run()).resolves.toBe('signal');
      expect(settled).toBe(true);
      expect(records.at(-1)).toEqual({version: 1, type: 'end', reason: 'signal', afterSequence: 0});
      expect(records.some(record => record.type === 'drain_incomplete')).toBe(false);
    });

    it('ends with timeout when a start-scan page stalls', async () => {
      stallingApi(path => path === `${BASE}/events`, () => 'running');
      const records: WatchRecord[] = [];
      const started = Date.now();
      const follower = new WorkItemFollower(new WorkRuntimeApi({apiUrl: 'https://siftable.io', token: 't'}), followerOptions(records, {
        afterSequence: undefined,
        timeoutMs: 300,
      }));

      await expect(follower.run()).resolves.toBe('timeout');
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(records.map(record => record.type)).toEqual(['end']);
      expect(records[0]).toMatchObject({reason: 'timeout'});
    });

    it('ends with timeout when the long-poll stalls', async () => {
      stallingApi(path => path === `${BASE}/events/wait`, () => 'running');
      const records: WatchRecord[] = [];
      const started = Date.now();
      const follower = new WorkItemFollower(new WorkRuntimeApi({apiUrl: 'https://siftable.io', token: 't'}), followerOptions(records, {timeoutMs: 300}));

      await expect(follower.run()).resolves.toBe('timeout');
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(records.map(record => record.type)).toEqual(['snapshot', 'end']);
      expect(records.at(-1)).toMatchObject({reason: 'timeout'});
    });

    it('ends with signal, not timeout, when Ctrl-C interrupts a stalled long-poll', async () => {
      stallingApi(path => path === `${BASE}/events/wait`, () => 'running');
      const caller = new AbortController();
      const records: WatchRecord[] = [];
      const follower = new WorkItemFollower(new WorkRuntimeApi({apiUrl: 'https://siftable.io', token: 't'}), followerOptions(records, {
        signal: caller.signal,
        timeoutMs: 30_000,
      }));
      setTimeout(() => caller.abort(), 100);

      await expect(follower.run()).resolves.toBe('signal');
      expect(records.at(-1)).toMatchObject({type: 'end', reason: 'signal'});
    });

    it.each([
      ['Ctrl-C', 'signal'],
      ['the timeout', 'timeout'],
    ] as const)('reports a stalled attach control as unconfirmed when %s stops the watch', async (_label, cause) => {
      installApi(call => {
        const path = call.url.pathname;
        if (call.method === 'POST' && path === `${BASE}/runtime-controls`) return STALL;
        if (path === `${BASE}/events/wait`) return STALL;
        if (path === `${BASE}/execution`) return {status: 200, body: execution('running')};
        if (path === `${BASE}/runtime-requests`) return {status: 200, body: {version: 1, requests: []}};
        if (path === `${BASE}/runtime-controls`) return {status: 200, body: {version: 1, controls: [], truncated: false}};
        return undefined;
      });
      const caller = new AbortController();
      const records: WatchRecord[] = [];
      const api = new WorkRuntimeApi({apiUrl: 'https://siftable.io', token: 't'});
      let follower: WorkItemFollower | undefined;
      const notSent: string[] = [];
      const queue = new ControlInputQueue(async line => {
        const outcome = await submitAttachControl(api, WORK_ID, {kind: 'instruction', instruction: line}, follower!);
        if (outcome.status === 'sent' || outcome.status === 'unconfirmed') records.push(outcome.record);
        else if (outcome.status === 'not_sent') notSent.push(line);
      });
      follower = new WorkItemFollower(api, followerOptions(records, {
        signal: caller.signal,
        timeoutMs: cause === 'timeout' ? 400 : 30_000,
        beforeEnd: () => queue.close(),
      }));
      const running = follower.run();
      await new Promise(resolve => setTimeout(resolve, 50));
      queue.submit('Also update the README');
      queue.submit('never sent');
      if (cause === 'signal') setTimeout(() => caller.abort(), 150);
      const started = Date.now();

      await expect(running).resolves.toBe(cause);
      expect(Date.now() - started).toBeLessThan(5_000);
      const post = calls.filter(call => call.method === 'POST');
      expect(post).toHaveLength(1);
      const tail = records.slice(-2);
      expect(tail[0]).toEqual({
        version: 1,
        type: 'control_unconfirmed',
        kind: 'instruction',
        instruction: 'Also update the README',
        idempotencyKey: post[0].headers['Idempotency-Key'],
        cause,
        httpStatus: null,
      });
      expect(tail[1]).toMatchObject({type: 'end', reason: cause});
      expect(records.some(record => record.type === 'control')).toBe(false);
      // The line queued behind the stalled one is never posted once the watch stops.
      expect(notSent).toEqual(['never sent']);
    });

    it('aborts a stalled attach control and closes the queue when the watch fails', async () => {
      let controlAborted = false;
      let unconfirmedCause: string | undefined;
      installApi(call => {
        const path = call.url.pathname;
        if (call.method === 'POST' && path === `${BASE}/runtime-controls`) return STALL;
        if (path === `${BASE}/execution`) return {status: 200, body: execution('running')};
        if (path === `${BASE}/runtime-requests`) return {status: 200, body: {version: 1, requests: []}};
        if (path === `${BASE}/runtime-controls`) return {status: 200, body: {version: 1, controls: [], truncated: false}};
        return undefined;
      });
      // The long-poll fails outright while the control is still stalled.
      const mocked = global.fetch;
      global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).includes('/events/wait')) return mocked(input, init);
        await new Promise(resolve => setTimeout(resolve, 150));
        return {
          ok: false,
          status: 500,
          headers: new Headers({'content-type': 'application/json'}),
          text: async () => JSON.stringify({error: 'boom'}),
          json: async () => ({error: 'boom'}),
        } as Response;
      });
      const records: WatchRecord[] = [];
      const api = new WorkRuntimeApi({apiUrl: 'https://siftable.io', token: 't'});
      let follower: WorkItemFollower | undefined;
      let queueClosed = false;
      const queue = new ControlInputQueue(async line => {
        const outcome = await submitAttachControl(api, WORK_ID, {kind: 'instruction', instruction: line}, follower!);
        if (outcome.status === 'unconfirmed') {
          controlAborted = true;
          if (outcome.record.type === 'control_unconfirmed') unconfirmedCause = outcome.record.cause;
        }
      });
      follower = new WorkItemFollower(api, followerOptions(records, {
        waitMs: 20,
        beforeEnd: async () => {
          await queue.close();
          queueClosed = true;
        },
      }));
      const running = follower.run();
      await new Promise(resolve => setTimeout(resolve, 50));
      queue.submit('Also update the README');
      const started = Date.now();

      await expect(running).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(controlAborted).toBe(true);
      expect(unconfirmedCause).toBe('watch_failed');
      expect(queueClosed).toBe(true);
    });

    it('runs beforeEnd once when it rejects during a normal end', async () => {
      installApi(call => {
        const path = call.url.pathname;
        if (path === `${BASE}/events`) return {status: 200, body: {version: 1, events: [], nextSequence: null}};
        if (path === `${BASE}/execution`) return {status: 200, body: execution('running')};
        if (path === `${BASE}/runtime-requests`) return {status: 200, body: {version: 1, requests: []}};
        if (path === `${BASE}/runtime-controls`) return {status: 200, body: {version: 1, controls: [], truncated: false}};
        return undefined;
      });
      let calls = 0;
      const follower = new WorkItemFollower(new WorkRuntimeApi({apiUrl: 'https://siftable.io', token: 't'}), followerOptions([], {
        once: true,
        beforeEnd: async () => {
          calls += 1;
          throw new Error('close failed');
        },
      }));

      await expect(follower.run()).rejects.toThrow('close failed');
      expect(calls).toBe(1);
    });

    describe('attach control failures after retries', () => {
      const live = {activeSignal: new AbortController().signal, stopCause: null};
      const api = () => new WorkRuntimeApi({apiUrl: 'https://siftable.io', token: 't'});
      const send = () => submitAttachControl(api(), WORK_ID, {kind: 'instruction', instruction: 'Also update the README'}, live, {retries: 1, retryDelayMs: 0});

      it.each([
        ['every attempt answers 503', {status: 503, body: {error: 'unavailable'}}, 'http', 503],
        ['every attempt answers 408', {status: 408, body: {error: 'timeout'}}, 'http', 408],
        ['a 4xx has no parseable refusal', {status: 400, body: 'Bad Request'}, 'http', 400],
        ['no response body can be read', {status: 201, body: {}, bodyError: true}, 'transport', null],
      ] as const)('keeps the key as control_unconfirmed when %s', async (_label, reply, cause, httpStatus) => {
        installApi(call => (call.method === 'POST' ? reply as never : undefined));

        const outcome = await send();

        const key = calls[0].headers['Idempotency-Key'];
        expect(calls.every(call => call.headers['Idempotency-Key'] === key)).toBe(true);
        expect(outcome).toEqual({
          status: 'unconfirmed',
          record: {version: 1, type: 'control_unconfirmed', kind: 'instruction', instruction: 'Also update the README', idempotencyKey: key, cause, httpStatus},
        });
      });

      it('stays unconfirmed when a lost response is followed by a parsed 429 and 409', async () => {
        installApi((call, all) => {
          if (call.method !== 'POST') return undefined;
          const posts = all.filter(entry => entry.method === 'POST').length;
          if (posts === 1) return {status: 201, body: {}, bodyError: true};
          if (posts === 2) return {status: 429, body: {error: 'Too many requests'}};
          return {status: 409, body: {error: 'Idempotency key in use'}};
        });

        const outcome = await submitAttachControl(api(), WORK_ID, {kind: 'instruction', instruction: 'Also update the README'}, live, {retries: 2, retryDelayMs: 0});

        expect(calls).toHaveLength(3);
        expect(outcome).toEqual({
          status: 'unconfirmed',
          record: {
            version: 1, type: 'control_unconfirmed', kind: 'instruction', instruction: 'Also update the README',
            idempotencyKey: calls[0].headers['Idempotency-Key'], cause: 'transport', httpStatus: null,
          },
        });
      });

      it('reports a parsed 4xx refusal as not accepted', async () => {
        installApi(call => (call.method === 'POST' ? {status: 409, body: {error: 'This work has no running execution to receive the control'}} : undefined));

        await expect(send()).resolves.toEqual({status: 'refused', httpStatus: 409});
        expect(calls).toHaveLength(1);
      });
    });

    it.each([
      ['Ctrl-C', 'signal'],
      ['the timeout', 'timeout'],
    ] as const)('ends with %s, not attempt_ended, when it stops a control stalled during queue shutdown', async (_label, cause) => {
      installApi((call, all) => {
        const path = call.url.pathname;
        if (call.method === 'POST' && path === `${BASE}/runtime-controls`) return STALL;
        // The attempt ends only once the control POST is in flight.
        if (path === `${BASE}/execution`) return {status: 200, body: execution(all.some(entry => entry.method === 'POST') ? 'ended' : 'running')};
        if (path === `${BASE}/events/wait`) return {status: 200, body: {version: 1, events: [], nextSequence: null, consumerKey: 'default', timedOut: true}};
        if (path === `${BASE}/events`) return {status: 200, body: {version: 1, events: [], nextSequence: null}};
        if (path === `${BASE}/runtime-requests`) return {status: 200, body: {version: 1, requests: []}};
        if (path === `${BASE}/runtime-controls`) return {status: 200, body: {version: 1, controls: [], truncated: false}};
        return undefined;
      });
      const caller = new AbortController();
      const records: WatchRecord[] = [];
      const api = new WorkRuntimeApi({apiUrl: 'https://siftable.io', token: 't'});
      let follower: WorkItemFollower | undefined;
      let shuttingDown = false;
      const queue = new ControlInputQueue(async line => {
        const outcome = await submitAttachControl(api, WORK_ID, {kind: 'instruction', instruction: line}, follower!);
        if (outcome.status === 'unconfirmed') records.push(outcome.record);
      });
      follower = new WorkItemFollower(api, followerOptions(records, {
        signal: caller.signal,
        waitMs: 1000,
        timeoutMs: cause === 'timeout' ? 600 : 30_000,
        beforeEnd: async () => {
          shuttingDown = true;
          if (cause === 'signal') setTimeout(() => caller.abort(), 100);
          await queue.close();
        },
      }));
      queue.submit('Also update the README');

      await expect(follower.run()).resolves.toBe(cause);
      expect(shuttingDown).toBe(true);
      expect(records.at(-2)).toMatchObject({type: 'control_unconfirmed', cause, httpStatus: null});
      expect(records.at(-1)).toMatchObject({type: 'end', reason: cause});
      expect(records.some(record => record.type === 'end' && record.reason === 'attempt_ended')).toBe(false);
    });

    it('aborts a stalled attach control when a refresh crosses the deadline before the timer fires', async () => {
      installApi(call => {
        const path = call.url.pathname;
        if (call.method === 'POST' && path === `${BASE}/runtime-controls`) return STALL;
        if (path === `${BASE}/execution`) return {status: 200, body: execution('running')};
        if (path === `${BASE}/events/wait`) return {status: 200, body: {version: 1, events: [], nextSequence: null, consumerKey: 'default', timedOut: true}};
        if (path === `${BASE}/runtime-requests`) return {status: 200, body: {version: 1, requests: []}};
        if (path === `${BASE}/runtime-controls`) return {status: 200, body: {version: 1, controls: [], truncated: false}};
        return undefined;
      });
      const records: WatchRecord[] = [];
      const api = new WorkRuntimeApi({apiUrl: 'https://siftable.io', token: 't'});
      let follower: WorkItemFollower | undefined;
      const queue = new ControlInputQueue(async line => {
        const outcome = await submitAttachControl(api, WORK_ID, {kind: 'instruction', instruction: line}, follower!);
        if (outcome.status === 'unconfirmed') records.push(outcome.record);
      });
      // The clock jumps past the deadline once the control POST is in flight;
      // the real 30 s timer has not fired, so only the elapsed check can stop it.
      const now = () => (calls.some(call => call.method === 'POST') ? 1_000_000 : 0);
      follower = new WorkItemFollower(api, followerOptions(records, {
        waitMs: 1000,
        timeoutMs: 30_000,
        now,
        beforeEnd: () => queue.close(),
      }));
      queue.submit('Also update the README');
      const started = Date.now();

      await expect(follower.run()).resolves.toBe('timeout');
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
      expect(records.at(-2)).toMatchObject({type: 'control_unconfirmed', cause: 'timeout', httpStatus: null});
      expect(records.at(-1)).toMatchObject({type: 'end', reason: 'timeout'});
    });

    function attemptEndsDuringScan(before: unknown, after: unknown): void {
      installApi(call => {
        const path = call.url.pathname;
        if (path === `${BASE}/execution`) {
          const reads = calls.filter(entry => entry.url.pathname === `${BASE}/execution`).length;
          return {status: 200, body: reads === 1 ? before : after};
        }
        if (path === `${BASE}/events`) return {status: 200, body: {version: 1, events: [event(1)], nextSequence: 1}};
        if (path === `${BASE}/events/wait`) return {status: 200, body: {version: 1, events: [], nextSequence: null, consumerKey: 'default', timedOut: true}};
        if (path === `${BASE}/runtime-requests`) return {status: 200, body: {version: 1, requests: []}};
        if (path === `${BASE}/runtime-controls`) return {status: 200, body: {version: 1, controls: [], truncated: false}};
        return undefined;
      });
    }

    it.each([
      ['was live before the scan', execution('running'), execution('ended')],
      ['started and ended during the scan', {version: 1, workspace: null, currentAttempt: null, currentLeaseActive: false, attempts: []}, execution('ended')],
    ])('drains and ends when the attempt %s', async (_label, before, after) => {
      attemptEndsDuringScan(before, after);

      const result = await runCommand(['work', 'watch', WORK_ID, '--wait-ms', '1000', '--timeout', '30', '--json', ...auth]);

      expect(result.exitCode).toBe(0);
      const records = jsonLines(result.stdout);
      expect(records.at(-1)).toEqual({version: 1, type: 'end', reason: 'attempt_ended', afterSequence: 1});
      expect(calls.some(call => call.url.pathname === `${BASE}/events/wait`)).toBe(false);
    });

    it('keeps following with --keep-following when the attempt ended during the scan', async () => {
      attemptEndsDuringScan(execution('running'), execution('ended'));

      const result = await runCommand(['work', 'watch', WORK_ID, '--keep-following', '--wait-ms', '1000', '--timeout', '1', '--json', ...auth]);

      expect(result.exitCode).toBe(0);
      expect(jsonLines(result.stdout).at(-1)).toMatchObject({type: 'end', reason: 'timeout'});
      expect(calls.some(call => call.url.pathname === `${BASE}/events/wait`)).toBe(true);
    });

    it('does not treat an attempt that ended before the watch began as live', async () => {
      attemptEndsDuringScan(execution('ended'), execution('ended'));

      const result = await runCommand(['work', 'watch', WORK_ID, '--wait-ms', '1000', '--timeout', '1', '--json', ...auth]);

      expect(jsonLines(result.stdout).at(-1)).toMatchObject({type: 'end', reason: 'timeout'});
    });

    it('stops the final drain at the timeout and reports drain_incomplete', async () => {
      endlessLedgerForApi();
      let clock = 0;
      const records: WatchRecord[] = [];
      const follower = new WorkItemFollower(new WorkRuntimeApi({apiUrl: 'https://siftable.io', token: 't'}), {
        workItemId: WORK_ID,
        afterSequence: 0,
        backlog: 0,
        waitMs: 1000,
        timeoutMs: 10_000,
        once: false,
        exitOnAttemptEnd: true,
        signal: new AbortController().signal,
        emit: record => records.push(record),
        // Every read of the clock advances it, so the drain runs out of time after a few pages.
        now: () => (clock += 1_000),
      });

      await expect(follower.run()).resolves.toBe('drain_incomplete');
      expect(records.at(-2)).toMatchObject({type: 'drain_incomplete', cause: 'timeout'});
      expect(calls.filter(call => call.url.pathname === `${BASE}/events`).length).toBeLessThan(MAX_DRAIN_PAGES);
    });

    it('writes the end record only after beforeEnd settles', async () => {
      endlessLedgerForApi();
      const order: string[] = [];
      const follower = new WorkItemFollower(new WorkRuntimeApi({apiUrl: 'https://siftable.io', token: 't'}), {
        workItemId: WORK_ID,
        afterSequence: 0,
        backlog: 0,
        waitMs: 1000,
        timeoutMs: 0,
        once: true,
        exitOnAttemptEnd: true,
        signal: new AbortController().signal,
        emit: record => order.push(record.type),
        beforeEnd: async () => {
          await new Promise(resolve => setTimeout(resolve, 20));
          order.push('controls-settled');
        },
      });

      await follower.run();
      expect(order).toEqual(['snapshot', 'controls-settled', 'end']);
    });

    it('sends queued lines one at a time in input order and waits for them on close', async () => {
      const started: string[] = [];
      const finished: string[] = [];
      const queue = new ControlInputQueue(async line => {
        started.push(line);
        // The first line takes longest; a concurrent sender would finish it last.
        await new Promise(resolve => setTimeout(resolve, line === 'first' ? 30 : 1));
        finished.push(line);
      });

      queue.submit('first');
      queue.submit('second');
      queue.submit('third');
      await queue.close();
      queue.submit('after close');
      await queue.idle();

      expect(started).toEqual(['first', 'second', 'third']);
      expect(finished).toEqual(['first', 'second', 'third']);
    });
  });

  describe('helpers', () => {
    it('treats only a parsed 4xx refusal as a definite failure', () => {
      expect(isAmbiguousControlFailure({status: 409, error: '{"error":"conflict"}'})).toBe(false);
      expect(isAmbiguousControlFailure({status: 429, error: '{"error":"slow down"}'})).toBe(false);
      for (const failure of [{status: 0, error: ''}, {status: 408, error: '{}'}, {status: 500, error: '{}'}, {status: 404, error: '<html>'}, {status: 400, error: '"text"'}]) {
        expect(isAmbiguousControlFailure(failure)).toBe(true);
      }
    });

    it('treats transport failures, 408, 429 and every 5xx as retryable', () => {
      for (const status of [0, 408, 429, 500, 501, 503, 507, 520, 599]) expect(isRetryableControlStatus(status)).toBe(true);
      for (const status of [400, 401, 403, 404, 409, 422, 600]) expect(isRetryableControlStatus(status)).toBe(false);
    });

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

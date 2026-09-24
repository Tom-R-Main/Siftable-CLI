/**
 * Wire-protocol tests for CodexClient — the JSON-RPC plumbing over the
 * `codex app-server` stdio that the pure-mapper tests (interactive.codex.test.ts)
 * don't reach: handshake, request/response correlation, newline framing across
 * chunks, out-of-order notifications, error propagation, unexpected-exit
 * failAll, server→client approval routing, and shutdown reaping.
 *
 * All driven through an injected FakeCodexProc — no real binary is spawned.
 */
import {mkdtemp, mkdir, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  CodexClient,
  codexAsk,
  ensureThread,
  shutdownCodex,
  closeCodex,
  getCodexAccount,
  __resetCodexThreadsForTests,
  __setCodexClientForTests,
  type CodexSpawnFn,
} from '../../interactive-tui/codexEngine';
import {closeBrain, setBrainModel, getBrainModel} from '../../interactive-tui/brain';
import {SessionServer, WireEventLog} from '../../interactive-tui/sessionServer';
import {JsonlSessionEventStore} from '../../interactive-tui/agent-harness/framework/session';
import * as confirmGateModule from '../../interactive-tui/confirmGate';
import * as questionGateModule from '../../interactive-tui/questionGate';
import {getSessionCwd, setSessionCwd} from '../../interactive-tui/navigation';
import {
  isBypassing,
  pendingConfirmCount,
  rejectAllConfirms,
  requestApproval,
  resetBypass,
  resolveApproval,
  setConfirmCancellationListener,
  setConfirmListener,
  type ConfirmRequest,
} from '../../interactive-tui/confirmGate';
import {
  FakeCodexProc,
  completeHandshake,
  waitForSent,
  waitForSentWhere,
} from '../helpers/fake-codex-proc';

/** A ready client wired to a fresh fake, past the initialize handshake. */
async function readyClient(): Promise<{ client: CodexClient; proc: FakeCodexProc }> {
  const proc = new FakeCodexProc();
  const client = new CodexClient(proc.asSpawnFn());
  const ready = client.ensureReady();
  await completeHandshake(proc);
  await ready;
  return { client, proc };
}

describe('CodexClient handshake', () => {
  it('drives initialize → initialized and resolves ensureReady', async () => {
    const proc = new FakeCodexProc();
    const client = new CodexClient(proc.asSpawnFn());
    const ready = client.ensureReady();

    const initId = await waitForSent(proc, 'initialize');
    expect(initId).toBe(1);
    const init = proc.sent.find((m) => m.method === 'initialize')!;
    expect(init.params).toMatchObject({ clientInfo: { name: 'sift_tui' } });

    proc.reply(initId, { capabilities: {} });
    await waitForSent(proc, 'initialized');
    await expect(ready).resolves.toBeUndefined();

    // ensureReady is memoized — a second call must not re-spawn / re-handshake.
    await expect(client.ensureReady()).resolves.toBeUndefined();
    expect(proc.sent.filter((m) => m.method === 'initialize')).toHaveLength(1);
  });

  it('surfaces a spawn error (ENOENT) to ensureReady waiters', async () => {
    const client = new CodexClient(() => {
      throw new Error('spawn codex ENOENT');
    });
    await expect(client.ensureReady()).rejects.toThrow(/ENOENT/);
  });

  it('tears down a rejected initialize generation and reconnects cleanly', async () => {
    const procs: FakeCodexProc[] = [];
    const client = new CodexClient(() => {
      const proc = new FakeCodexProc();
      procs.push(proc);
      return proc as unknown as ReturnType<CodexSpawnFn>;
    });

    let ready = client.ensureReady();
    const rejectedInitId = await waitForSent(procs[0], 'initialize');
    procs[0].replyError(rejectedInitId, 'initialize rejected');
    await expect(ready).rejects.toThrow('initialize rejected');

    expect(procs[0].killed).toBe(true);
    expect(procs[0].killSignal).toBe('SIGTERM');
    expect(procs[0].listenerCount('error')).toBe(0);
    expect(procs[0].listenerCount('exit')).toBe(0);
    expect(procs[0].stdout.listenerCount('data')).toBe(0);

    ready = client.ensureReady();
    await completeHandshake(procs[1]);
    await ready;

    const request = client.request('thread/start', {});
    const requestId = await waitForSent(procs[1], 'thread/start');
    procs[1].reply(requestId, { threadId: 'fresh-after-init-failure' });
    await expect(request).resolves.toEqual({ threadId: 'fresh-after-init-failure' });
  });
});

describe('CodexClient request/response correlation', () => {
  it('resolves a request with the response keyed to its id', async () => {
    const { client, proc } = await readyClient();
    const p = client.request('thread/start', { foo: 1 });
    const id = await waitForSent(proc, 'thread/start');
    expect(id).toBe(2); // handshake consumed id 1
    proc.reply(id, { threadId: 't1' });
    await expect(p).resolves.toEqual({ threadId: 't1' });
  });

  it('reassembles a response split across two stdout chunks', async () => {
    const { client, proc } = await readyClient();
    const p = client.request('thread/start', {});
    const id = await waitForSent(proc, 'thread/start');
    proc.writeRaw(`{"jsonrpc":"2.0","id":${id},"resu`);
    proc.writeRaw(`lt":{"ok":true}}\n`);
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('does not cross-resolve when responses arrive out of order', async () => {
    const { client, proc } = await readyClient();
    const a = client.request('a/op', {});
    const b = client.request('b/op', {});
    const idA = await waitForSent(proc, 'a/op');
    const idB = await waitForSent(proc, 'b/op');
    // Reply to B first, then A.
    proc.reply(idB, { who: 'b' });
    proc.reply(idA, { who: 'a' });
    await expect(a).resolves.toEqual({ who: 'a' });
    await expect(b).resolves.toEqual({ who: 'b' });
  });

  it('rejects a request when the server returns an error', async () => {
    const { client, proc } = await readyClient();
    const p = client.request('thread/start', {});
    const id = await waitForSent(proc, 'thread/start');
    proc.replyError(id, 'boom');
    await expect(p).rejects.toThrow('boom');
  });

  it('ignores non-JSON lines and still processes the next valid response', async () => {
    const { client, proc } = await readyClient();
    const p = client.request('thread/start', {});
    const id = await waitForSent(proc, 'thread/start');
    proc.writeRaw('this is not json\n');
    proc.reply(id, { ok: true });
    await expect(p).resolves.toEqual({ ok: true });
  });
});

describe('CodexClient notifications', () => {
  it('fans notifications out to listeners, interleaved with pending requests', async () => {
    const { client, proc } = await readyClient();
    const events: Array<[string, unknown]> = [];
    const off = client.onNotification((m, params) => events.push([m, params]));

    const p = client.request('turn/start', {});
    const id = await waitForSent(proc, 'turn/start');
    // Notification arrives BEFORE the response to the in-flight request.
    proc.notify('item/agentMessage/delta', { delta: 'hi' });
    proc.reply(id, { ok: true });
    await p;

    expect(events).toContainEqual(['item/agentMessage/delta', { delta: 'hi' }]);
    off();
    proc.notify('item/agentMessage/delta', { delta: 'after-off' });
    expect(events).toHaveLength(1); // unsubscribed listener gets nothing more
  });
});

describe('CodexClient unexpected exit', () => {
  it('rejects every pending request when the app-server exits', async () => {
    const { client, proc } = await readyClient();
    const a = client.request('a/op', {});
    const b = client.request('b/op', {});
    await waitForSent(proc, 'a/op');
    await waitForSent(proc, 'b/op');
    proc.exit(1);
    await expect(a).rejects.toThrow('codex app-server exited');
    await expect(b).rejects.toThrow('codex app-server exited');
  });

  it('rejects a request made after exit before a replacement generation starts', async () => {
    const procs: FakeCodexProc[] = [];
    const client = new CodexClient(() => {
      const proc = new FakeCodexProc();
      procs.push(proc);
      return proc as unknown as ReturnType<CodexSpawnFn>;
    });

    let ready = client.ensureReady();
    await completeHandshake(procs[0]);
    await ready;

    procs[0].exit(1);
    await expect(client.request('thread/start', {})).rejects.toThrow(
      'codex app-server disconnected',
    );
    expect(procs).toHaveLength(1);
    expect(procs[0].sent.filter((message) => message.method === 'thread/start')).toHaveLength(0);

    ready = client.ensureReady();
    await completeHandshake(procs[1]);
    await ready;
    const request = client.request('thread/start', {});
    const requestId = await waitForSent(procs[1], 'thread/start');
    procs[1].reply(requestId, { threadId: 'replacement-thread' });
    await expect(request).resolves.toEqual({ threadId: 'replacement-thread' });
  });
});

describe('codexAsk generation disconnects', () => {
  const startCount = (proc: FakeCodexProc) =>
    proc.sent.filter((m) => m.method === 'thread/start').length;

  async function readyInjectedClient(): Promise<{
    client: CodexClient;
    procs: FakeCodexProc[];
  }> {
    const procs: FakeCodexProc[] = [];
    const spawnFresh: CodexSpawnFn = () => {
      const proc = new FakeCodexProc();
      procs.push(proc);
      return proc as unknown as ReturnType<CodexSpawnFn>;
    };
    const client = new CodexClient(spawnFresh);
    const ready = client.ensureReady();
    await completeHandshake(procs[0]);
    await ready;
    __setCodexClientForTests(client, { type: 'chatgpt', email: 'test@example.com' });
    return { client, procs };
  }

  async function startAcknowledgedTurn(proc: FakeCodexProc): Promise<{
    result: ReturnType<typeof codexAsk>;
    events: Array<{ type: string }>;
  }> {
    const events: Array<{ type: string }> = [];
    const result = codexAsk('continue', (event) => events.push(event));
    const threadStartId = await waitForSent(proc, 'thread/start');
    proc.reply(threadStartId, { thread: { id: 'thread-generation-1' } });
    const turnStartId = await waitForSent(proc, 'turn/start');
    proc.reply(turnStartId, { turn: { id: 'turn-generation-1' } });
    proc.notify('item/agentMessage/delta', {
      threadId: 'thread-generation-1',
      turnId: 'turn-generation-1',
      delta: 'partial reply',
    });
    return { result, events };
  }

  afterEach(() => {
    shutdownCodex();
    __setCodexClientForTests(null);
  });

  it('returns assembled text plus an error when the server exits after turn/start ACK', async () => {
    const { client, procs } = await readyInjectedClient();
    const { result, events } = await startAcknowledgedTurn(procs[0]);

    procs[0].exit(1);

    await expect(result).resolves.toEqual({
      text: 'partial reply',
      error: 'codex app-server exited',
    });
    expect(events).toContainEqual({ type: 'token', content: 'partial reply' });
    expect(procs[0].stdout.listenerCount('data')).toBe(0);
    expect(procs[0].listenerCount('error')).toBe(0);
    expect(procs[0].listenerCount('exit')).toBe(0);

    const ready = client.ensureReady();
    await completeHandshake(procs[1]);
    await ready;
    procs[1].notify('item/agentMessage/delta', {
      threadId: 'thread-generation-1',
      turnId: 'turn-generation-1',
      delta: 'late notification',
    });
    expect(events).toEqual([{ type: 'token', content: 'partial reply' }]);
    const freshThread = ensureThread(client);
    const freshThreadStartId = await waitForSent(procs[1], 'thread/start');
    procs[1].reply(freshThreadStartId, { thread: { id: 'thread-generation-2' } });
    await expect(freshThread).resolves.toBe('thread-generation-2');
    expect(startCount(procs[1])).toBe(1);
  });

  it('terminates a runtime-error generation and ignores its late exit after respawn', async () => {
    const { client, procs } = await readyInjectedClient();
    const { result } = await startAcknowledgedTurn(procs[0]);

    procs[0].fail(new Error('runtime transport failure'));

    await expect(result).resolves.toEqual({
      text: 'partial reply',
      error: 'runtime transport failure',
    });
    expect(procs[0].killed).toBe(true);
    expect(procs[0].killSignal).toBe('SIGTERM');
    expect(procs[0].stdout.listenerCount('data')).toBe(0);
    expect(procs[0].listenerCount('error')).toBe(0);
    expect(procs[0].listenerCount('exit')).toBe(0);

    const ready = client.ensureReady();
    await completeHandshake(procs[1]);
    await ready;
    const freshThread = ensureThread(client);
    const freshThreadStartId = await waitForSent(procs[1], 'thread/start');
    procs[1].reply(freshThreadStartId, { thread: { id: 'thread-generation-2' } });
    await expect(freshThread).resolves.toBe('thread-generation-2');

    procs[0].exit(1);
    await expect(ensureThread(client)).resolves.toBe('thread-generation-2');
    expect(startCount(procs[1])).toBe(1);
  });
});

describe('codexAsk cancellation (AGENT-RUNTIME-31)', () => {
  async function injected(): Promise<FakeCodexProc> {
    const proc = new FakeCodexProc();
    const client = new CodexClient(proc.asSpawnFn());
    const ready = client.ensureReady();
    await completeHandshake(proc);
    await ready;
    __setCodexClientForTests(client, { type: 'chatgpt', email: 'test@example.com' });
    return proc;
  }
  async function startTurn(proc: FakeCodexProc, signal: AbortSignal, stopTimeoutMs?: number) {
    let settled = false;
    const result = codexAsk('continue', () => {}, { signal, ...(stopTimeoutMs ? { stopTimeoutMs } : {}) });
    void result.then(() => { settled = true; });
    proc.reply(await waitForSent(proc, 'thread/start'), { thread: { id: 'thread-stop' } });
    proc.reply(await waitForSent(proc, 'turn/start'), { turn: { id: 'turn-stop' } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { result, isSettled: () => settled };
  }

  afterEach(() => {
    shutdownCodex();
    __setCodexClientForTests(null);
  });

  it('resolves only after app-server reports the interrupted turn completed', async () => {
    const proc = await injected();
    const controller = new AbortController();
    const { result, isSettled } = await startTurn(proc, controller.signal);
    controller.abort();
    const interruptId = await waitForSent(proc, 'turn/interrupt');
    expect(proc.sent.find((m) => m.id === interruptId)?.params).toEqual({ threadId: 'thread-stop', turnId: 'turn-stop' });
    proc.reply(interruptId, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The interrupt ACK alone does not prove the turn ended.
    expect(isSettled()).toBe(false);
    proc.notify('turn/completed', { threadId: 'thread-stop', turn: { id: 'turn-stop', status: 'interrupted' } });
    await expect(result).resolves.toEqual({ text: '', status: 'interrupted', stopConfirmed: true });
  });

  it('sums per-response token usage notifications into engineUsage', async () => {
    const proc = await injected();
    const result = codexAsk('continue', () => {});
    proc.reply(await waitForSent(proc, 'thread/start'), { thread: { id: 'thread-usage' } });
    proc.reply(await waitForSent(proc, 'turn/start'), { turn: { id: 'turn-usage' } });
    const breakdown = (input: number, output: number) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: 1,
      cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 });
    for (const last of [breakdown(10, 2), breakdown(20, 3)]) {
      proc.notify('thread/tokenUsage/updated', { threadId: 'thread-usage', turnId: 'turn-usage',
        tokenUsage: { total: breakdown(99, 99), last, modelContextWindow: null } });
    }
    proc.notify('turn/completed', { threadId: 'thread-usage', turn: { id: 'turn-usage', status: 'completed' } });
    await expect(result).resolves.toEqual({ text: '', status: 'completed',
      engineUsage: { requests: 2, inputTokens: 30, outputTokens: 5, cachedInputTokens: 2, totalTokens: 35 } });
  });

  it('ignores a completion for another turn on the same thread while stopping', async () => {
    const proc = await injected();
    const controller = new AbortController();
    const { result, isSettled } = await startTurn(proc, controller.signal);
    controller.abort();
    proc.reply(await waitForSent(proc, 'turn/interrupt'), {});
    // A late completion of an earlier turn, and one with no turn id, prove nothing.
    proc.notify('turn/completed', { threadId: 'thread-stop', turn: { id: 'turn-earlier', status: 'completed' } });
    proc.notify('turn/completed', { threadId: 'thread-stop', turnId: 'turn-stop' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isSettled()).toBe(false);
    proc.notify('turn/completed', { threadId: 'thread-stop', turn: { id: 'turn-stop', status: 'interrupted' } });
    await expect(result).resolves.toEqual({ text: '', status: 'interrupted', stopConfirmed: true });
  });

  it('holds completions that arrive before the turn/start ACK and settles only on a matching id', async () => {
    const proc = await injected();
    let settled = false;
    const result = codexAsk('continue', () => {});
    void result.then(() => { settled = true; });
    proc.reply(await waitForSent(proc, 'thread/start'), { thread: { id: 'thread-early' } });
    const turnStartId = await waitForSent(proc, 'turn/start');
    // A late completion of an earlier turn arrives before our ACK.
    proc.notify('turn/completed', { threadId: 'thread-early', turn: { id: 'turn-previous', status: 'completed' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    proc.reply(turnStartId, { turn: { id: 'turn-new' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    // Our own completion racing ahead of the ACK is honoured once the ACK names it.
    proc.notify('turn/completed', { threadId: 'thread-early', turn: { id: 'turn-new', status: 'completed' } });
    await expect(result).resolves.toEqual({ text: '', status: 'completed' });
  });

  it('settles a completion that arrived before its ACK once the ACK names it', async () => {
    const proc = await injected();
    const result = codexAsk('continue', () => {});
    proc.reply(await waitForSent(proc, 'thread/start'), { thread: { id: 'thread-race' } });
    const turnStartId = await waitForSent(proc, 'turn/start');
    proc.notify('turn/completed', { threadId: 'thread-race', turn: { id: 'turn-race', status: 'completed' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    proc.reply(turnStartId, { turn: { id: 'turn-race' } });
    await expect(result).resolves.toEqual({ text: '', status: 'completed' });
  });

  for (const [status, expected] of [
    ['completed', { status: 'completed' }],
    ['interrupted', { status: 'interrupted', error: 'Codex turn was interrupted' }],
    ['failed', { status: 'failed', error: 'model overloaded' }],
    ['inProgress', { status: 'failed', error: 'Codex reported turn/completed with status inProgress' }],
  ] as const) {
    it(`maps a ${status} turn/completed explicitly`, async () => {
      const proc = await injected();
      const result = codexAsk('continue', () => {});
      proc.reply(await waitForSent(proc, 'thread/start'), { thread: { id: 'thread-status' } });
      proc.reply(await waitForSent(proc, 'turn/start'), { turn: { id: 'turn-status' } });
      await new Promise((resolve) => setTimeout(resolve, 5));
      proc.notify('turn/completed', { threadId: 'thread-status', turn: { id: 'turn-status', status,
        error: status === 'failed' ? { message: 'model overloaded' } : null } });
      await expect(result).resolves.toEqual({ text: '', ...expected });
    });
  }

  it('reports an unconfirmed stop when app-server never confirms within the bound', async () => {
    const proc = await injected();
    const controller = new AbortController();
    const { result } = await startTurn(proc, controller.signal, 30);
    controller.abort();
    await waitForSent(proc, 'turn/interrupt');
    const outcome = await result;
    expect(outcome).toMatchObject({ status: 'interrupted', stopConfirmed: false });
    expect(outcome.error).toContain('did not confirm');
  });
});

describe('codexAsk cancellation during app-server setup (AGENT-RUNTIME-31)', () => {
  /** A fake whose kill() either ends the child (exit + close) or is ignored. */
  function fakeProc(diesOnKill: boolean): FakeCodexProc {
    const proc = new FakeCodexProc();
    const kill = proc.kill.bind(proc);
    proc.kill = (signal?: NodeJS.Signals | number) => {
      kill(signal);
      if (diesOnKill) setImmediate(() => { proc.emit('exit', null, 'SIGTERM'); proc.emit('close'); });
      return true;
    };
    return proc;
  }
  async function install(proc: FakeCodexProc, stage: 'initialize' | 'thread/start'): Promise<void> {
    const client = new CodexClient(proc.asSpawnFn());
    __setCodexClientForTests(client, { type: 'chatgpt', email: 'test@example.com' });
    if (stage === 'thread/start') {
      const ready = client.ensureReady();
      await completeHandshake(proc);
      await ready;
    }
  }

  afterEach(() => {
    shutdownCodex();
    __setCodexClientForTests(null);
  });

  for (const stage of ['initialize', 'thread/start'] as const) {
    it(`a cancel while app-server stalls at ${stage} is bounded and confirmed once the child is gone`, async () => {
      const proc = fakeProc(true);
      await install(proc, stage);
      const controller = new AbortController();
      const result = codexAsk('continue', () => {}, { signal: controller.signal, stopTimeoutMs: 2_000 });
      await waitForSent(proc, stage);
      const started = Date.now();
      controller.abort();
      await expect(result).resolves.toEqual({ text: '', status: 'interrupted', stopConfirmed: true });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(proc.killed).toBe(true);
      expect(proc.sent.some((m) => m.method === 'turn/start')).toBe(false);
    });

    it(`a cancel while app-server stalls at ${stage} and ignores kill is unconfirmed within the bound`, async () => {
      const proc = fakeProc(false);
      await install(proc, stage);
      const controller = new AbortController();
      const result = codexAsk('continue', () => {}, { signal: controller.signal, stopTimeoutMs: 60 });
      await waitForSent(proc, stage);
      const started = Date.now();
      controller.abort();
      const outcome = await result;
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(outcome).toMatchObject({ status: 'interrupted', stopConfirmed: false });
      expect(outcome.error).toContain('Codex setup');
    });
  }

  it('session: cancel during a stalled initialize ends in exactly one terminal stop, and shutdown completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sift-codex-setup-'));
    try {
      const proc = fakeProc(false);
      await install(proc, 'initialize');
      const lines: Array<Record<string, any>> = [];
      const log = new WireEventLog({rootDir: root, session: 'codex-setup', leaseStore: dir => new JsonlSessionEventStore({rootDir: dir})});
      const server = new SessionServer({session: 'codex-setup', provider: 'codex', model: 'gpt', cwd: root, deadlineMs: 60_000, log,
        write: line => { lines.push(JSON.parse(line)); }, gates: {...confirmGateModule, ...questionGateModule},
        engine: {kind: 'codex', ask: (input, onEvent, signal) => codexAsk(input, onEvent, {signal, stopTimeoutMs: 60}), close: () => closeCodex()}});
      await server.handleLine(JSON.stringify({id: 1, type: 'initialize', protocolVersion: 1}));
      await server.handleLine(JSON.stringify({id: 2, type: 'prompt', input: 'hello'}));
      await waitForSent(proc, 'initialize');
      const started = Date.now();
      await server.handleLine(JSON.stringify({id: 3, type: 'cancel'}));
      const deadline = Date.now() + 2_000;
      while (!lines.some(line => String(line.type).startsWith('turn.stop')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
      expect(Date.now() - started).toBeLessThan(1_000);
      const terminals = lines.filter(line => String(line.type).startsWith('turn.') && line.type !== 'turn.started');
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({type: 'turn.stop_unconfirmed', confirmed: false, reason: 'client'});
      // Shutdown drains the stubborn child within closeCodex's bounded grace.
      const exitCode = await server.shutdown('client');
      expect(exitCode).toBe(1);
      expect(lines.at(-1)).toMatchObject({type: 'session.closed'});
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 15_000);
});

describe('CodexClient server→client approvals', () => {
  afterEach(() => {
    rejectAllConfirms();
    setConfirmCancellationListener(null);
    setConfirmListener(null);
    resetBypass();
  });
  it('routes an approval request through the approver and writes the mapped decision', async () => {
    const { client, proc } = await readyClient();
    const seen: string[] = [];
    client.setApprover(async (req) => {
      seen.push(req.target);
      return 'always';
    });

    proc.serverRequest('srv-1', 'item/commandExecution/requestApproval', { command: 'ls -la' });
    const resp = await waitForSentWhere(proc, (m) => m.id === 'srv-1');
    expect(resp.result).toEqual({ decision: 'acceptForSession' });
    expect(seen).toEqual(['ls -la']);
  });

  it('denies when the approver throws (fail closed)', async () => {
    const { client, proc } = await readyClient();
    client.setApprover(async () => {
      throw new Error('overlay unavailable');
    });
    proc.serverRequest('srv-2', 'applyPatchApproval', { changes: [{ path: 'a.ts' }] });
    const resp = await waitForSentWhere(proc, (m) => m.id === 'srv-2');
    expect(resp.result).toEqual({ decision: 'denied' }); // v1 casing
  });

  it('declines unknown server methods with JSON-RPC method-not-found', async () => {
    const { proc } = await readyClient();
    proc.serverRequest('srv-3', 'totally/unknown', {});
    const resp = await waitForSentWhere(proc, (m) => m.id === 'srv-3');
    expect(resp.error).toMatchObject({ code: -32601 });
  });

  it('never writes a delayed approval response into a replacement generation', async () => {
    const procs: FakeCodexProc[] = [];
    const client = new CodexClient(() => {
      const proc = new FakeCodexProc();
      procs.push(proc);
      return proc as unknown as ReturnType<CodexSpawnFn>;
    });

    let releaseFirst!: (decision: 'always') => void;
    let firstApprovalStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstApprovalStarted = resolve;
    });
    const firstDecision = new Promise<'always'>((resolve) => {
      releaseFirst = resolve;
    });
    client.setApprover(async (req) => {
      if (req.target === 'generation-a') {
        firstApprovalStarted();
        return firstDecision;
      }
      return 'deny';
    });

    const firstReady = client.ensureReady();
    await completeHandshake(procs[0]);
    await firstReady;
    procs[0].serverRequest('reused-id', 'item/commandExecution/requestApproval', {
      command: 'generation-a',
    });
    await firstStarted;

    procs[0].exit(1);
    const secondReady = client.ensureReady();
    await completeHandshake(procs[1]);
    await secondReady;
    procs[1].serverRequest('reused-id', 'item/commandExecution/requestApproval', {
      command: 'generation-b',
    });
    const secondResponse = await waitForSentWhere(procs[1], (m) => m.id === 'reused-id');
    expect(secondResponse.result).toEqual({ decision: 'decline' });

    releaseFirst('always');
    await new Promise((resolve) => setImmediate(resolve));

    expect(procs[0].sent.filter((m) => m.id === 'reused-id')).toHaveLength(0);
    expect(procs[1].sent.filter((m) => m.id === 'reused-id')).toEqual([secondResponse]);
  });

  it('cancels the real confirm gate on disconnect without enabling stale bypass', async () => {
    const procs: FakeCodexProc[] = [];
    const client = new CodexClient(() => {
      const proc = new FakeCodexProc();
      procs.push(proc);
      return proc as unknown as ReturnType<CodexSpawnFn>;
    });
    let captured: ConfirmRequest | null = null;
    const cancelled: string[] = [];
    setConfirmListener((req) => { captured = req; });
    setConfirmCancellationListener((id) => cancelled.push(id));
    client.setApprover((req, signal) => requestApproval({
      kind: req.kind === 'edit' ? 'edit' : 'command',
      path: req.target,
      detail: req.detail,
    }, signal));

    const firstReady = client.ensureReady();
    await completeHandshake(procs[0]);
    await firstReady;
    procs[0].serverRequest('stale-approval', 'item/commandExecution/requestApproval', {
      command: 'generation-a',
    });
    expect(captured).not.toBeNull();
    expect(pendingConfirmCount()).toBe(1);

    const staleId = captured!.id;
    procs[0].exit(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(pendingConfirmCount()).toBe(0);
    expect(cancelled).toEqual([staleId]);
    expect(isBypassing()).toBe(false);

    resolveApproval(staleId, 'bypass');
    expect(isBypassing()).toBe(false);
    client.shutdown();
  });
});

describe('CodexClient shutdown', () => {
  it('reaps the process with SIGTERM and rejects pending requests', async () => {
    const { client, proc } = await readyClient();
    const p = client.request('thread/start', {});
    await waitForSent(proc, 'thread/start');

    client.shutdown();
    expect(proc.killed).toBe(true);
    expect(proc.killSignal).toBe('SIGTERM');
    await expect(p).rejects.toThrow('codex client shut down');
  });
});

/**
 * Lane C — ensureThread keys one Codex thread per active-session context
 * (`${cwd}|${workspaceRoot}|${model}`). The proof that a child worktree gets its
 * own thread AND the parent keeps its own is a thread/start *call count*: each
 * distinct context starts exactly once, re-entering a known context reuses it.
 */
describe('ensureThread — per-session keyed threads', () => {
  const startCount = (proc: FakeCodexProc) =>
    proc.sent.filter((m) => m.method === 'thread/start').length;

  /** Wait until a thread/start beyond `prevCount` is on the wire; return its id. */
  async function waitForNewThreadStart(proc: FakeCodexProc, prevCount: number): Promise<number> {
    for (let i = 0; i < 200; i++) {
      const starts = proc.sent.filter((m) => m.method === 'thread/start');
      if (starts.length > prevCount) return starts[starts.length - 1].id as number;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('timed out waiting for a new thread/start');
  }

  /** Drive ensureThread through a cache MISS: expect a new start, reply, resolve. */
  async function startMiss(
    client: CodexClient,
    proc: FakeCodexProc,
    threadId: string,
    model?: string,
  ): Promise<string> {
    const prev = startCount(proc);
    const p = ensureThread(client, model);
    const id = await waitForNewThreadStart(proc, prev);
    proc.reply(id, { thread: { id: threadId } });
    return p;
  }

  let savedUserCwd: string | undefined;
  let savedWorkspaceRoot: string | undefined;
  let dirs: { parent: string; child: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    savedUserCwd = process.env.SIFT_USER_CWD;
    savedWorkspaceRoot = process.env.SIFT_WORKSPACE_ROOT;
    __resetCodexThreadsForTests();
    const base = await realpath(await mkdtemp(join(tmpdir(), 'sift-codex-thr-')));
    const parent = join(base, 'parent');
    const child = join(base, 'child');
    await mkdir(parent, { recursive: true });
    await mkdir(child, { recursive: true });
    dirs = { parent, child, cleanup: () => rm(base, { recursive: true, force: true }) };
  });

  afterEach(async () => {
    __resetCodexThreadsForTests();
    if (savedUserCwd === undefined) delete process.env.SIFT_USER_CWD;
    else process.env.SIFT_USER_CWD = savedUserCwd;
    if (savedWorkspaceRoot === undefined) delete process.env.SIFT_WORKSPACE_ROOT;
    else process.env.SIFT_WORKSPACE_ROOT = savedWorkspaceRoot;
    await dirs.cleanup();
  });

  it('parent → child → parent reuses each thread (one thread/start per context)', async () => {
    const { client, proc } = await readyClient();

    setSessionCwd(dirs.parent);
    const tidParent = await startMiss(client, proc, 't-parent');

    setSessionCwd(dirs.child);
    const tidChild = await startMiss(client, proc, 't-child');

    // Back in the parent context — must reuse, NOT restart (no reply needed).
    setSessionCwd(dirs.parent);
    const tidParentAgain = await ensureThread(client);

    expect(startCount(proc)).toBe(2); // exactly two contexts ever started
    expect(tidParentAgain).toBe(tidParent);
    expect(tidChild).not.toBe(tidParent); // distinct cwd → distinct thread
  });

  it('same cwd, different model → a fresh thread/start (model is part of the key)', async () => {
    const { client, proc } = await readyClient();
    setSessionCwd(dirs.parent);

    const tidA = await startMiss(client, proc, 't-a', 'modelA');
    const tidB = await startMiss(client, proc, 't-b', 'modelB');

    expect(startCount(proc)).toBe(2);
    expect(tidA).not.toBe(tidB);
    const starts = proc.sent.filter((m) => m.method === 'thread/start');
    expect((starts[0].params as { model?: string }).model).toBe('modelA');
    expect((starts[1].params as { model?: string }).model).toBe('modelB');

    // Re-asking modelA reuses the first thread — no third start.
    const tidAagain = await ensureThread(client, 'modelA');
    expect(tidAagain).toBe(tidA);
    expect(startCount(proc)).toBe(2);
  });

  it('shutdownCodex clears the thread map (next ask starts fresh)', async () => {
    const { client, proc } = await readyClient();
    setSessionCwd(dirs.parent);

    const tid1 = await startMiss(client, proc, 't-1');
    expect(startCount(proc)).toBe(1);

    shutdownCodex(); // drops the cache

    const tid2 = await startMiss(client, proc, 't-2');
    expect(startCount(proc)).toBe(2); // had to restart — cache was cleared
    expect(tid2).not.toBe(tid1);
  });

  it('an app-server exit drops cached thread ids — a respawn cannot reuse a dead server thread', async () => {
    const procs: FakeCodexProc[] = [];
    const spawnFresh: CodexSpawnFn = () => {
      const p = new FakeCodexProc();
      procs.push(p);
      return p as unknown as ReturnType<CodexSpawnFn>;
    };
    const client = new CodexClient(spawnFresh);
    let ready = client.ensureReady();
    await completeHandshake(procs[0]);
    await ready;

    setSessionCwd(dirs.parent);
    const tid1 = await startMiss(client, procs[0], 't-gen1');
    expect(startCount(procs[0])).toBe(1);

    // The sidecar dies; its threads exist only in that process's memory.
    procs[0].exit(1);

    ready = client.ensureReady();
    await completeHandshake(procs[1]);
    await ready;

    // Same context key, new process generation: ensureThread must start a
    // NEW thread rather than replaying the dead server's id.
    const tid2 = await startMiss(client, procs[1], 't-gen2');
    expect(startCount(procs[1])).toBe(1);
    expect(tid2).not.toBe(tid1);
  });

  it('a runtime error without exit tears down only the failed generation', async () => {
    const procs: FakeCodexProc[] = [];
    const spawnFresh: CodexSpawnFn = () => {
      const p = new FakeCodexProc();
      procs.push(p);
      return p as unknown as ReturnType<CodexSpawnFn>;
    };
    const client = new CodexClient(spawnFresh);
    let ready = client.ensureReady();
    await completeHandshake(procs[0]);
    await ready;

    setSessionCwd(dirs.parent);
    const tid1 = await startMiss(client, procs[0], 't-gen1');

    // ChildProcess can emit error without a later exit. The failed generation
    // must still be discarded so ensureReady can spawn a replacement.
    procs[0].fail(new Error('runtime transport failure'));
    expect(procs[0].killed).toBe(true);
    expect(procs[0].killSignal).toBe('SIGTERM');

    ready = client.ensureReady();
    await completeHandshake(procs[1]);
    await ready;
    const tid2 = await startMiss(client, procs[1], 't-gen2');
    expect(tid2).not.toBe(tid1);

    // A late exit from generation 1 must not clear generation 2's cache.
    procs[0].exit(1);
    await expect(ensureThread(client)).resolves.toBe(tid2);
    expect(startCount(procs[1])).toBe(1);
  });

  it('a mid-frame exit does not poison the next generation\'s handshake', async () => {
    const procs: FakeCodexProc[] = [];
    const spawnFresh: CodexSpawnFn = () => {
      const p = new FakeCodexProc();
      procs.push(p);
      return p as unknown as ReturnType<CodexSpawnFn>;
    };
    const client = new CodexClient(spawnFresh);
    let ready = client.ensureReady();
    await completeHandshake(procs[0]);
    await ready;

    // The server dies half-way through writing a frame. Let the partial
    // actually reach the client's framing buffer before the exit fires.
    procs[0].writeRaw('{"jsonrpc":');
    await new Promise((r) => setTimeout(r, 0));
    procs[0].exit(1);

    // Without clearing the buffer, the stale partial would concatenate with
    // the fresh server's initialize response, JSON parsing would drop it,
    // and this handshake would hang.
    ready = client.ensureReady();
    await completeHandshake(procs[1]);
    await ready;

    // The new generation frames follow-up traffic correctly too.
    setSessionCwd(dirs.parent);
    const tid = await startMiss(client, procs[1], 't-clean');
    expect(tid).toBe('t-clean');
  });
});


describe('owned Codex sidecar drain', () => {
  it('permits a fresh Codex connection after successful drain', async () => {
    __setCodexClientForTests(null);
    await closeCodex();
    const ready = jest.spyOn(CodexClient.prototype, 'ensureReady').mockResolvedValue(undefined);
    const request = jest.spyOn(CodexClient.prototype, 'request').mockResolvedValue({account: {type: 'chatgpt'}});
    try {
      await expect(getCodexAccount(true)).resolves.toEqual({type: 'chatgpt'});
      expect(ready).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith('account/read', {refreshToken: false});
    } finally {
      ready.mockRestore(); request.mockRestore(); __setCodexClientForTests(null);
    }
  });

  it('blocks reconnection while draining and after a failed drain, until retry succeeds', async () => {
    const owned = new CodexClient(() => { throw new Error('test must not spawn'); });
    let fail!: (error: Error) => void;
    const close = jest.spyOn(owned, 'close').mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    __setCodexClientForTests(owned);
    const ready = jest.spyOn(CodexClient.prototype, 'ensureReady').mockResolvedValue(undefined);
    const request = jest.spyOn(CodexClient.prototype, 'request').mockResolvedValue({account: {type: 'chatgpt'}});
    try {
      const draining = closeCodex();
      await expect(getCodexAccount(true)).resolves.toBeNull();
      fail(new Error('fixture drain failure'));
      await expect(draining).rejects.toThrow('fixture drain failure');
      await expect(getCodexAccount(true)).resolves.toBeNull();
      expect(ready).not.toHaveBeenCalled();
      close.mockResolvedValueOnce(undefined);
      await closeCodex();
      await expect(getCodexAccount(true)).resolves.toEqual({type: 'chatgpt'});
      expect(ready).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore(); ready.mockRestore(); request.mockRestore(); __setCodexClientForTests(null);
    }
  });

  it('waits for child stdio close rather than treating SIGTERM delivery as shutdown', async () => {
    const {client, proc} = await readyClient();
    let closed = false;
    const closing = client.close().then(() => { closed = true; });
    expect(proc.killSignal).toBe('SIGTERM');
    await Promise.resolve();
    expect(closed).toBe(false);
    proc.exit();
    await Promise.resolve();
    expect(closed).toBe(false);
    proc.emit('close', 0, null);
    await closing;
    expect(closed).toBe(true);
    await expect(client.ensureReady()).rejects.toThrow('shut down');
  });

  for (const stop of ['shutdown', 'exit'] as const) {
    it(`retains ownership after ${stop} until stdio closes`, async () => {
      const {client, proc} = await readyClient();
      if (stop === 'shutdown') client.shutdown();
      else proc.exit();
      let closed = false;
      const closing = client.close().then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(proc.killSignal).toBe('SIGTERM');
      proc.emit('close', 0, null);
      await closing;
      expect(closed).toBe(true);
    });
  }

  it('escalates only its owned child and rejects if closure cannot be confirmed', async () => {
    const {client, proc} = await readyClient();
    await expect(client.close(5)).rejects.toThrow('process ownership retained');
    expect(proc.killSignal).toBe('SIGKILL');
    const retry = client.close();
    proc.emit('close', null, 'SIGKILL');
    await expect(retry).resolves.toBeUndefined();
  });

  it('drains an existing Codex sidecar after the user switches to Meta', async () => {
    const {client, proc} = await readyClient();
    const prior = getBrainModel();
    __setCodexClientForTests(client);
    setBrainModel({provider: 'meta', model: 'muse-spark-1.3-contributor'});
    try {
      let closed = false;
      const closing = closeBrain().then(() => { closed = true; });
      // closeBrain dynamically loads Codex; wait for shutdown dispatch.
      for (let attempt = 0; !proc.killed && attempt < 100; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      expect(proc.killSignal).toBe('SIGTERM');
      expect(closed).toBe(false);
      proc.emit('close', 0, null);
      await closing;
      expect(closed).toBe(true);
    } finally {
      __setCodexClientForTests(null);
      setBrainModel({...prior, effort: prior.effort ?? ''});
    }
  });
});

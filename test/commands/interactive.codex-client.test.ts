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
  ensureThread,
  shutdownCodex,
  __resetCodexThreadsForTests,
} from '../../interactive-tui/codexEngine';
import {getSessionCwd, setSessionCwd} from '../../interactive-tui/navigation';
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
});

describe('CodexClient server→client approvals', () => {
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
});

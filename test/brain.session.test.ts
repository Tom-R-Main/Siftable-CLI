/**
 * Lane C S3 — Siftable agent-harness parity with per-session context.
 *
 * The bug this guards: `getAgent()` used to memoize a single agent whose
 * persistKey was captured the first time it was built. After entering a child
 * worktree, the parent's agent would keep serving the child (wrong cwd, wrong
 * rollout). Now agents are keyed by the active workspace/cwd identity, so each
 * session builds its own — and returning to a session reuses its exact instance.
 *
 * The agent harness is injected via the `__SIFT_AGENT_HARNESS__` seam
 * (see loadAgentHarnessModule), so no real model or bundled harness is loaded.
 */
import {createHash} from 'node:crypto';
import {link, mkdtemp, mkdir, readFile, rm, realpath, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {JsonlSessionEventStore} from '../interactive-tui/agent-harness';
import {
  agentHarnessAsk,
  getAgent,
  inspectActiveThread,
  resetActiveThread,
  setAgentConversationKey,
  setBrainModel,
  __resetBrainAgentsForTests,
} from '../interactive-tui/brain';
import {getWorkspaceRoot, setSessionCwd} from '../interactive-tui/navigation';
import {
  enqueueSessionInstruction,
  listPendingSessionInstructions,
} from '../interactive-tui/sessionMailbox';

type FakeAgent = {
  chat: () => AsyncIterable<never>;
  reset: jest.Mock;
  resetAsync?: jest.Mock;
  ingestExternalMessage: jest.Mock;
  getHistory: jest.Mock;
  getSessionEvents: jest.Mock;
  close: jest.Mock;
  destroy: jest.Mock;
  __id: number;
  __config: Record<string, unknown>;
};
type FakeSessionStore = {rootDir: string};

let createChatAgent: jest.Mock;
let savedUserCwd: string | undefined;
let savedWorkspaceRoot: string | undefined;
let savedCompaction: string | undefined;
let savedSessionEventRoot: string | undefined;
let savedSessionMailboxRoot: string | undefined;
let dirs: {
  parent: string;
  child: string;
  sessionEvents: string;
  sessionMailbox: string;
  cleanup: () => Promise<void>;
};

beforeEach(async () => {
  savedUserCwd = process.env.SIFT_USER_CWD;
  savedWorkspaceRoot = process.env.SIFT_WORKSPACE_ROOT;
  savedCompaction = process.env.SIFT_CONTEXT_COMPACTION;
  savedSessionEventRoot = process.env.SIFT_SESSION_EVENT_ROOT;
  savedSessionMailboxRoot = process.env.SIFT_SESSION_MAILBOX_ROOT;

  let nextId = 0;
  createChatAgent = jest.fn(async (config: Record<string, unknown>) => ({
    chat: async function* () {
      /* never yields in these tests */
    },
    reset: jest.fn(async () => undefined),
    ingestExternalMessage: jest.fn(async () => true),
    getHistory: jest.fn(() => [{role: 'user', content: 'one'}]),
    getSessionEvents: jest.fn(() => [{type: 'session/started'}, {type: 'message/appended'}]),
    close: jest.fn(async () => undefined),
    destroy: jest.fn(async () => undefined),
    __id: ++nextId,
    __config: config,
  }));
  (globalThis as Record<string, unknown>).__SIFT_AGENT_HARNESS__ = {
    JsonlSessionEventStore,
    createChatAgent,
    defineTool: (def: unknown) => def,
    ok: (d: unknown) => d,
    err: (e: unknown) => e,
  };
  __resetBrainAgentsForTests();

  const base = await realpath(await mkdtemp(join(tmpdir(), 'sift-brain-sess-')));
  const parent = join(base, 'parent');
  const child = join(base, 'child');
  const sessionEvents = join(base, 'session-events');
  const sessionMailbox = join(base, 'session-mailbox');
  await mkdir(parent, {recursive: true});
  await mkdir(child, {recursive: true});
  await mkdir(sessionEvents, {recursive: true, mode: 0o700});
  process.env.SIFT_SESSION_EVENT_ROOT = sessionEvents;
  process.env.SIFT_SESSION_MAILBOX_ROOT = sessionMailbox;
  dirs = {
    parent,
    child,
    sessionEvents,
    sessionMailbox,
    cleanup: () => rm(base, {recursive: true, force: true}),
  };
});

afterEach(async () => {
  __resetBrainAgentsForTests();
  delete (globalThis as Record<string, unknown>).__SIFT_AGENT_HARNESS__;
  if (savedUserCwd === undefined) delete process.env.SIFT_USER_CWD;
  else process.env.SIFT_USER_CWD = savedUserCwd;
  if (savedWorkspaceRoot === undefined) delete process.env.SIFT_WORKSPACE_ROOT;
  else process.env.SIFT_WORKSPACE_ROOT = savedWorkspaceRoot;
  if (savedCompaction === undefined) delete process.env.SIFT_CONTEXT_COMPACTION;
  else process.env.SIFT_CONTEXT_COMPACTION = savedCompaction;
  if (savedSessionEventRoot === undefined) delete process.env.SIFT_SESSION_EVENT_ROOT;
  else process.env.SIFT_SESSION_EVENT_ROOT = savedSessionEventRoot;
  if (savedSessionMailboxRoot === undefined) delete process.env.SIFT_SESSION_MAILBOX_ROOT;
  else process.env.SIFT_SESSION_MAILBOX_ROOT = savedSessionMailboxRoot;
  await dirs.cleanup();
});

describe('getAgent — per-session keyed agents', () => {
  it('builds a distinct agent per session with persistKey == that session workspace root', async () => {
    setSessionCwd(dirs.parent);
    const parentRoot = getWorkspaceRoot();
    const parentAgent = (await getAgent()) as unknown as FakeAgent;
    expect(createChatAgent).toHaveBeenCalledTimes(1);
    expect(createChatAgent.mock.calls[0][0].persistKey).toBe(parentRoot);

    setSessionCwd(dirs.child);
    const childRoot = getWorkspaceRoot();
    expect(childRoot).not.toBe(parentRoot);
    const childAgent = (await getAgent()) as unknown as FakeAgent;
    expect(createChatAgent).toHaveBeenCalledTimes(2);
    expect(createChatAgent.mock.calls[1][0].persistKey).toBe(childRoot);
    expect(childAgent.__id).not.toBe(parentAgent.__id);
  });

  it('reuses the SAME parent agent instance after a child round-trip (no rebuild)', async () => {
    setSessionCwd(dirs.parent);
    const parentAgent = await getAgent();

    setSessionCwd(dirs.child);
    await getAgent();

    setSessionCwd(dirs.parent);
    const parentAgentAgain = await getAgent();

    expect(createChatAgent).toHaveBeenCalledTimes(2); // parent + child only — no third build
    expect(parentAgentAgain).toBe(parentAgent); // identical instance, not a rebuild
  });

  it('setBrainModel invalidates every session agent (model change forces rebuild)', async () => {
    setSessionCwd(dirs.parent);
    const before = (await getAgent()) as unknown as FakeAgent;
    expect(createChatAgent).toHaveBeenCalledTimes(1);

    setBrainModel({model: 'some/other-model'});
    const after = await getAgent();

    expect(createChatAgent).toHaveBeenCalledTimes(2);
    expect(after).not.toBe(before);
    expect(before.close).toHaveBeenCalledTimes(1);
    expect(before.destroy).not.toHaveBeenCalled();
  });

  it('waits for the retiring agent to close before reopening its stable journal', async () => {
    setSessionCwd(dirs.parent);
    const before = (await getAgent()) as unknown as FakeAgent;
    let releaseClose!: () => void;
    before.close.mockImplementation(() => new Promise<void>((resolve) => {
      releaseClose = resolve;
    }));

    setBrainModel({model: 'handoff-model'});
    const reopening = getAgent();
    await Promise.resolve();
    await Promise.resolve();
    expect(before.close).toHaveBeenCalledTimes(1);
    expect(createChatAgent).toHaveBeenCalledTimes(1);

    releaseClose();
    await reopening;
    expect(createChatAgent).toHaveBeenCalledTimes(2);
  });

  it('reopens the same logical conversation journal with interrupted-turn recovery enabled', async () => {
    process.env.SIFT_CONTEXT_COMPACTION = '1';
    setSessionCwd(dirs.parent);

    await getAgent();
    const firstSession = createChatAgent.mock.calls.at(-1)?.[0]?.session as {
      id: string;
      threadId: string;
      store: FakeSessionStore;
      recoverInterrupted: boolean;
    };
    expect(firstSession.id).toMatch(/^[0-9a-f]{64}$/);
    expect(firstSession.id).not.toContain(dirs.parent);
    expect(firstSession.threadId).toBe(getWorkspaceRoot());
    expect(firstSession.store.rootDir).toBe(dirs.sessionEvents);
    expect(firstSession.recoverInterrupted).toBe(true);

    setBrainModel({model: 'journal-rebuild-model'});
    await getAgent();
    const rebuiltSession = createChatAgent.mock.calls.at(-1)?.[0]?.session as {
      id: string;
      recoverInterrupted: boolean;
    };
    expect(rebuiltSession.id).toBe(firstSession.id);
    expect(rebuiltSession.recoverInterrupted).toBe(true);

    // Simulate a fresh TUI process/cache opening the same conversation.
    __resetBrainAgentsForTests();
    setSessionCwd(dirs.parent);
    await getAgent();
    const reopenedSession = createChatAgent.mock.calls.at(-1)?.[0]?.session as {id: string};
    expect(reopenedSession.id).toBe(firstSession.id);

    setAgentConversationKey('child-conversation-key');
    await getAgent();
    const childSession = createChatAgent.mock.calls.at(-1)?.[0]?.session as {id: string};
    expect(childSession.id).not.toBe(firstSession.id);

    process.env.SIFT_CONTEXT_COMPACTION = '0';
    __resetBrainAgentsForTests();
    await getAgent();
    expect(createChatAgent.mock.calls.at(-1)?.[0]?.session).toMatchObject({
      id: firstSession.id,
      recoverInterrupted: true,
    });
  });

  it('fails fast when another live process owns the conversation journal lease', async () => {
    process.env.SIFT_CONTEXT_COMPACTION = '1';
    setSessionCwd(dirs.parent);
    const key = getWorkspaceRoot();
    const sessionId = createHash('sha256')
      .update(`sift-interactive-session-v1\0${key}`, 'utf8')
      .digest('hex');
    const competingStore = new JsonlSessionEventStore({rootDir: dirs.sessionEvents});
    const competingLease = competingStore.acquireLease(sessionId);
    try {
      await expect(getAgent()).rejects.toThrow(`session ${sessionId} is locked by another writer`);
      expect(createChatAgent).not.toHaveBeenCalled();
    } finally {
      competingLease.release();
    }
  });

  it('reclaims a crashed process lease before reopening the journal', async () => {
    process.env.SIFT_CONTEXT_COMPACTION = '1';
    setSessionCwd(dirs.parent);
    const key = getWorkspaceRoot();
    const sessionId = createHash('sha256')
      .update(`sift-interactive-session-v1\0${key}`, 'utf8')
      .digest('hex');
    const leaseDigest = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    const leasePath = join(dirs.sessionEvents, `${leaseDigest}.lease`);
    const crashedPid = 2_147_483_647;
    const crashedToken = '00000000-0000-4000-8000-000000000001';
    const crashedClaimPath = `${leasePath}.${crashedPid}.${crashedToken}.claim`;
    await writeFile(crashedClaimPath, `${JSON.stringify({
      pid: crashedPid,
      token: crashedToken,
    })}\n`, {mode: 0o600});
    await link(crashedClaimPath, leasePath);

    await getAgent();

    expect(createChatAgent).toHaveBeenCalledTimes(1);
    const currentLease = JSON.parse(await readFile(leasePath, 'utf8')) as {pid: number; token: string};
    expect(currentLease.pid).toBe(process.pid);
    expect(currentLease.token).not.toBe(crashedToken);
  });

  it('journals and acknowledges durable send-back instructions before returning the agent', async () => {
    setSessionCwd(dirs.child);
    const key = getWorkspaceRoot();
    const instruction = enqueueSessionInstruction(key, 'rebase and rerun the test', {
      rootDir: dirs.sessionMailbox,
      idFactory: () => 'sendback-1',
      now: () => new Date('2026-08-25T12:00:00.000Z'),
    });

    const agent = (await getAgent()) as unknown as FakeAgent;

    expect(agent.ingestExternalMessage).toHaveBeenCalledWith(
      'rebase and rerun the test',
      {id: instruction.instructionId},
    );
    expect(listPendingSessionInstructions(key, {rootDir: dirs.sessionMailbox})).toEqual([]);
  });

  it('reports the stable event journal rather than legacy rollout state', async () => {
    setSessionCwd(dirs.parent);
    const key = getWorkspaceRoot();

    await expect(inspectActiveThread()).resolves.toEqual({
      sessionId: createHash('sha256')
        .update(`sift-interactive-session-v1\0${key}`, 'utf8')
        .digest('hex'),
      eventCount: 2,
      messageCount: 1,
    });
  });

  it('resets active and pre-chat conversations with their stable thread identity', async () => {
    process.env.SIFT_CONTEXT_COMPACTION = '1';
    setSessionCwd(dirs.parent);
    const agent = (await getAgent()) as unknown as FakeAgent;
    const parentKey = getWorkspaceRoot();

    expect(await resetActiveThread()).toBe(true);
    expect(agent.reset).toHaveBeenCalledTimes(1);
    expect(agent.reset).toHaveBeenCalledWith({threadId: parentKey});

    __resetBrainAgentsForTests();
    setAgentConversationKey('not-yet-opened');
    expect(await resetActiveThread()).toBe(true);
    const preChatAgent = await createChatAgent.mock.results.at(-1)!.value as FakeAgent;
    expect(preChatAgent.reset).toHaveBeenCalledWith({threadId: 'not-yet-opened'});
  });

  it('delegates active-thread reset to the harness FIFO-safe resetAsync method', async () => {
    setSessionCwd(dirs.parent);
    const agent = (await getAgent()) as unknown as FakeAgent;
    const parentKey = getWorkspaceRoot();
    agent.resetAsync = jest.fn(async (options: {threadId?: string}) => {
      await agent.reset(options);
    });

    await expect(resetActiveThread()).resolves.toBe(true);
    expect(agent.resetAsync).toHaveBeenCalledTimes(1);
    expect(agent.resetAsync).toHaveBeenCalledWith({threadId: parentKey});
    expect(agent.reset).toHaveBeenCalledWith({threadId: parentKey});
  });

  it('warns about uncertain tool effects without exposing receipt details', async () => {
    setBrainModel({provider: 'openrouter', model: 'google/gemini-3.8-flash'});
    setSessionCwd(dirs.parent);
    const agent = (await getAgent()) as unknown as FakeAgent;
    agent.chat = async function* () {
      throw Object.assign(new Error('injected tool/result append failure'), {
        toolEffects: {
          state: 'partial',
          certainty: 'unknown',
          verificationRequired: 'inspect the external resource',
          receipts: [{toolName: 'write_file', result: {secret: 'DO_NOT_LEAK'}}],
        },
      });
    };

    const priorExplorerMode = process.env.SIFT_EXPLORER_MODE;
    process.env.SIFT_EXPLORER_MODE = 'off';
    try {
      const result = await agentHarnessAsk('trigger the injected failure', jest.fn());

      expect(result.error).toContain('injected tool/result append failure');
      expect(result.error).toContain('Tool side effects may have occurred; verify state before retrying.');
      expect(result.error).not.toContain('DO_NOT_LEAK');
      expect(result.error).not.toContain('write_file');
    } finally {
      if (priorExplorerMode === undefined) delete process.env.SIFT_EXPLORER_MODE;
      else process.env.SIFT_EXPLORER_MODE = priorExplorerMode;
    }
  });
});

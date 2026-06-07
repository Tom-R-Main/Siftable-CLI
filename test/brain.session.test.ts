/**
 * Lane C S3 — OpenFunction agent parity with per-session context.
 *
 * The bug this guards: `getAgent()` used to memoize a single agent whose
 * persistKey was captured the first time it was built. After entering a child
 * worktree, the parent's agent would keep serving the child (wrong cwd, wrong
 * rollout). Now agents are keyed by the active workspace/cwd identity, so each
 * session builds its own — and returning to a session reuses its exact instance.
 *
 * The OpenFunction module is injected via the `__EXECUTERM_OPENFUNCTION__` seam
 * (see loadOpenFunctionModule), so no real model or vendored slice is loaded.
 */
import {mkdtemp, mkdir, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {getAgent, setBrainModel, __resetBrainAgentsForTests} from '../interactive-tui/brain';
import {getWorkspaceRoot, setSessionCwd} from '../interactive-tui/navigation';

type FakeAgent = {chat: () => AsyncIterable<never>; __id: number; __config: Record<string, unknown>};

let createChatAgent: jest.Mock;
let savedUserCwd: string | undefined;
let savedWorkspaceRoot: string | undefined;
let dirs: {parent: string; child: string; cleanup: () => Promise<void>};

beforeEach(async () => {
  savedUserCwd = process.env.SIFT_USER_CWD;
  savedWorkspaceRoot = process.env.SIFT_WORKSPACE_ROOT;

  let nextId = 0;
  createChatAgent = jest.fn(async (config: Record<string, unknown>) => ({
    chat: async function* () {
      /* never yields in these tests */
    },
    __id: ++nextId,
    __config: config,
  }));
  (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__ = {
    createChatAgent,
    defineTool: (def: unknown) => def,
    ok: (d: unknown) => d,
    err: (e: unknown) => e,
  };
  __resetBrainAgentsForTests();

  const base = await realpath(await mkdtemp(join(tmpdir(), 'sift-brain-sess-')));
  const parent = join(base, 'parent');
  const child = join(base, 'child');
  await mkdir(parent, {recursive: true});
  await mkdir(child, {recursive: true});
  dirs = {parent, child, cleanup: () => rm(base, {recursive: true, force: true})};
});

afterEach(async () => {
  __resetBrainAgentsForTests();
  delete (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__;
  if (savedUserCwd === undefined) delete process.env.SIFT_USER_CWD;
  else process.env.SIFT_USER_CWD = savedUserCwd;
  if (savedWorkspaceRoot === undefined) delete process.env.SIFT_WORKSPACE_ROOT;
  else process.env.SIFT_WORKSPACE_ROOT = savedWorkspaceRoot;
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
    const before = await getAgent();
    expect(createChatAgent).toHaveBeenCalledTimes(1);

    setBrainModel({model: 'some/other-model'});
    const after = await getAgent();

    expect(createChatAgent).toHaveBeenCalledTimes(2);
    expect(after).not.toBe(before);
  });
});

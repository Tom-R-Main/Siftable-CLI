/**
 * Lane E A2 — the child-session brain tools (list_branches / spawn_branch /
 * ready_branch / merge_branch). They are thin, SAFE wrappers over the same
 * lanes A–E controller the human UI drives — never raw shell git. This guards:
 *  - every tool refuses cleanly when no controller is registered;
 *  - args pass through to the controller and its refusals surface verbatim;
 *  - spawn_branch enforces "a writer needs scope (or unscoped/readonly)";
 *  - merge_branch is APPROVAL-GATED: declined → the controller is never called.
 *
 * The agent harness is injected via __SIFT_AGENT_HARNESS__ (defineTool
 * returns the raw def, ok/err return tagged objects), so getAgent()'s captured
 * config.tools is the tool list and we invoke handlers directly. No real model.
 */
import {mkdtemp, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {getAgent, setSessionController, __resetBrainAgentsForTests} from '../interactive-tui/brain';
import {setSessionCwd} from '../interactive-tui/navigation';
import {setConfirmListener, resolveApproval} from '../interactive-tui/confirmGate';
import type {
  ChildSessionController,
  ChildSessionRecord,
} from '../interactive-tui/childSessionController';
import type {MergePacket} from '../interactive-tui/mergeGate';

type ToolDef = {name: string; handler: (params: Record<string, unknown>) => Promise<unknown>};
type ToolResult = {ok: true; data: unknown; message?: string} | {ok: false; error: string};

let createChatAgent: jest.Mock;
let savedRoot: string | undefined;
let workdir: string;

beforeEach(async () => {
  savedRoot = process.env.SIFT_WORKSPACE_ROOT;
  workdir = await realpath(await mkdtemp(join(tmpdir(), 'sift-branch-tools-')));
  process.env.SIFT_WORKSPACE_ROOT = workdir;
  setSessionCwd(workdir);
  createChatAgent = jest.fn(async (config: Record<string, unknown>) => ({
    chat: async function* () {},
    __config: config,
  }));
  (globalThis as Record<string, unknown>).__SIFT_AGENT_HARNESS__ = {
    createChatAgent,
    defineTool: (def: unknown) => def,
    ok: (data: unknown, message?: string) => ({ok: true, data, message}),
    err: (error: string) => ({ok: false, error}),
  };
  __resetBrainAgentsForTests();
  setConfirmListener(null);
});

afterEach(async () => {
  __resetBrainAgentsForTests();
  setSessionController(null);
  setConfirmListener(null);
  if (savedRoot === undefined) delete process.env.SIFT_WORKSPACE_ROOT;
  else process.env.SIFT_WORKSPACE_ROOT = savedRoot;
  delete (globalThis as Record<string, unknown>).__SIFT_AGENT_HARNESS__;
  await rm(workdir, {recursive: true, force: true});
});

/** Build the agent (capturing config.tools) and index the branch tools by name. */
async function branchTools(): Promise<Record<string, ToolDef>> {
  __resetBrainAgentsForTests();
  await getAgent();
  const call = createChatAgent.mock.calls.at(-1);
  const tools = (call?.[0]?.tools ?? []) as ToolDef[];
  return Object.fromEntries(tools.filter((t) => t && t.name).map((t) => [t.name, t]));
}

function stubController(over: Partial<ChildSessionController> = {}): ChildSessionController {
  const base: ChildSessionController = {
    spawnChild: () => ({ok: false, reason: 'stub'}),
    listChildSessions: () => [],
    getChild: () => undefined,
    reviewChild: () => ({ok: false, reason: 'stub'}),
    commitChild: () => ({ok: false, reason: 'stub'}),
    listMergeReadiness: jest.fn(() => ({rows: [], readyCount: 0, blockedCount: 0, totalAdditions: 0, totalDeletions: 0})),
    mergeChild: () => ({ok: false, reason: 'stub'}),
    rebaseChild: () => ({ok: false, reason: 'stub'}),
    sendBackChild: () => ({ok: false, reason: 'stub'}),
    rejectChild: () => ({ok: false, reason: 'stub'}),
    removeChild: () => ({ok: false, reason: 'stub'}),
  };
  return {...base, ...over};
}

function childSession(
  sessionId: number,
  overrides: Partial<ChildSessionRecord> = {},
): ChildSessionRecord {
  const branch = `sift/session-${sessionId}`;
  const worktreePath = `/wt/session-${sessionId}`;
  return {
    sessionId,
    parentSessionId: 1,
    title: `session ${sessionId}`,
    repoRoot: '/repo',
    branch,
    baseBranch: 'main',
    worktreePath,
    sessionCwd: worktreePath,
    baseCommit: 'base1234',
    headCommit: 'head1234',
    accessMode: 'read_write',
    writeScope: ['src/a.ts'],
    conversationKey: `session:${sessionId}`,
    ...overrides,
  };
}

function mergePacket(overrides: Partial<MergePacket> = {}): MergePacket {
  return {
    childSessionId: 2,
    parentSessionId: 1,
    baseBranch: 'main',
    childBranch: 'sift/a',
    baseCommit: 'base1234',
    baseTip: 'base5678',
    behindBy: 0,
    headCommit: 'head1234',
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
    conflicts: [],
    outOfScope: [],
    dirty: false,
    verdict: 'ready_to_merge',
    blockers: [],
    ...overrides,
  };
}

type ControllerMethod = (...args: never[]) => unknown;

function mockControllerMethod<Method extends ControllerMethod>(
  implementation: (...args: Parameters<Method>) => ReturnType<Method>,
): jest.Mock<ReturnType<Method>, Parameters<Method>> {
  return jest.fn<ReturnType<Method>, Parameters<Method>>(implementation);
}

describe('lane E A2 — child-session brain tools', () => {
  it('registers all four branch tools on the agent', async () => {
    setSessionController(stubController());
    const tools = await branchTools();
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['list_branches', 'spawn_branch', 'ready_branch', 'merge_branch']));
  });

  it('every branch tool refuses cleanly when no controller is registered', async () => {
    setSessionController(null);
    const tools = await branchTools();
    for (const name of ['list_branches', 'spawn_branch', 'ready_branch', 'merge_branch']) {
      const res = (await tools[name].handler(name === 'list_branches' ? {} : {id: 1, title: 't', scope: ['a']})) as ToolResult;
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.error).toMatch(/no child-session controller/);
    }
  });

  it('list_branches passes the readiness view through', async () => {
    const view: ReturnType<ChildSessionController['listMergeReadiness']> = {
      rows: [{sessionId: 2, branch: 'sift/a', baseBranch: 'main', status: 'running', verdict: 'ready_to_merge', files: 1, additions: 3, deletions: 1, behindBy: 0, blockers: []}],
      readyCount: 1, blockedCount: 0, totalAdditions: 3, totalDeletions: 1,
    };
    const listMergeReadiness = mockControllerMethod<ChildSessionController['listMergeReadiness']>(() => view);
    setSessionController(stubController({listMergeReadiness}));
    const tools = await branchTools();
    const res = (await tools.list_branches.handler({})) as ToolResult;
    expect(listMergeReadiness).toHaveBeenCalled();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message).toContain('1 ready · 0 blocked');
  });

  it('spawn_branch requires scope for a writer, then passes through', async () => {
    const spawnChild = mockControllerMethod<ChildSessionController['spawnChild']>(() => ({
      ok: true,
      session: childSession(5, {branch: 'sift/feat', worktreePath: '/wt/feat', sessionCwd: '/wt/feat'}),
    }));
    setSessionController(stubController({spawnChild}));
    const tools = await branchTools();

    const bad = (await tools.spawn_branch.handler({title: 'feat'})) as ToolResult;
    expect(bad.ok).toBe(false);
    if (bad.ok === false) expect(bad.error).toMatch(/needs `scope`/);
    expect(spawnChild).not.toHaveBeenCalled();

    const ok = (await tools.spawn_branch.handler({title: 'feat', scope: ['src/a.ts']})) as ToolResult;
    expect(spawnChild).toHaveBeenCalledWith({title: 'feat', accessMode: 'read_write', writeScope: ['src/a.ts']});
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.message).toContain('#5 on sift/feat');
  });

  it('ready_branch surfaces the gate verdict', async () => {
    const packet = mergePacket({
      files: [{path: 'a', additions: 3, deletions: 1, binary: false}],
      totalAdditions: 3,
      totalDeletions: 1,
      verdict: 'merge_blocked',
      blockers: ['conflicts with main in: x.ts'],
    });
    const reviewChild = mockControllerMethod<ChildSessionController['reviewChild']>(() => ({
      ok: true,
      packet,
      statusApplied: true,
      committed: false,
      proofDecision: {policy: 'warn', allowed: true, code: 'proof_warn', advisoryCode: 'proof_load_failed'},
    }));
    setSessionController(stubController({reviewChild}));
    const tools = await branchTools();
    const res = (await tools.ready_branch.handler({id: 2})) as ToolResult;
    expect(reviewChild).toHaveBeenCalledWith(2, {autoCommit: false, message: undefined});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.message).toContain('merge_blocked');
      expect(res.message).toContain('proof: proof_warn · advisory: proof_load_failed');
      expect(res.data).toMatchObject({proofDecision: {code: 'proof_warn', advisoryCode: 'proof_load_failed'}});
    }
  });

  it('merge_branch is approval-gated — declined means the controller is never called', async () => {
    const mergeChild = mockControllerMethod<ChildSessionController['mergeChild']>(() => ({
      ok: true,
      merged: true,
      packet: mergePacket(),
      baseCommit: 'abcdef1234',
      cleaned: true,
    }));
    setSessionController(stubController({mergeChild}));
    const tools = await branchTools();

    // No confirm listener → requestConfirm denies → declined, no land.
    const declined = (await tools.merge_branch.handler({id: 2})) as ToolResult;
    expect(declined.ok).toBe(false);
    if (declined.ok === false) expect(declined.error).toMatch(/declined/);
    expect(mergeChild).not.toHaveBeenCalled();

    // Approve every confirm → land proceeds.
    setConfirmListener((req) => resolveApproval(req.id, 'allow'));
    const landed = (await tools.merge_branch.handler({id: 2})) as ToolResult;
    expect(mergeChild).toHaveBeenCalledWith(2, {keep: false, message: undefined});
    expect(landed.ok).toBe(true);
    if (landed.ok) expect(landed.message).toContain('merged #2 → main (abcdef1)');
  });

  // ── list_branches: formatting + failure ───────────────────────────────────
  it('list_branches reports an empty field and surfaces controller errors', async () => {
    const empty = mockControllerMethod<ChildSessionController['listMergeReadiness']>(() => ({
      rows: [],
      readyCount: 0,
      blockedCount: 0,
      totalAdditions: 0,
      totalDeletions: 0,
    }));
    setSessionController(stubController({listMergeReadiness: empty}));
    let res = (await (await branchTools()).list_branches.handler({})) as ToolResult;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message).toContain('No child branches yet');

    const boom = mockControllerMethod<ChildSessionController['listMergeReadiness']>(() => {
      throw new Error('git exploded');
    });
    setSessionController(stubController({listMergeReadiness: boom}));
    res = (await (await branchTools()).list_branches.handler({})) as ToolResult;
    expect(res.ok).toBe(false);
    if (res.ok === false) expect(res.error).toContain('git exploded');
  });

  it('list_branches renders blockers for a blocked child', async () => {
    const view: ReturnType<ChildSessionController['listMergeReadiness']> = {
      rows: [{sessionId: 3, branch: 'sift/b', baseBranch: 'main', status: 'merge_blocked', verdict: 'merge_blocked', files: 1, additions: 0, deletions: 0, behindBy: 2, blockers: ['conflicts with main in: x.ts']}],
      readyCount: 0, blockedCount: 1, totalAdditions: 0, totalDeletions: 0,
    };
    setSessionController(stubController({
      listMergeReadiness: mockControllerMethod<ChildSessionController['listMergeReadiness']>(() => view),
    }));
    const res = (await (await branchTools()).list_branches.handler({})) as ToolResult;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.message).toContain('0 ready · 1 blocked');
      expect(res.message).toContain('conflicts with main in: x.ts');
      expect(res.message).toContain('base +2');
    }
  });

  // ── spawn_branch: readonly / unscoped / blocked / throw ───────────────────
  it('spawn_branch maps readonly and unscoped to the right access mode', async () => {
    const spawnChild = mockControllerMethod<ChildSessionController['spawnChild']>(() => ({
      ok: true,
      session: childSession(7, {branch: 'sift/x', worktreePath: '/wt/x', sessionCwd: '/wt/x'}),
    }));
    setSessionController(stubController({spawnChild}));
    const tools = await branchTools();

    await tools.spawn_branch.handler({title: 'probe', readonly: true});
    expect(spawnChild).toHaveBeenLastCalledWith({title: 'probe', accessMode: 'read_only', writeScope: undefined});

    await tools.spawn_branch.handler({title: 'wild', unscoped: true});
    expect(spawnChild).toHaveBeenLastCalledWith({title: 'wild', accessMode: 'read_write', writeScope: undefined});
  });

  it('spawn_branch surfaces a Gate-A block with the blocking child id', async () => {
    const spawnChild = mockControllerMethod<ChildSessionController['spawnChild']>(() => ({
      ok: false,
      reason: 'scope overlaps',
      blockedBy: 4,
    }));
    setSessionController(stubController({spawnChild}));
    const res = (await (await branchTools()).spawn_branch.handler({title: 't', scope: ['a.ts']})) as ToolResult;
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.error).toContain('scope overlaps');
      expect(res.error).toContain('blocked by child #4');
    }
  });

  it('spawn_branch rejects an empty title and catches a throwing controller', async () => {
    const spawnChild = mockControllerMethod<ChildSessionController['spawnChild']>(() => {
      throw new Error('worktree add failed');
    });
    setSessionController(stubController({spawnChild}));
    const tools = await branchTools();

    const blank = (await tools.spawn_branch.handler({title: '   '})) as ToolResult;
    expect(blank.ok).toBe(false);
    if (blank.ok === false) expect(blank.error).toMatch(/title is required/);
    expect(spawnChild).not.toHaveBeenCalled();

    const thrown = (await tools.spawn_branch.handler({title: 't', scope: ['a.ts']})) as ToolResult;
    expect(thrown.ok).toBe(false);
    if (thrown.ok === false) expect(thrown.error).toContain('worktree add failed');
  });

  // ── ready_branch: id validation / autoCommit / ready / refusal ────────────
  it('ready_branch validates the id and forwards autoCommit + message', async () => {
    const packet = mergePacket({
      files: [{path: 'a', additions: 1, deletions: 0, binary: false}],
      totalAdditions: 1,
    });
    const reviewChild = mockControllerMethod<ChildSessionController['reviewChild']>(() => ({
      ok: true,
      packet,
      statusApplied: true,
      committed: true,
    }));
    setSessionController(stubController({reviewChild}));
    const tools = await branchTools();

    const bad = (await tools.ready_branch.handler({id: 'nope'})) as ToolResult;
    expect(bad.ok).toBe(false);
    if (bad.ok === false) expect(bad.error).toMatch(/id must be a session id/);
    expect(reviewChild).not.toHaveBeenCalled();

    const ok = (await tools.ready_branch.handler({id: 2, autoCommit: true, message: 'wip'})) as ToolResult;
    expect(reviewChild).toHaveBeenCalledWith(2, {autoCommit: true, message: 'wip'});
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.message).toContain('ready_to_merge');
  });

  it('ready_branch surfaces a controller refusal', async () => {
    const reviewChild = mockControllerMethod<ChildSessionController['reviewChild']>(() => ({
      ok: false,
      reason: 'unknown child session',
    }));
    setSessionController(stubController({reviewChild}));
    const res = (await (await branchTools()).ready_branch.handler({id: 99})) as ToolResult;
    expect(res.ok).toBe(false);
    if (res.ok === false) expect(res.error).toContain('unknown child session');
  });

  // ── merge_branch: id validation / up-to-date / keep / refusal ─────────────
  it('merge_branch validates the id before prompting for approval', async () => {
    const mergeChild = mockControllerMethod<ChildSessionController['mergeChild']>(() => ({
      ok: false,
      reason: 'must not be called',
    }));
    const asks: number[] = [];
    setSessionController(stubController({mergeChild}));
    setConfirmListener((req) => {
      asks.push(1);
      resolveApproval(req.id, 'allow');
    });
    const res = (await (await branchTools()).merge_branch.handler({id: 1.5})) as ToolResult;
    expect(res.ok).toBe(false);
    if (res.ok === false) expect(res.error).toMatch(/id must be a session id/);
    expect(asks.length).toBe(0); // no approval prompt for a bad id
    expect(mergeChild).not.toHaveBeenCalled();
  });

  it('merge_branch reports already-up-to-date and forwards keep + message', async () => {
    const mergeChild = mockControllerMethod<ChildSessionController['mergeChild']>(() => ({
      ok: true,
      merged: false,
      packet: mergePacket(),
      baseCommit: '0000000aaaa',
      cleaned: false,
      note: 'child had no net changes (already up-to-date)',
    }));
    setSessionController(stubController({mergeChild}));
    setConfirmListener((req) => resolveApproval(req.id, 'allow'));
    const res = (await (await branchTools()).merge_branch.handler({id: 2, keep: true, message: 'ship'})) as ToolResult;
    expect(mergeChild).toHaveBeenCalledWith(2, {keep: true, message: 'ship'});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.message).toContain('already up-to-date #2');
      expect(res.message).toContain('worktree + branch kept');
      expect(res.message).toContain('already up-to-date)'); // the note
    }
  });

  it('merge_branch surfaces a post-approval refusal (e.g. blocked)', async () => {
    const mergeChild = mockControllerMethod<ChildSessionController['mergeChild']>(() => ({
      ok: false,
      reason: 'merge blocked: conflicts with main in: x.ts',
    }));
    setSessionController(stubController({mergeChild}));
    setConfirmListener((req) => resolveApproval(req.id, 'allow'));
    const res = (await (await branchTools()).merge_branch.handler({id: 2})) as ToolResult;
    expect(mergeChild).toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (res.ok === false) expect(res.error).toContain('merge blocked');
  });

  // ── lane F: rebase_branch / sendback_branch / reject_branch ────────────────
  it('registers the lane-F recovery tools and they are NOT approval-gated', async () => {
    // No confirm listener is set; an autonomous tool must still run (merge would deny).
    const rebaseChild = mockControllerMethod<ChildSessionController['rebaseChild']>(() => ({
      ok: true,
      rebased: true,
      headCommit: 'abcdef1234567',
      verdict: 'ready_to_merge',
      statusApplied: true,
    }));
    setSessionController(stubController({rebaseChild}));
    const tools = await branchTools();
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['rebase_branch', 'sendback_branch', 'reject_branch']));
    const res = (await tools.rebase_branch.handler({id: 2})) as ToolResult;
    expect(rebaseChild).toHaveBeenCalledWith(2);
    expect(res.ok).toBe(true); // ran without any approval prompt
    if (res.ok) expect(res.message).toContain('rebased #2');
  });

  it('rebase_branch surfaces conflicts on a failed rebase', async () => {
    const rebaseChild = mockControllerMethod<ChildSessionController['rebaseChild']>(() => ({
      ok: false,
      reason: 'rebase onto main conflicts',
      conflicts: ['shared.txt'],
    }));
    setSessionController(stubController({rebaseChild}));
    const res = (await (await branchTools()).rebase_branch.handler({id: 3})) as ToolResult;
    expect(res.ok).toBe(false);
    if (res.ok === false) expect(res.error).toContain('shared.txt');
  });

  it('sendback_branch requires an instruction, then posts it through', async () => {
    const sendBackChild = mockControllerMethod<ChildSessionController['sendBackChild']>(() => ({
      ok: true,
      posted: true,
      durability: 'durable',
      conversationKey: 'k',
    }));
    setSessionController(stubController({sendBackChild}));
    const tools = await branchTools();

    const bad = (await tools.sendback_branch.handler({id: 2, instruction: '  '})) as ToolResult;
    expect(bad.ok).toBe(false);
    if (bad.ok === false) expect(bad.error).toMatch(/instruction is required/);
    expect(sendBackChild).not.toHaveBeenCalled();

    const ok = (await tools.sendback_branch.handler({id: 2, instruction: 'rebase onto main'})) as ToolResult;
    expect(sendBackChild).toHaveBeenCalledWith(2, 'rebase onto main');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.message).toContain('sent #2 back to work');
  });

  it('reject_branch passes the reason through and surfaces a refusal', async () => {
    const rejectChild = mockControllerMethod<ChildSessionController['rejectChild']>(() => ({ok: true}));
    setSessionController(stubController({rejectChild}));
    let res = (await (await branchTools()).reject_branch.handler({id: 2, reason: 'out of scope'})) as ToolResult;
    expect(rejectChild).toHaveBeenCalledWith(2, 'out of scope');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message).toContain('rejected #2');

    const rejectChild2 = mockControllerMethod<ChildSessionController['rejectChild']>(() => ({
      ok: false,
      reason: 'review it first',
    }));
    setSessionController(stubController({rejectChild: rejectChild2}));
    res = (await (await branchTools()).reject_branch.handler({id: 2})) as ToolResult;
    expect(res.ok).toBe(false);
    if (res.ok === false) expect(res.error).toContain('review it first');
  });
});

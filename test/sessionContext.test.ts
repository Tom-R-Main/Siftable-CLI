/**
 * sessionContext — active-session pointer, per-session transcript isolation, and
 * exact cwd/workspace-root round-trip on enter/leave (including nested switches).
 *
 * These are the S1 guarantees Lane C's engine/transcript work hangs off: if a
 * leave() ever restored "a" cwd instead of "the" cwd, or a child's messages
 * bled into the parent buffer, the "full interactive child thread" criterion
 * would silently fail downstream. We assert the strong forms here.
 */
import {mkdtemp, mkdir, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSessionContext, type ManagedSession} from '../interactive-tui/sessionContext';
import {getSessionCwd, getWorkspaceRoot, setSessionCwd} from '../interactive-tui/navigation';

/** Snapshot + restore the cwd env so tests don't leak into each other. */
let savedUserCwd: string | undefined;
let savedWorkspaceRoot: string | undefined;

beforeEach(() => {
  savedUserCwd = process.env.SIFT_USER_CWD;
  savedWorkspaceRoot = process.env.SIFT_WORKSPACE_ROOT;
});

afterEach(() => {
  if (savedUserCwd === undefined) delete process.env.SIFT_USER_CWD;
  else process.env.SIFT_USER_CWD = savedUserCwd;
  if (savedWorkspaceRoot === undefined) delete process.env.SIFT_WORKSPACE_ROOT;
  else process.env.SIFT_WORKSPACE_ROOT = savedWorkspaceRoot;
});

/** Three real temp directories: a parent tree and two child worktrees. */
async function setupDirs(): Promise<{
  parent: string;
  childA: string;
  childB: string;
  cleanup: () => Promise<void>;
}> {
  // realpath so macOS /var → /private/var matches what path.resolve yields after
  // setSessionCwd; otherwise the equality assertions would be off by the symlink.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'sift-sessctx-')));
  const parent = join(base, 'parent');
  const childA = join(base, 'child-a');
  const childB = join(base, 'child-b');
  await mkdir(parent, {recursive: true});
  await mkdir(childA, {recursive: true});
  await mkdir(childB, {recursive: true});
  return {parent, childA, childB, cleanup: () => rm(base, {recursive: true, force: true})};
}

function session(sessionId: number, conversationKey: string, sessionCwd: string): ManagedSession {
  return {sessionId, conversationKey, sessionCwd};
}

describe('sessionContext — cwd swap + exact round-trip', () => {
  it('enter() points cwd at the child worktree; leave() restores the EXACT parent cwd', async () => {
    const {parent, childA, cleanup} = await setupDirs();
    try {
      setSessionCwd(parent);
      const parentCwd = getSessionCwd();
      const parentRoot = getWorkspaceRoot();
      expect(parentCwd).toBe(parent);

      const ctx = createSessionContext<string>(session(1, 'parent', parent));
      const entered = ctx.enter(session(2, 'child-a', childA));

      expect(entered.cwd).toBe(childA);
      expect(getSessionCwd()).toBe(childA);
      expect(ctx.activeSessionId()).toBe(2);
      expect(ctx.isRoot()).toBe(false);

      const left = ctx.leave();
      expect(left).not.toBeNull();
      // Exact value round-trip — not merely "back inside the parent tree".
      expect(getSessionCwd()).toBe(parentCwd);
      expect(getWorkspaceRoot()).toBe(parentRoot);
      expect(ctx.activeSessionId()).toBe(1);
      expect(ctx.isRoot()).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('nested enter/leave restores each frame exactly, no leak across levels', async () => {
    const {parent, childA, childB, cleanup} = await setupDirs();
    try {
      setSessionCwd(parent);
      const parentCwd = getSessionCwd();
      const parentRoot = getWorkspaceRoot();

      const ctx = createSessionContext<string>(session(1, 'parent', parent));
      ctx.enter(session(2, 'child-a', childA));
      expect(getSessionCwd()).toBe(childA);
      const aCwd = getSessionCwd();
      const aRoot = getWorkspaceRoot();

      ctx.enter(session(3, 'child-b', childB));
      expect(getSessionCwd()).toBe(childB);
      expect(ctx.depth()).toBe(3);

      // leave B → exactly back to A's cwd/root
      ctx.leave();
      expect(getSessionCwd()).toBe(aCwd);
      expect(getWorkspaceRoot()).toBe(aRoot);
      expect(ctx.activeSessionId()).toBe(2);

      // leave A → exactly back to the parent
      ctx.leave();
      expect(getSessionCwd()).toBe(parentCwd);
      expect(getWorkspaceRoot()).toBe(parentRoot);
      expect(ctx.activeSessionId()).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('leave() at the root is a no-op returning null and does not move cwd', async () => {
    const {parent, cleanup} = await setupDirs();
    try {
      setSessionCwd(parent);
      const ctx = createSessionContext<string>(session(1, 'parent', parent));
      expect(ctx.leave()).toBeNull();
      expect(getSessionCwd()).toBe(parent);
      expect(ctx.isRoot()).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe('sessionContext — transcript isolation', () => {
  it('keeps parent and child buffers separate; child writes never touch the parent', async () => {
    const {parent, childA, cleanup} = await setupDirs();
    try {
      setSessionCwd(parent);
      const ctx = createSessionContext<string>(session(1, 'parent', parent));

      ctx.append('p1');
      ctx.append('p2');
      expect(ctx.transcript()).toEqual(['p1', 'p2']);

      const entered = ctx.enter(session(2, 'child-a', childA));
      // The child starts with an empty transcript — none of the parent's lines.
      expect(entered.transcript).toEqual([]);
      expect(ctx.transcript()).toEqual([]);

      ctx.append('c1');
      expect(ctx.transcript()).toEqual(['c1']);

      const left = ctx.leave()!;
      // Parent buffer is exactly as we left it; the child's write is invisible.
      expect(left.transcript).toEqual(['p1', 'p2']);
      expect(ctx.transcript()).toEqual(['p1', 'p2']);
      // …and the child's buffer is preserved independently.
      expect(ctx.transcriptFor('child-a')).toEqual(['c1']);
    } finally {
      await cleanup();
    }
  });

  it('re-entering a session restores its prior transcript (buffers persist across leave)', async () => {
    const {parent, childA, cleanup} = await setupDirs();
    try {
      setSessionCwd(parent);
      const ctx = createSessionContext<string>(session(1, 'parent', parent));
      const child = session(2, 'child-a', childA);

      ctx.enter(child);
      ctx.append('c1');
      ctx.leave();

      const reentered = ctx.enter(child);
      expect(reentered.transcript).toEqual(['c1']);
      ctx.append('c2');
      expect(ctx.transcript()).toEqual(['c1', 'c2']);
      ctx.leave();
    } finally {
      await cleanup();
    }
  });

  it('replaceTranscript swaps the active buffer in place without affecting others', async () => {
    const {parent, childA, cleanup} = await setupDirs();
    try {
      setSessionCwd(parent);
      const ctx = createSessionContext<string>(session(1, 'parent', parent));
      ctx.append('p1');

      ctx.enter(session(2, 'child-a', childA));
      ctx.replaceTranscript(['c1', 'c2', 'c3']);
      expect(ctx.transcript()).toEqual(['c1', 'c2', 'c3']);
      ctx.leave();

      expect(ctx.transcript()).toEqual(['p1']);
      expect(ctx.transcriptFor('child-a')).toEqual(['c1', 'c2', 'c3']);
    } finally {
      await cleanup();
    }
  });
});

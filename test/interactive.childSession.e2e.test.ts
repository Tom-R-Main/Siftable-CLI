/**
 * Lane C S7 — end-to-end-ish proof: spawn → enter → run a turn → leave, wiring
 * the real childSessionController + sessionContext to a FAKE engine (no codex
 * app-server, no live OpenFunction model — same posture as the codex-client
 * suite). The engine just records the cwd it ran in and writes to the active
 * transcript, exactly as a real turn would.
 *
 * This is the single check that fails if any of S1–S3 regressed into a mixed
 * log: after the child turn, the parent's transcript buffer must contain NONE of
 * the child's messages and vice versa — that is the "full interactive child
 * thread" criterion in one assertion.
 *
 * Scope note: turns run one at a time (the harness drives them sequentially);
 * concurrent child execution is intentionally out of scope for Lane C.
 */
import {mkdtemp, mkdir, rm, realpath, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createGitRunner, resolveRepoRoot, type GitRunner} from '../interactive-tui/worktreeService';
import {resetMergeMasterForTests} from '../interactive-tui/mergeMaster';
import {createChildSessionController} from '../interactive-tui/childSessionController';
import {createSessionContext} from '../interactive-tui/sessionContext';
import {getSessionCwd, setSessionCwd} from '../interactive-tui/navigation';

const git: GitRunner = createGitRunner();

async function setupRepo(): Promise<{repoRoot: string; worktreesRoot: string; cleanup: () => Promise<void>}> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'sift-childe2e-')));
  const repoRoot = join(base, 'repo');
  const worktreesRoot = join(base, 'worktrees');
  await mkdir(repoRoot, {recursive: true});
  await mkdir(worktreesRoot, {recursive: true});
  const run = (args: string[]) => {
    const res = git(args, repoRoot);
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.spawnError}`);
  };
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'test@siftable.io']);
  run(['config', 'user.name', 'Sift Test']);
  run(['config', 'commit.gpgsign', 'false']);
  await writeFile(join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  run(['add', '.']);
  run(['commit', '-m', 'initial']);
  return {
    repoRoot: resolveRepoRoot(repoRoot, git),
    worktreesRoot,
    cleanup: () => rm(base, {recursive: true, force: true}),
  };
}

let savedUserCwd: string | undefined;
let savedWorkspaceRoot: string | undefined;

beforeEach(() => {
  savedUserCwd = process.env.SIFT_USER_CWD;
  savedWorkspaceRoot = process.env.SIFT_WORKSPACE_ROOT;
  resetMergeMasterForTests();
});

afterEach(() => {
  resetMergeMasterForTests();
  if (savedUserCwd === undefined) delete process.env.SIFT_USER_CWD;
  else process.env.SIFT_USER_CWD = savedUserCwd;
  if (savedWorkspaceRoot === undefined) delete process.env.SIFT_WORKSPACE_ROOT;
  else process.env.SIFT_WORKSPACE_ROOT = savedWorkspaceRoot;
});

describe('child session lifecycle — spawn → enter → run → leave', () => {
  it('runs the child turn in the child worktree and keeps transcripts separate', async () => {
    const {repoRoot, worktreesRoot, cleanup} = await setupRepo();
    try {
      const controller = createChildSessionController({runner: git, worktreesRoot});
      const sessionCtx = createSessionContext<string>({
        sessionId: 0,
        conversationKey: 'parent',
        sessionCwd: repoRoot,
      });

      // The "live store" the TUI renders, swapped on enter/leave (mirrors index.tsx).
      const visible: string[] = [];
      const enter = (sessionId: number) => {
        const rec = controller.getChild(sessionId)!;
        sessionCtx.replaceTranscript([...visible]);
        const sw = sessionCtx.enter({
          sessionId: rec.sessionId,
          conversationKey: rec.conversationKey,
          sessionCwd: rec.worktreePath,
        });
        visible.splice(0, visible.length, ...sw.transcript);
      };
      const leave = () => {
        sessionCtx.replaceTranscript([...visible]);
        const sw = sessionCtx.leave()!;
        visible.splice(0, visible.length, ...sw.transcript);
      };

      // A fake engine: records the cwd it ran in (like ensureThread reading the
      // active cwd) and appends the turn to whatever transcript is active.
      const cwdsSeen: string[] = [];
      const runTurn = (prompt: string) => {
        const cwd = getSessionCwd();
        cwdsSeen.push(cwd);
        visible.push(`you: ${prompt}`);
        visible.push(`asst: ran in ${cwd}`);
      };

      // ── parent turn ──────────────────────────────────────────────────────
      setSessionCwd(repoRoot);
      runTurn('parent hello');
      expect(getSessionCwd()).toBe(repoRoot);

      // ── spawn + enter child ──────────────────────────────────────────────
      const res = controller.spawnChild({
        title: 'do the work',
        accessMode: 'read_write',
        writeScope: ['src/a.ts'],
        cwd: repoRoot,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const child = res.session;

      enter(child.sessionId);
      expect(getSessionCwd()).toBe(child.worktreePath); // cwd followed into the worktree
      expect(visible).toEqual([]); // child opens with a clean transcript

      // ── child turn (must run in the child worktree) ──────────────────────
      runTurn('child task');
      expect(cwdsSeen[cwdsSeen.length - 1]).toBe(child.worktreePath);

      // ── leave back to parent ─────────────────────────────────────────────
      leave();
      expect(getSessionCwd()).toBe(repoRoot);

      // ── LOAD-BEARING: transcripts never mixed ────────────────────────────
      expect(visible).toEqual(['you: parent hello', `asst: ran in ${repoRoot}`]);
      const childBuf = sessionCtx.transcriptFor(child.conversationKey);
      expect(childBuf).toEqual(['you: child task', `asst: ran in ${child.worktreePath}`]);

      // Explicit cross-checks in both directions.
      expect(visible.some((l) => l.includes('child task'))).toBe(false);
      expect(childBuf.some((l) => l.includes('parent hello'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('re-entering the child restores its transcript and cwd', async () => {
    const {repoRoot, worktreesRoot, cleanup} = await setupRepo();
    try {
      const controller = createChildSessionController({runner: git, worktreesRoot});
      const sessionCtx = createSessionContext<string>({sessionId: 0, conversationKey: 'parent', sessionCwd: repoRoot});
      const visible: string[] = [];
      const enter = (id: number) => {
        const rec = controller.getChild(id)!;
        sessionCtx.replaceTranscript([...visible]);
        const sw = sessionCtx.enter({sessionId: rec.sessionId, conversationKey: rec.conversationKey, sessionCwd: rec.worktreePath});
        visible.splice(0, visible.length, ...sw.transcript);
      };
      const leave = () => {
        sessionCtx.replaceTranscript([...visible]);
        const sw = sessionCtx.leave()!;
        visible.splice(0, visible.length, ...sw.transcript);
      };

      setSessionCwd(repoRoot);
      const res = controller.spawnChild({title: 'w', accessMode: 'read_write', writeScope: ['x'], cwd: repoRoot});
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const child = res.session;

      enter(child.sessionId);
      visible.push('you: first');
      leave();

      // Second visit: the child's prior line is back, and so is its cwd.
      enter(child.sessionId);
      expect(visible).toEqual(['you: first']);
      expect(getSessionCwd()).toBe(child.worktreePath);
      leave();
    } finally {
      await cleanup();
    }
  });
});

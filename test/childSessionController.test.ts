/**
 * Lane C S4 — childSessionController over a real temp Git repo.
 *
 * The guarantees under test are about *sequencing*, not just outcomes:
 *  - admit  → a worktree exists and a registry session points its cwd at it;
 *  - block  → ZERO `git worktree add` calls happen (Gate-A preflights before Git);
 *  - failure after creation → the worktree is cleaned up, never stranded.
 */
import {mkdtemp, mkdir, rm, stat, realpath, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  createGitRunner,
  listChildWorktrees,
  resolveRepoRoot,
  type GitRunner,
} from '../interactive-tui/worktreeService';
import {
  getMergeMasterSession,
  resetMergeMasterForTests,
} from '../interactive-tui/mergeMaster';
import {createChildSessionController} from '../interactive-tui/childSessionController';

const git: GitRunner = createGitRunner();

/** Wrap a real runner so a test can count the git commands that were issued. */
function spyRunner(): {runner: GitRunner; calls: string[][]} {
  const base = createGitRunner();
  const calls: string[][] = [];
  const runner: GitRunner = (args, cwd) => {
    calls.push(args);
    return base(args, cwd);
  };
  return {runner, calls};
}

const worktreeAdds = (calls: string[][]) =>
  calls.filter((c) => c[0] === 'worktree' && c[1] === 'add').length;

async function setupRepo(): Promise<{repoRoot: string; worktreesRoot: string; cleanup: () => Promise<void>}> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'sift-childctrl-')));
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

beforeEach(() => resetMergeMasterForTests());
afterEach(() => resetMergeMasterForTests());

describe('childSessionController.spawnChild — admit path', () => {
  it('creates a worktree on disk and a session whose cwd is the worktree', async () => {
    const {repoRoot, worktreesRoot, cleanup} = await setupRepo();
    try {
      const ctrl = createChildSessionController({runner: git, worktreesRoot});
      const res = ctrl.spawnChild({
        title: 'fix the parser',
        accessMode: 'read_write',
        writeScope: ['src/parser.ts'],
        cwd: repoRoot,
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const rec = res.session;

      // Worktree exists on disk…
      await expect(stat(rec.worktreePath)).resolves.toBeDefined();
      expect(listChildWorktrees(repoRoot, git)).toHaveLength(1);

      // …and the registry session points its cwd at exactly that worktree.
      const live = getMergeMasterSession(rec.sessionId);
      expect(live).not.toBeNull();
      expect(live?.role).toBe('child');
      expect(live?.sessionCwd).toBe(rec.worktreePath);
      expect(live?.git.worktreePath).toBe(rec.worktreePath);
      expect(rec.conversationKey).toBeTruthy();
      expect(rec.baseBranch).toBe('main');
    } finally {
      await cleanup();
    }
  });
});

describe('childSessionController.spawnChild — Gate-A block preflights before Git', () => {
  it('blocks a scope-overlapping sibling with ZERO worktree-add calls', async () => {
    const {repoRoot, worktreesRoot, cleanup} = await setupRepo();
    try {
      const {runner, calls} = spyRunner();
      const ctrl = createChildSessionController({runner, worktreesRoot});

      const a = ctrl.spawnChild({
        title: 'A',
        accessMode: 'read_write',
        writeScope: ['src/shared.ts'],
        cwd: repoRoot,
      });
      expect(a.ok).toBe(true);
      expect(worktreeAdds(calls)).toBe(1); // A created exactly one worktree

      const b = ctrl.spawnChild({
        title: 'B',
        accessMode: 'read_write',
        writeScope: ['src/shared.ts'], // overlaps A → must serialize
        cwd: repoRoot,
      });
      expect(b.ok).toBe(false);
      if (!b.ok) {
        expect(b.reason).toMatch(/serialized/i);
        expect(b.blockedBy).toBe(a.ok ? a.session.sessionId : -1);
      }

      // The whole point: B did NO Git — no second worktree add, none on disk.
      expect(worktreeAdds(calls)).toBe(1);
      expect(listChildWorktrees(repoRoot, git)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('admits a non-overlapping sibling (different scope → second worktree)', async () => {
    const {repoRoot, worktreesRoot, cleanup} = await setupRepo();
    try {
      const ctrl = createChildSessionController({runner: git, worktreesRoot});
      const a = ctrl.spawnChild({title: 'A', accessMode: 'read_write', writeScope: ['src/a.ts'], cwd: repoRoot});
      const b = ctrl.spawnChild({title: 'B', accessMode: 'read_write', writeScope: ['src/b.ts'], cwd: repoRoot});
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(listChildWorktrees(repoRoot, git)).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });
});

describe('childSessionController.spawnChild — post-creation failure cleanup', () => {
  it('removes the worktree when the registry rejects the session', async () => {
    const {repoRoot, worktreesRoot, cleanup} = await setupRepo();
    try {
      const ctrl = createChildSessionController({
        runner: git,
        worktreesRoot,
        // Preflight admits (no scopes recorded), worktree gets created, THEN the
        // registry rejects — exercising the cleanup branch deterministically.
        registerSession: () => ({
          sessionId: 0,
          admitted: false,
          admission: {admit: false, conflictSessionId: 0, sharedScope: [], reason: 'simulated backend rejection'},
        }),
      });
      const res = ctrl.spawnChild({title: 'C', accessMode: 'read_write', writeScope: ['x'], cwd: repoRoot});

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toMatch(/simulated backend rejection/);
      // Created-then-removed → nothing stranded.
      expect(listChildWorktrees(repoRoot, git)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('removes the worktree when a later step throws', async () => {
    const {repoRoot, worktreesRoot, cleanup} = await setupRepo();
    try {
      const ctrl = createChildSessionController({
        runner: git,
        worktreesRoot,
        registerSession: () => {
          throw new Error('boom in registry');
        },
      });
      expect(() =>
        ctrl.spawnChild({title: 'D', accessMode: 'read_write', writeScope: ['y'], cwd: repoRoot}),
      ).toThrow('boom in registry');
      expect(listChildWorktrees(repoRoot, git)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

describe('childSessionController — list + remove', () => {
  it('lists live children with status and removes one cleanly', async () => {
    const {repoRoot, worktreesRoot, cleanup} = await setupRepo();
    try {
      const ctrl = createChildSessionController({runner: git, worktreesRoot});
      const a = ctrl.spawnChild({title: 'A', accessMode: 'read_write', writeScope: ['src/a.ts'], cwd: repoRoot});
      expect(a.ok).toBe(true);
      if (!a.ok) return;

      const listed = ctrl.listChildSessions();
      expect(listed).toHaveLength(1);
      expect(listed[0].sessionId).toBe(a.session.sessionId);
      expect(listed[0].status).toBe('running');

      const removed = ctrl.removeChild(a.session.sessionId);
      expect(removed.ok).toBe(true);
      expect(ctrl.listChildSessions()).toHaveLength(0);
      expect(listChildWorktrees(repoRoot, git)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

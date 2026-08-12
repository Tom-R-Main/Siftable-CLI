/**
 * Lane C S4 — childSessionController over a real temp Git repo.
 *
 * The guarantees under test are about *sequencing*, not just outcomes:
 *  - admit  → a worktree exists and a registry session points its cwd at it;
 *  - block  → ZERO `git worktree add` calls happen (Gate-A preflights before Git);
 *  - failure after creation → the worktree is cleaned up, never stranded.
 */
import {mkdtemp, mkdir, rm, stat, realpath, symlink, writeFile} from 'node:fs/promises';
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
  type MergeMasterWorkIdentity,
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

const contractedWork: MergeMasterWorkIdentity = {
  workItemId: 'work-123',
  title: 'fix the parser',
  contract: {classification: 'bounded', profile: 'coding', version: 1},
  plan: {planId: 'plan-123', planVersion: 2, state: 'active'},
  writeScope: {include: ['src/parser.ts'], exclude: ['dist/**']},
};

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
      if (b.ok === false) {
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
      if (res.ok === false) expect(res.reason).toMatch(/simulated backend rejection/);
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

describe('childSessionController — contracted identity and recovery adoption', () => {
  it('carries safe work identity on the child record and registry snapshot', async () => {
    const {repoRoot, worktreesRoot, cleanup} = await setupRepo();
    try {
      const ctrl = createChildSessionController({runner: git, worktreesRoot});
      const result = ctrl.spawnChild({
        title: contractedWork.title,
        accessMode: 'read_write',
        writeScope: contractedWork.writeScope.include,
        cwd: repoRoot,
        work: contractedWork,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.session.work).toEqual(contractedWork);
      expect(getMergeMasterSession(result.session.sessionId)?.work).toEqual(contractedWork);
      expect(JSON.stringify(result.session)).not.toMatch(/claimToken|claimOwner/);
      expect(JSON.stringify(getMergeMasterSession(result.session.sessionId))).not.toMatch(/claimToken|claimOwner/);
    } finally {
      await cleanup();
    }
  });

  it('re-registers the exact recorded worktree without adding another worktree', async () => {
    const {repoRoot, worktreesRoot, cleanup} = await setupRepo();
    try {
      const firstSpy = spyRunner();
      const first = createChildSessionController({runner: firstSpy.runner, worktreesRoot});
      const spawned = first.spawnChild({
        title: contractedWork.title,
        accessMode: 'read_write',
        writeScope: contractedWork.writeScope.include,
        cwd: repoRoot,
        work: contractedWork,
      });
      expect(spawned.ok).toBe(true);
      if (!spawned.ok) return;
      expect(worktreeAdds(firstSpy.calls)).toBe(1);

      resetMergeMasterForTests();
      const recoverySpy = spyRunner();
      const recovered = createChildSessionController({runner: recoverySpy.runner, worktreesRoot});
      const adopted = recovered.adoptChild(spawned.session);

      expect(adopted.ok).toBe(true);
      if (!adopted.ok) return;
      expect(worktreeAdds(recoverySpy.calls)).toBe(0);
      expect(adopted.session.work).toEqual(contractedWork);
      expect(adopted.session.worktreePath).toBe(spawned.session.worktreePath);
      expect(adopted.session.branch).toBe(spawned.session.branch);
      expect(listChildWorktrees(repoRoot, git)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('adopts the deterministic prepared worktree left between Git creation and journal advancement', async () => {
    const {repoRoot, worktreesRoot, cleanup} = await setupRepo();
    try {
      const input = {
        title: contractedWork.title,
        accessMode: 'read_write' as const,
        writeScope: contractedWork.writeScope.include,
        cwd: repoRoot,
        work: contractedWork,
      };
      const firstSpy = spyRunner();
      const first = createChildSessionController({runner: firstSpy.runner, worktreesRoot});
      const prepared = first.resolveLaunch(input);
      const spawned = first.spawnOrAdoptChild(input, prepared);
      expect(spawned.ok).toBe(true);
      expect(worktreeAdds(firstSpy.calls)).toBe(1);

      resetMergeMasterForTests();
      const recoverySpy = spyRunner();
      const recovered = createChildSessionController({runner: recoverySpy.runner, worktreesRoot});
      const adopted = recovered.spawnOrAdoptChild(input, prepared);

      expect(adopted.ok).toBe(true);
      expect(worktreeAdds(recoverySpy.calls)).toBe(0);
      if (adopted.ok) {
        expect(adopted.session.branch).toBe(prepared.branch);
        expect(adopted.session.worktreePath).toBe(prepared.worktreePath);
        expect(adopted.session.baseCommit).toBe(prepared.baseCommit);
      }
    } finally {
      await cleanup();
    }
  });

  it('tears down an exact prepared launch without a registered session', async () => {
    const {repoRoot, worktreesRoot, cleanup} = await setupRepo();
    try {
      const input = {
        title: contractedWork.title,
        accessMode: 'read_write' as const,
        writeScope: contractedWork.writeScope.include,
        cwd: repoRoot,
        work: contractedWork,
      };
      const controller = createChildSessionController({runner: git, worktreesRoot});
      const launch = controller.resolveLaunch(input);
      const spawned = controller.spawnOrAdoptChild(input, launch);
      expect(spawned.ok).toBe(true);

      expect(controller.teardownLaunch(launch)).toEqual({ok: true});
      expect(listChildWorktrees(repoRoot, git)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('refuses to tear down a deterministic path occupied by a different branch', async () => {
    const {repoRoot, worktreesRoot, cleanup} = await setupRepo();
    try {
      const input = {
        title: contractedWork.title,
        accessMode: 'read_write' as const,
        writeScope: contractedWork.writeScope.include,
        cwd: repoRoot,
        work: contractedWork,
      };
      const controller = createChildSessionController({runner: git, worktreesRoot});
      const launch = controller.resolveLaunch(input);
      const spawned = controller.spawnOrAdoptChild(input, launch);
      expect(spawned.ok).toBe(true);
      if (!spawned.ok) return;
      expect(git(['branch', '-m', 'foreign-branch'], spawned.session.worktreePath).status).toBe(0);

      const removed = controller.teardownLaunch(launch);

      expect(removed.ok).toBe(false);
      if (!removed.ok) expect(removed.reason).toContain('mismatched checkout');
      await expect(stat(spawned.session.worktreePath)).resolves.toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it('rejects a recovered worktree whose live head no longer descends from the prepared base', async () => {
    const {repoRoot, worktreesRoot, cleanup} = await setupRepo();
    try {
      const first = createChildSessionController({runner: git, worktreesRoot});
      const spawned = first.spawnChild({
        title: contractedWork.title,
        accessMode: 'read_write',
        writeScope: contractedWork.writeScope.include,
        cwd: repoRoot,
        work: contractedWork,
      });
      expect(spawned.ok).toBe(true);
      if (!spawned.ok) return;
      const child = spawned.session;
      expect(git(['checkout', '--orphan', 'replacement'], child.worktreePath).status).toBe(0);
      await writeFile(join(child.worktreePath, 'replacement.txt'), 'unrelated\n', 'utf8');
      expect(git(['add', '.'], child.worktreePath).status).toBe(0);
      expect(git(['commit', '-m', 'unrelated root'], child.worktreePath).status).toBe(0);
      expect(git(['branch', '-D', child.branch], child.worktreePath).status).toBe(0);
      expect(git(['branch', '-m', child.branch], child.worktreePath).status).toBe(0);

      resetMergeMasterForTests();
      const recovered = createChildSessionController({runner: git, worktreesRoot});
      const adopted = recovered.adoptChild(child);

      expect(adopted.ok).toBe(false);
      if (!adopted.ok) expect(adopted.reason).toContain('no longer descends');
    } finally {
      await cleanup();
    }
  });

  it('adopts a recorded symlink path when Git reports the canonical worktree path', async () => {
    const {repoRoot, worktreesRoot, cleanup} = await setupRepo();
    try {
      const first = createChildSessionController({runner: git, worktreesRoot});
      const spawned = first.spawnChild({
        title: contractedWork.title,
        accessMode: 'read_write',
        writeScope: contractedWork.writeScope.include,
        cwd: repoRoot,
        work: contractedWork,
      });
      expect(spawned.ok).toBe(true);
      if (!spawned.ok) return;

      const symlinkPath = join(worktreesRoot, 'recorded-symlink');
      await symlink(spawned.session.worktreePath, symlinkPath, 'dir');
      resetMergeMasterForTests();
      const recoverySpy = spyRunner();
      const recovered = createChildSessionController({runner: recoverySpy.runner, worktreesRoot});
      const adopted = recovered.adoptChild({
        ...spawned.session,
        worktreePath: symlinkPath,
        sessionCwd: symlinkPath,
      });

      expect(adopted.ok).toBe(true);
      if (!adopted.ok) return;
      expect(worktreeAdds(recoverySpy.calls)).toBe(0);
      expect(adopted.session.worktreePath).toBe(await realpath(spawned.session.worktreePath));
      expect(listChildWorktrees(repoRoot, git)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});

/**
 * Lane D D1 — read-only merge-evaluation git helpers (mergeBase / countCommits /
 * diffNumstat / predictMergeConflicts). The load-bearing property is that none
 * of these mutate anything: a conflict must be PREDICTED purely against the
 * object store, with every working tree and the commit/branch graph byte-
 * identical before and after. If predictMergeConflicts ever fell back to a real
 * `git merge` (which would create a commit or dirty a tree), this suite fails.
 */
import {mkdtemp, mkdir, writeFile, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  createGitRunner,
  resolveRepoRoot,
  resolveCommit,
  mergeBase,
  countCommits,
  diffNumstat,
  predictMergeConflicts,
  type GitRunner,
} from '../interactive-tui/worktreeService';

const git: GitRunner = createGitRunner();

interface Fixture {
  repoRoot: string;
  run: (args: string[], cwd?: string) => string;
  cleanup: () => Promise<void>;
}

/**
 * A repo whose `main` and `feature` branches diverge:
 *   base ── main:   conflict.txt = "MAIN", plus mainonly.txt
 *        └─ feature: conflict.txt = "FEATURE", plus featonly.txt
 * so a main↔feature merge conflicts on conflict.txt. A `clean` branch only adds
 * an unrelated file, so it merges into main with no conflict.
 */
async function setupDivergent(): Promise<Fixture> {
  const baseDir = await realpath(await mkdtemp(join(tmpdir(), 'sift-mergeeval-')));
  const repoRoot = join(baseDir, 'repo');
  await mkdir(repoRoot, {recursive: true});
  const run = (args: string[], cwd = repoRoot): string => {
    const res = git(args, cwd);
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.spawnError}`);
    return res.stdout;
  };
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'test@siftable.io']);
  run(['config', 'user.name', 'Sift Test']);
  run(['config', 'commit.gpgsign', 'false']);
  await writeFile(join(repoRoot, 'conflict.txt'), 'line1\nline2\n', 'utf8');
  run(['add', '.']);
  run(['commit', '-m', 'base']);

  // feature diverges first (forks at base).
  run(['checkout', '-b', 'feature']);
  await writeFile(join(repoRoot, 'conflict.txt'), 'line1\nFEATURE\n', 'utf8');
  await writeFile(join(repoRoot, 'featonly.txt'), 'feat\n', 'utf8');
  run(['add', '.']);
  run(['commit', '-m', 'feature work']);

  // clean diverges from base too, touching only an unrelated path.
  run(['checkout', 'main']);
  run(['checkout', '-b', 'clean']);
  await writeFile(join(repoRoot, 'cleanonly.txt'), 'clean\n', 'utf8');
  run(['add', '.']);
  run(['commit', '-m', 'clean work']);

  // main moves so it conflicts with feature on conflict.txt.
  run(['checkout', 'main']);
  await writeFile(join(repoRoot, 'conflict.txt'), 'line1\nMAIN\n', 'utf8');
  await writeFile(join(repoRoot, 'mainonly.txt'), 'main\n', 'utf8');
  run(['add', '.']);
  run(['commit', '-m', 'main work']);

  return {repoRoot: resolveRepoRoot(repoRoot, git), run, cleanup: () => rm(baseDir, {recursive: true, force: true})};
}

/** A signature of all mutable state we require predictMergeConflicts to preserve. */
function repoSignature(repoRoot: string): string {
  // every commit on every branch + worktree porcelain status; any merge/commit
  // or dirtied tree would change this string.
  const log = git(['log', '--all', '--format=%H %s'], repoRoot).stdout;
  const branches = git(['branch', '--format=%(refname) %(objectname)'], repoRoot).stdout;
  const status = git(['status', '--porcelain'], repoRoot).stdout;
  const reflog = git(['reflog', '--all'], repoRoot).stdout;
  return [log, branches, status, reflog].join('\n----\n');
}

describe('lane D D1 — merge-evaluation git helpers', () => {
  it('resolveCommit / mergeBase / countCommits read the graph correctly', async () => {
    const fx = await setupDivergent();
    try {
      const main = resolveCommit(fx.repoRoot, 'main', git)!;
      const feature = resolveCommit(fx.repoRoot, 'feature', git)!;
      expect(main).toMatch(/^[0-9a-f]{40}$/);
      expect(feature).not.toBe(main);
      expect(resolveCommit(fx.repoRoot, 'no-such-branch', git)).toBeNull();

      const base = mergeBase(fx.repoRoot, main, feature, git)!;
      // the merge-base is the original "base" commit, an ancestor of both tips.
      expect(base).toMatch(/^[0-9a-f]{40}$/);
      expect(base).not.toBe(main);
      expect(base).not.toBe(feature);

      // main is exactly one commit ahead of the fork point.
      expect(countCommits(fx.repoRoot, `${base}..${main}`, git)).toBe(1);
    } finally {
      await fx.cleanup();
    }
  });

  it('diffNumstat reports per-file add/delete counts between two commits', async () => {
    const fx = await setupDivergent();
    try {
      const main = resolveCommit(fx.repoRoot, 'main', git)!;
      const feature = resolveCommit(fx.repoRoot, 'feature', git)!;
      const base = mergeBase(fx.repoRoot, main, feature, git)!;

      const files = diffNumstat(fx.repoRoot, base, feature, git);
      const byPath = new Map(files.map((f) => [f.path, f]));
      // feature changed conflict.txt and added featonly.txt — nothing else.
      expect([...byPath.keys()].sort()).toEqual(['conflict.txt', 'featonly.txt']);
      expect(byPath.get('featonly.txt')!.additions).toBe(1);
      expect(byPath.get('featonly.txt')!.deletions).toBe(0);
      expect(byPath.get('conflict.txt')!.binary).toBe(false);
    } finally {
      await fx.cleanup();
    }
  });

  it('predicts a conflict between divergent branches — and mutates NOTHING', async () => {
    const fx = await setupDivergent();
    try {
      const main = resolveCommit(fx.repoRoot, 'main', git)!;
      const feature = resolveCommit(fx.repoRoot, 'feature', git)!;

      const before = repoSignature(fx.repoRoot);
      const pred = predictMergeConflicts(fx.repoRoot, main, feature, git);
      const after = repoSignature(fx.repoRoot);

      expect(pred.clean).toBe(false);
      expect(pred.conflicts).toContain('conflict.txt');
      expect(pred.mergedTree).toMatch(/^[0-9a-f]{40}$/);
      // Read-only guarantee: no new commit, no moved branch, no dirtied tree.
      expect(after).toBe(before);
    } finally {
      await fx.cleanup();
    }
  });

  it('predicts a clean merge for a non-overlapping branch', async () => {
    const fx = await setupDivergent();
    try {
      const main = resolveCommit(fx.repoRoot, 'main', git)!;
      const clean = resolveCommit(fx.repoRoot, 'clean', git)!;

      const before = repoSignature(fx.repoRoot);
      const pred = predictMergeConflicts(fx.repoRoot, main, clean, git);
      const after = repoSignature(fx.repoRoot);

      expect(pred.clean).toBe(true);
      expect(pred.conflicts).toEqual([]);
      expect(after).toBe(before);
    } finally {
      await fx.cleanup();
    }
  });

  it('mergeBase returns null for unrelated histories', async () => {
    const fx = await setupDivergent();
    try {
      // An orphan branch shares no history with main.
      fx.run(['checkout', '--orphan', 'orphan']);
      fx.run(['rm', '-rf', '.']);
      await writeFile(join(fx.repoRoot, 'orphan.txt'), 'x\n', 'utf8');
      fx.run(['add', '.']);
      fx.run(['commit', '-m', 'orphan root']);
      const orphan = resolveCommit(fx.repoRoot, 'orphan', git)!;
      const main = resolveCommit(fx.repoRoot, 'main', git)!;
      expect(mergeBase(fx.repoRoot, main, orphan, git)).toBeNull();
    } finally {
      await fx.cleanup();
    }
  });
});

import {
  MERGE_MASTER_STATUSES,
  TERMINAL_STATUSES,
  DEFAULT_MERGE_STRATEGY,
  type MergeMasterSession,
  type MergeMasterStatus,
  buildChildBranchName,
  buildMergeView,
  canTransition,
  childRequiresWorktree,
  conversationKeyForSession,
  createChildSession,
  createParentSession,
  getMergeMasterSession,
  getMergeView,
  isTerminalStatus,
  listMergeMasterSessions,
  MergeMasterModelError,
  mergeMasterNativeActive,
  resetMergeMasterForTests,
  resolveChildWorktreePath,
  transitionSessionStatus,
} from '../../interactive-tui/mergeMaster';

const REPO = '/Users/dev/projects/widgets';

function makeParent(over: Partial<MergeMasterSession> = {}): MergeMasterSession {
  return {
    sessionId: 1,
    role: 'parent',
    parentSessionId: null,
    status: 'running',
    accessMode: 'read_write',
    launchDir: '/Users/dev',
    sessionCwd: REPO,
    git: {repoRoot: REPO, worktreePath: REPO, branch: 'main', headCommit: 'a'.repeat(40)},
    baseBranch: null,
    baseCommit: null,
    conversationKey: `${REPO} parent`,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...over,
  };
}

function makeChild(over: Partial<MergeMasterSession> = {}): MergeMasterSession {
  const childWorktree = '/Users/dev/.siftable/worktrees/widgets-abc/feature';
  return {
    sessionId: 2,
    role: 'child',
    parentSessionId: 1,
    status: 'running',
    accessMode: 'read_write',
    launchDir: '/Users/dev',
    sessionCwd: childWorktree,
    git: {repoRoot: REPO, worktreePath: childWorktree, branch: 'sift/feature-abc123', headCommit: 'b'.repeat(40)},
    baseBranch: 'main',
    baseCommit: 'a'.repeat(40),
    conversationKey: `${REPO} child sift/feature-abc123 2`,
    createdAtMs: 2,
    updatedAtMs: 2,
    ...over,
  };
}

describe('mergeMaster — status lifecycle', () => {
  it('exposes the seven required statuses', () => {
    const required: MergeMasterStatus[] = [
      'running',
      'needs_input',
      'ready_to_merge',
      'merge_blocked',
      'merged',
      'rejected',
      'abandoned',
    ];
    for (const status of required) {
      expect(MERGE_MASTER_STATUSES).toContain(status);
    }
    expect(MERGE_MASTER_STATUSES).toHaveLength(required.length);
  });

  it('treats merged/rejected/abandoned as terminal and nothing else', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['abandoned', 'merged', 'rejected']);
    expect(isTerminalStatus('merged')).toBe(true);
    expect(isTerminalStatus('rejected')).toBe(true);
    expect(isTerminalStatus('abandoned')).toBe(true);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('merge_blocked')).toBe(false);
  });

  it('allows the expected transitions and blocks the rest', () => {
    expect(canTransition('running', 'ready_to_merge')).toBe(true);
    expect(canTransition('ready_to_merge', 'merged')).toBe(true);
    expect(canTransition('merge_blocked', 'running')).toBe(true);
    expect(canTransition('merge_blocked', 'ready_to_merge')).toBe(true);
    expect(canTransition('needs_input', 'running')).toBe(true);

    // No escape from a terminal state.
    for (const terminal of TERMINAL_STATUSES) {
      for (const to of MERGE_MASTER_STATUSES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
    // You cannot skip straight from running to merged without the gate.
    expect(canTransition('running', 'merged')).toBe(false);
  });
});

describe('mergeMaster — worktree access rule', () => {
  it('requires a worktree for write-capable children, not for read-only', () => {
    expect(childRequiresWorktree('read_write')).toBe(true);
    expect(childRequiresWorktree('read_only')).toBe(false);
  });
});

describe('mergeMaster — directory + branch derivation', () => {
  it('namespaces child branches under sift/ and is deterministic', () => {
    const a = buildChildBranchName('child-1', 'Fix login bug');
    const b = buildChildBranchName('child-1', 'Fix login bug');
    expect(a).toBe(b);
    expect(a.startsWith('sift/')).toBe(true);
    expect(a).toContain('fix-login-bug');
  });

  it('places child worktrees under the layout root, outside the repo, uniquely per (repo, branch)', () => {
    const layout = {worktreesRoot: '/Users/dev/.siftable/worktrees'};
    const p1 = resolveChildWorktreePath(layout, REPO, 'sift/feature-abc123');
    const p2 = resolveChildWorktreePath(layout, REPO, 'sift/other-def456');
    expect(p1.startsWith(layout.worktreesRoot)).toBe(true);
    expect(p1.startsWith(REPO)).toBe(false); // never nested inside the user's repo
    expect(p1).not.toBe(p2);
    expect(resolveChildWorktreePath(layout, REPO, 'sift/feature-abc123')).toBe(p1); // idempotent
  });

  it('gives parent and each child distinct conversation keys', () => {
    const parentKey = conversationKeyForSession({repoRoot: REPO, role: 'parent', branch: 'main', seed: ''});
    const childKey = conversationKeyForSession({repoRoot: REPO, role: 'child', branch: 'sift/feature-abc123', seed: '2'});
    expect(parentKey).not.toBe(childKey);
  });
});

describe('mergeMaster — merge view assembly', () => {
  it('separates every path and ref into its own field', () => {
    const view = buildMergeView(makeParent(), makeChild());
    expect(view.parentSessionId).toBe(1);
    expect(view.childSessionId).toBe(2);
    expect(view.repoRoot).toBe(REPO);
    expect(view.parentWorktreePath).toBe(REPO);
    expect(view.childWorktreePath).toBe('/Users/dev/.siftable/worktrees/widgets-abc/feature');
    expect(view.baseBranch).toBe('main');
    expect(view.childBranch).toBe('sift/feature-abc123');
    expect(view.baseCommit).toBe('a'.repeat(40));
    expect(view.headCommit).toBe('b'.repeat(40));
    expect(view.mergeStrategy).toBe(DEFAULT_MERGE_STRATEGY);

    // The whole point: parent and child working trees are not the same dir.
    expect(view.childWorktreePath).not.toBe(view.parentWorktreePath);
    // ...yet both descend from one shared repo root.
    expect(view.repoRoot).toBe(view.parentWorktreePath);
  });

  it('lets a read-only child share the parent working tree', () => {
    const child = makeChild({
      accessMode: 'read_only',
      git: {repoRoot: REPO, worktreePath: REPO, branch: 'main', headCommit: 'a'.repeat(40)},
      sessionCwd: REPO,
    });
    const view = buildMergeView(makeParent(), child);
    expect(view.childWorktreePath).toBe(view.parentWorktreePath);
  });

  it('rejects a write-capable child that shares the parent working tree', () => {
    const bad = makeChild({
      accessMode: 'read_write',
      git: {repoRoot: REPO, worktreePath: REPO, branch: 'sift/feature-abc123', headCommit: 'b'.repeat(40)},
    });
    expect(() => buildMergeView(makeParent(), bad)).toThrow(MergeMasterModelError);
  });

  it('rejects mismatched parent/child linkage', () => {
    expect(() => buildMergeView(makeParent(), makeChild({parentSessionId: 999}))).toThrow(MergeMasterModelError);
    expect(() => buildMergeView(makeParent({role: 'child'}), makeChild())).toThrow(MergeMasterModelError);
  });

  it('rejects a child missing its base anchor', () => {
    expect(() => buildMergeView(makeParent(), makeChild({baseCommit: null}))).toThrow(MergeMasterModelError);
  });
});

describe('mergeMaster — registry (TS fallback under node)', () => {
  beforeEach(() => resetMergeMasterForTests());

  it('uses the TS fallback when the native dylib is unavailable (ts-jest/node)', () => {
    expect(mergeMasterNativeActive()).toBe(false);
  });

  it('creates a parent and a write-capable child with inherited repo/launch dirs', () => {
    const parentId = createParentSession({
      repoRoot: REPO,
      launchDir: '/Users/dev',
      sessionCwd: REPO,
      branch: 'main',
      headCommit: 'a'.repeat(40),
    });
    expect(parentId).toBeGreaterThan(0);

    const childWorktree = '/Users/dev/.siftable/worktrees/widgets-abc/feature';
    const childId = createChildSession({
      parentSessionId: parentId,
      accessMode: 'read_write',
      branch: 'sift/feature-abc123',
      worktreePath: childWorktree,
      sessionCwd: childWorktree,
      baseBranch: 'main',
      baseCommit: 'a'.repeat(40),
      headCommit: 'b'.repeat(40),
    });
    expect(childId).toBeGreaterThan(0);

    const view = getMergeView(childId)!;
    expect(view.parentSessionId).toBe(parentId);
    expect(view.childSessionId).toBe(childId);
    expect(view.repoRoot).toBe(REPO);
    expect(view.parentWorktreePath).toBe(REPO);
    expect(view.childWorktreePath).toBe(childWorktree);
    expect(view.childWorktreePath).not.toBe(view.parentWorktreePath);
    expect(view.baseBranch).toBe('main');
    expect(view.childBranch).toBe('sift/feature-abc123');
    expect(view.mergeStrategy).toBe(DEFAULT_MERGE_STRATEGY);
    expect(listMergeMasterSessions()).toHaveLength(2);

    // Snapshot must carry nested git state and a derived (non-empty) conversation key.
    const childSession = getMergeMasterSession(childId)!;
    expect(childSession.git).toEqual({
      repoRoot: REPO,
      worktreePath: childWorktree,
      branch: 'sift/feature-abc123',
      headCommit: 'b'.repeat(40),
    });
    expect(childSession.conversationKey).toBe(`${REPO} child sift/feature-abc123 ${childId}`);
    expect(getMergeMasterSession(parentId)!.conversationKey).toBe(`${REPO} parent`);
  });

  it('refuses a write-capable child that would share the parent working tree', () => {
    const parentId = createParentSession({repoRoot: REPO, launchDir: '/d', sessionCwd: REPO, branch: 'main'});
    const childId = createChildSession({
      parentSessionId: parentId,
      accessMode: 'read_write',
      branch: 'sift/x',
      worktreePath: REPO, // same as parent — illegal
      sessionCwd: REPO,
      baseBranch: 'main',
      baseCommit: 'a'.repeat(40),
    });
    expect(childId).toBe(0);
  });

  it('enforces the status lifecycle through the registry', () => {
    const parentId = createParentSession({repoRoot: REPO, launchDir: '/d', sessionCwd: REPO, branch: 'main'});
    const childId = createChildSession({
      parentSessionId: parentId,
      accessMode: 'read_write',
      branch: 'sift/x',
      worktreePath: '/wt/x',
      sessionCwd: '/wt/x',
      baseBranch: 'main',
      baseCommit: 'a'.repeat(40),
    });
    expect(transitionSessionStatus(childId, 'merged')).not.toBe(0); // illegal: skips the gate
    expect(transitionSessionStatus(childId, 'ready_to_merge')).toBe(0);
    expect(transitionSessionStatus(childId, 'merged')).toBe(0);
    expect(transitionSessionStatus(childId, 'running')).not.toBe(0); // terminal
    expect(getMergeView(childId)!.status).toBe('merged');
  });
});

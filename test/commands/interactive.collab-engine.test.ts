import {
  appendCollabEvent,
  cancelCollabSession,
  claimNextCollabBranch,
  completeCollabBranch,
  createCollabSession,
  enqueueCollabBranch,
  heartbeatCollabBranch,
  listCollabSessions,
  resetCollabEngineForTests,
  snapshotCollabSession,
} from '../../interactive-tui/collabEngine';

describe('collabEngine', () => {
  const previousNoNative = process.env.SIFT_NO_NATIVE;

  beforeEach(() => {
    process.env.SIFT_NO_NATIVE = '1';
    resetCollabEngineForTests();
  });

  afterAll(() => {
    if (previousNoNative === undefined) delete process.env.SIFT_NO_NATIVE;
    else process.env.SIFT_NO_NATIVE = previousNoNative;
    resetCollabEngineForTests();
  });

  it('claims, journals, and completes a branch', () => {
    const sessionId = createCollabSession({
      root: '/Users/example/project',
      cwd: '/Users/example/project/packages/cli',
      maxBranches: 4,
    });
    const branchId = enqueueCollabBranch(sessionId, {
      role: 'tests',
      focus: 'Find tests that constrain explorer behavior',
      maxToolCalls: 4,
      maxElapsedMs: 5000,
    });

    const claim = claimNextCollabBranch(sessionId, { worker: 'worker-a', nowMs: 1000, leaseMs: 2500 });
    expect(claim).toMatchObject({ branchId, leaseExpiresMs: 3500 });
    expect(claim?.leaseToken).toBeGreaterThan(0);

    appendCollabEvent(branchId, {
      leaseToken: claim!.leaseToken,
      type: 'tool_call',
      payload: JSON.stringify({ name: 'search_local_files' }),
      nowMs: 1100,
    });
    const leaseExpiresMs = heartbeatCollabBranch(branchId, {
      leaseToken: claim!.leaseToken,
      nowMs: 1200,
      leaseMs: 4000,
    });
    expect(leaseExpiresMs).toBe(5200);
    completeCollabBranch(branchId, {
      leaseToken: claim!.leaseToken,
      output: JSON.stringify({ files: ['interactive.explorer.test.ts'] }),
      nowMs: 1300,
    });

    expect(snapshotCollabSession(sessionId)).toMatchObject({
      sessionId,
      cancelled: false,
      root: '/Users/example/project',
      cwd: '/Users/example/project/packages/cli',
      branches: [
        {
          branchId,
          status: 'completed',
          role: 'tests',
          eventCount: 1,
          maxToolCalls: 4,
          maxElapsedMs: 5000,
          events: [{ type: 'tool_call' }],
        },
      ],
    });
    expect(listCollabSessions()).toHaveLength(1);
    expect(listCollabSessions()[0].sessionId).toBe(sessionId);
  });

  it('lets another worker reclaim an expired lease', () => {
    const sessionId = createCollabSession({ root: '/repo' });
    const branchId = enqueueCollabBranch(sessionId, { role: 'source_runtime' });
    const first = claimNextCollabBranch(sessionId, { worker: 'a', nowMs: 10, leaseMs: 10 });
    const second = claimNextCollabBranch(sessionId, { worker: 'b', nowMs: 25, leaseMs: 50 });

    expect(first?.branchId).toBe(branchId);
    expect(second?.branchId).toBe(branchId);
    expect(second?.leaseToken).not.toBe(first?.leaseToken);
    expect(snapshotCollabSession(sessionId).branches[0]).toMatchObject({
      status: 'running',
      worker: 'b',
      leaseExpiresMs: 75,
    });
  });

  it('cancels pending and running branches', () => {
    const sessionId = createCollabSession({ root: '/repo', maxBranches: 3 });
    enqueueCollabBranch(sessionId, { role: 'source_runtime' });
    enqueueCollabBranch(sessionId, { role: 'tests' });
    claimNextCollabBranch(sessionId, { worker: 'a', nowMs: 10, leaseMs: 100 });

    cancelCollabSession(sessionId);

    expect(snapshotCollabSession(sessionId)).toMatchObject({
      cancelled: true,
      branches: [
        { status: 'cancelled' },
        { status: 'cancelled' },
      ],
    });
  });
});

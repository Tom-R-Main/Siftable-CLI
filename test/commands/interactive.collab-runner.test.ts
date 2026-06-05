import { resetCollabEngineForTests, snapshotCollabSession } from '../../interactive-tui/collabEngine';
import { runCollabBranches } from '../../interactive-tui/collabRunner';

describe('collabRunner', () => {
  const previousNoNative = process.env.SIFT_NO_NATIVE;

  beforeEach(() => {
    process.env.SIFT_NO_NATIVE = '1';
    resetCollabEngineForTests();
  });

  afterEach(() => {
    resetCollabEngineForTests();
    if (previousNoNative === undefined) delete process.env.SIFT_NO_NATIVE;
    else process.env.SIFT_NO_NATIVE = previousNoNative;
  });

  it('runs branches, journals events, and finalizes completed and failed results', async () => {
    const run = await runCollabBranches({
      root: '/workspace',
      cwd: '/workspace/pkg',
      workerPrefix: 'test_worker',
      branches: [
        { id: 'a', role: 'alpha', ok: true },
        { id: 'b', role: 'beta', ok: false },
      ],
      specForBranch: (branch) => ({
        id: branch.id,
        role: branch.role,
        focus: `${branch.role} focus`,
        maxToolCalls: 3,
        maxElapsedMs: 1000,
      }),
      runBranch: async ({ branch, appendEvent, heartbeat }) => {
        appendEvent('branch_observed', { id: branch.id });
        heartbeat();
        return { id: branch.id, ok: branch.ok };
      },
      finalizeBranch: (result) => result.ok
        ? { status: 'completed', output: result }
        : { status: 'failed', error: `${result.id} failed` },
    });

    expect(run.results).toEqual([{ id: 'a', ok: true }, { id: 'b', ok: false }]);
    expect(run.sessionId).toEqual(expect.any(Number));
    expect(snapshotCollabSession(run.sessionId ?? 0)).toMatchObject({
      root: '/workspace',
      cwd: '/workspace/pkg',
      branches: [
        expect.objectContaining({
          role: 'alpha',
          status: 'completed',
          worker: 'test_worker:a',
          eventCount: 2,
          events: expect.arrayContaining([
            expect.objectContaining({ type: 'branch_started' }),
            expect.objectContaining({ type: 'branch_observed' }),
          ]),
        }),
        expect.objectContaining({
          role: 'beta',
          status: 'failed',
          worker: 'test_worker:b',
          error: 'b failed',
          eventCount: 2,
        }),
      ],
    });
  });

  it('can run branches sequentially with a shared collab session', async () => {
    const order: string[] = [];
    const run = await runCollabBranches({
      root: '/workspace',
      cwd: '/workspace',
      process: 'sequential',
      workerPrefix: 'sequential_worker',
      branches: [{ id: 'first' }, { id: 'second' }],
      specForBranch: (branch) => ({ id: branch.id, role: branch.id }),
      runBranch: async ({ branch }) => {
        order.push(branch.id);
        return branch.id;
      },
    });

    expect(run.results).toEqual(['first', 'second']);
    expect(order).toEqual(['first', 'second']);
    const snapshot = snapshotCollabSession(run.sessionId ?? 0);
    expect(snapshot.branches.map((branch) => branch.worker)).toEqual([
      'sequential_worker:first',
      'sequential_worker:second',
    ]);
    expect(snapshot.branches.map((branch) => branch.status)).toEqual(['completed', 'completed']);
  });
});

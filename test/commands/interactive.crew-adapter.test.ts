import { resetCollabEngineForTests, snapshotCollabSession } from '../../interactive-tui/collabEngine';
import { runSiftCrew } from '../../interactive-tui/crewAdapter';

describe('crewAdapter', () => {
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

  it('runs parallel crew tasks through the collab runner', async () => {
    const result = await runSiftCrew({
      root: '/repo',
      cwd: '/repo',
      name: 'parallel_probe',
      agents: [
        { id: 'researcher', role: 'Researcher', prompt: 'Find evidence', maxToolCalls: 2 },
        { id: 'reviewer', role: 'Reviewer', prompt: 'Check assumptions', maxToolCalls: 1 },
      ],
      tasks: [
        { id: 'research', agent: 'researcher', input: 'Map the code' },
        { id: 'review', agent: 'reviewer', input: 'Review the map' },
      ],
      runTask: async ({ task, input, priorResults, appendEvent }) => {
        appendEvent('agent_configured', { taskId: task.id });
        expect(input).toContain(`Task ${task.id}:`);
        expect(priorResults).toHaveLength(0);
        return `${task.id} done`;
      },
      reduce: (results) => results.map((item) => item.output).join(' | '),
    });

    expect(result.output).toBe('research done | review done');
    expect(result.taskResults).toMatchObject([
      { taskId: 'research', agentId: 'researcher', status: 'completed', output: 'research done' },
      { taskId: 'review', agentId: 'reviewer', status: 'completed', output: 'review done' },
    ]);
    expect(snapshotCollabSession(result.sessionId ?? 0)).toMatchObject({
      branches: [
        expect.objectContaining({ role: 'Researcher', status: 'completed', worker: 'crew:parallel_probe:research' }),
        expect.objectContaining({ role: 'Reviewer', status: 'completed', worker: 'crew:parallel_probe:review' }),
      ],
    });
  });

  it('passes prior task output through sequential crews', async () => {
    const seenInputs: string[] = [];
    const result = await runSiftCrew({
      root: '/repo',
      cwd: '/repo/pkg',
      name: 'sequential_probe',
      process: 'sequential',
      agents: [
        { id: 'mapper', role: 'Mapper', goal: 'Create the map', prompt: 'Map first' },
        { id: 'writer', role: 'Writer', prompt: 'Write from map' },
      ],
      tasks: [
        { id: 'map', agent: 'mapper', input: 'Find files' },
        { id: 'write', agent: 'writer', input: 'Summarize findings' },
      ],
      runTask: async ({ task, input, priorResults }) => {
        seenInputs.push(input);
        if (task.id === 'write') {
          expect(priorResults).toHaveLength(1);
          expect(input).toContain('- map (completed): file map');
        }
        return task.id === 'map' ? 'file map' : 'summary from file map';
      },
    });

    expect(seenInputs[0]).not.toContain('Prior task results:');
    expect(seenInputs[1]).toContain('Prior task results:');
    expect(result.taskResults.map((task) => task.output)).toEqual(['file map', 'summary from file map']);
    expect(snapshotCollabSession(result.sessionId ?? 0).cwd).toBe('/repo/pkg');
  });

  it('marks failed crew tasks as failed branches without throwing', async () => {
    const result = await runSiftCrew({
      root: '/repo',
      cwd: '/repo',
      name: 'failure_probe',
      agents: [{ id: 'worker', role: 'Worker', prompt: 'Do the task' }],
      tasks: [
        { id: 'ok', agent: 'worker', input: 'Succeed' },
        { id: 'fail', agent: 'worker', input: 'Fail' },
      ],
      runTask: async ({ task }) => {
        if (task.id === 'fail') throw new Error('expected failure');
        return 'ok';
      },
    });

    expect(result.taskResults).toMatchObject([
      { taskId: 'ok', status: 'completed', output: 'ok' },
      { taskId: 'fail', status: 'failed', error: 'expected failure' },
    ]);
    expect(snapshotCollabSession(result.sessionId ?? 0)).toMatchObject({
      branches: [
        expect.objectContaining({ status: 'completed' }),
        expect.objectContaining({ status: 'failed', error: 'expected failure' }),
      ],
    });
  });
});

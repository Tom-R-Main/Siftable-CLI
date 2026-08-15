import {
  AgentRuntimeDispatchError,
  buildAgentRuntimeDispatchPlan,
  type AgentRuntimeDispatchWorkItem,
} from '../../src/lib/agent-runtime/dispatch';
import {installIsolatedConfigDirHooks} from '../helpers/config-env';
import {mockFetch, restoreFetch, runCommand} from '../helpers/mock-api';

installIsolatedConfigDirHooks('sift-worker-dispatch-test-');

afterEach(() => {
  restoreFetch();
});

const SHA = 'a'.repeat(40);

function workItem(number: 1 | 2, include: string[]): AgentRuntimeDispatchWorkItem {
  const id = number === 1
    ? '11111111-1111-4111-8111-111111111111'
    : '22222222-2222-4222-8222-222222222222';
  return {
    id,
    projectId: '90475f63-0bf3-4baa-828b-e8cb8253039d',
    revision: number,
    title: `Worker ${number}`,
    status: 'queued',
    claimOwner: null,
    claimExpiresAt: null,
    claimability: {state: 'ready', blockedBy: []},
    contractSummary: {classification: 'bounded', version: 1, profile: 'coding'},
    acceptanceCriteria: [{text: `Worker ${number} succeeds`, met: false}],
    allowedActions: {read: true, write: true, test: true, network: true},
    writeScope: {include, exclude: []},
    verificationCommands: ['npm test'],
  };
}

describe('surface-neutral agent runtime dispatch', () => {
  it('produces one stable dispatch identity across T3, Codex, and work-item order', () => {
    const first = workItem(1, ['packages/one/**']);
    const second = workItem(2, ['packages/two/**']);
    const t3 = buildAgentRuntimeDispatchPlan({
      requestedBySurface: 't3',
      sourceGitSha: SHA,
      workItems: [first, second],
    });
    const codex = buildAgentRuntimeDispatchPlan({
      requestedBySurface: 'codex',
      sourceGitSha: SHA,
      workItems: [second, first],
    });

    expect(t3.dispatchId).toBe(codex.dispatchId);
    expect(t3.planSha256).toBe(codex.planSha256);
    expect(t3.requestedBySurface).toBe('t3');
    expect(codex.requestedBySurface).toBe('codex');
    expect(t3).toMatchObject({
      provider: 'aws',
      region: 'us-east-1',
      projectId: '90475f63-0bf3-4baa-828b-e8cb8253039d',
      marketType: 'on-demand',
      workerCount: 2,
      maximumInstanceHours: 2,
      executionEnabled: false,
    });
  });

  it('fails closed when directory and glob scopes could overlap', () => {
    expect(() => buildAgentRuntimeDispatchPlan({
      requestedBySurface: 'claude-code',
      sourceGitSha: SHA,
      workItems: [
        workItem(1, ['packages/**']),
        workItem(2, ['packages/exf-cli/src']),
      ],
    })).toThrow(new AgentRuntimeDispatchError(
      'Work-item scopes overlap and must be serialized: packages/** <-> packages/exf-cli/src',
    ));
  });

  it('rejects work that is not ready, bounded, unclaimed coding work', () => {
    const blocked = workItem(1, ['packages/one']);
    blocked.claimability = {state: 'waiting', blockedBy: []};
    expect(() => buildAgentRuntimeDispatchPlan({
      requestedBySurface: 'mcp',
      sourceGitSha: SHA,
      workItems: [blocked, workItem(2, ['packages/two'])],
    })).toThrow(/not claimable/);
  });

  it('does not combine work from different Sift projects', () => {
    const second = workItem(2, ['packages/two']);
    second.projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(() => buildAgentRuntimeDispatchPlan({
      requestedBySurface: 'cli',
      sourceGitSha: SHA,
      workItems: [workItem(1, ['packages/one']), second],
    })).toThrow(/same Sift project/);
  });

  it('exposes a read-only CLI command that performs only the two work-item reads', async () => {
    const first = workItem(1, ['packages/one']);
    const second = workItem(2, ['packages/two']);
    mockFetch()
      .on('GET', `/api/v1/work-items/${first.id}`).reply(200, {workItem: first})
      .on('GET', `/api/v1/work-items/${second.id}`).reply(200, {workItem: second})
      .install();

    const result = await runCommand([
      'worker',
      'dispatch',
      '--work-item', first.id,
      '--work-item', second.id,
      '--surface', 't3',
      '--source-sha', SHA,
      '--token', 'sift_pat_test',
      '--json',
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan).toMatchObject({requestedBySurface: 't3', region: 'us-east-1', executionEnabled: false});
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect((global.fetch as jest.Mock).mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });
});

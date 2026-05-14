import {installIsolatedConfigDirHooks} from '../helpers/config-env';
import {fixtures, mockFetch, restoreFetch, runCommand} from '../helpers/mock-api';

installIsolatedConfigDirHooks('sift-cli-agents-work-test-');

afterEach(() => {
  restoreFetch();
});

describe('agents commands', () => {
  it('lists agent aliases as JSON', async () => {
    mockFetch()
      .on('GET', '/api/v1/agents')
      .query(true)
      .reply(200, {
        agents: [
          {
            id: 'agent-001',
            alias: 'codex',
            displayName: 'Codex',
            agentType: 'codex',
            status: 'active',
          },
        ],
      })
      .install();

    const result = await runCommand(['agents', 'list', '--token', 'sift_pat_test', '--json']);
    const json = JSON.parse(result.stdout);
    expect(json).toHaveLength(1);
    expect(json[0].alias).toBe('codex');
  });

  it('creates agent aliases', async () => {
    mockFetch()
      .on('POST', '/api/v1/agents')
      .body((body) => (body as any).alias === 'browser-qa')
      .reply(201, {
        agent: {
          id: 'agent-002',
          alias: 'browser-qa',
          displayName: 'Browser QA',
          agentType: 'qa',
          status: 'active',
        },
      })
      .install();

    const result = await runCommand([
      'agents',
      'create',
      '--alias',
      'browser-qa',
      '--name',
      'Browser QA',
      '--type',
      'qa',
      '--token',
      'sift_pat_test',
      '--json',
    ]);
    const json = JSON.parse(result.stdout);
    expect(json.agent.alias).toBe('browser-qa');
  });
});

describe('work commands', () => {
  it('creates executable work linked to a human planning task', async () => {
    mockFetch()
      .on('POST', '/api/v1/work-items')
      .body((body) => {
        const input = body as any;
        return input.title === 'Implement Deploy v2'
          && input.taskId === 'task-001'
          && input.assignedAlias === 'codex'
          && Array.isArray(input.verificationCommands)
          && input.verificationCommands[0] === 'npm run build';
      })
      .reply(201, {
        workItem: {
          id: 'work-new',
          taskId: 'task-001',
          title: 'Implement Deploy v2',
          status: 'queued',
          assignedAlias: 'codex',
        },
      })
      .install();

    const result = await runCommand([
      'work',
      'create',
      '--title',
      'Implement Deploy v2',
      '--task',
      'task-001',
      '--agent',
      'codex',
      '--verify',
      'npm run build;npm test',
      '--token',
      'sift_pat_test',
      '--json',
    ]);

    const json = JSON.parse(result.stdout);
    expect(json.workItem.id).toBe('work-new');
    expect(json.workItem.taskId).toBe('task-001');
  });

  it('lists work items as JSON', async () => {
    mockFetch()
      .on('GET', '/api/v1/work-items')
      .query(true)
      .reply(200, {
        workItems: [
          {
            id: 'work-001',
            title: 'Run verification',
            status: 'queued',
            queueRank: 1,
            claimToken: 'should-not-render',
          },
        ],
      })
      .install();

    const result = await runCommand(['work', 'list', '--token', 'sift_pat_test', '--json']);
    const json = JSON.parse(result.stdout);
    expect(json).toHaveLength(1);
    expect(json[0].title).toBe('Run verification');
    expect(json[0].claimToken).toBeUndefined();
    expect(result.stdout).not.toContain('should-not-render');
  });

  it('redacts claim tokens from work get JSON output', async () => {
    mockFetch()
      .on('GET', '/api/v1/work-items/work-001')
      .reply(200, {
        workItem: {
          id: 'work-001',
          title: 'Run verification',
          status: 'running',
          claimToken: 'should-not-render',
        },
      })
      .install();

    const result = await runCommand(['work', 'get', 'work-001', '--token', 'sift_pat_test', '--json']);
    const json = JSON.parse(result.stdout);
    expect(json.claimToken).toBeUndefined();
    expect(result.stdout).not.toContain('should-not-render');
  });

  it('claims work with an owner lease', async () => {
    mockFetch()
      .on('POST', '/api/v1/work-items/claim')
      .body((body) => (body as any).assignedAlias === 'codex' && (body as any).claimOwner === 'codex-test')
      .reply(200, {
        workItem: {
          id: 'work-001',
          title: 'Run verification',
          status: 'claimed',
          claimOwner: 'codex-test',
          claimToken: 'claim-token',
        },
      })
      .install();

    const result = await runCommand([
      'work',
      'claim',
      '--agent',
      'codex',
      '--owner',
      'codex-test',
      '--token',
      'sift_pat_test',
      '--json',
    ]);
    const json = JSON.parse(result.stdout);
    expect(json.workItem.status).toBe('claimed');
    expect(json.workItem.claimToken).toBe('claim-token');
  });

  it('starts claimed work by positional ID', async () => {
    mockFetch()
      .on('POST', '/api/v1/work-items/work-001/start')
      .body((body) => {
        const input = body as any;
        return input.claimOwner === 'codex-test'
          && input.claimToken === 'claim-token'
          && input.leaseSeconds === 900;
      })
      .reply(200, {
        workItem: {
          id: 'work-001',
          title: 'Run verification',
          status: 'running',
          claimOwner: 'codex-test',
        },
      })
      .install();

    const result = await runCommand([
      'work',
      'start',
      'work-001',
      '--owner',
      'codex-test',
      '--claim-token',
      'claim-token',
      '--lease',
      '900',
      '--token',
      'sift_pat_test',
      '--json',
    ]);
    const json = JSON.parse(result.stdout);
    expect(json.workItem.id).toBe('work-001');
    expect(json.workItem.status).toBe('running');
  });

  it('blocks work by positional ID with a reason', async () => {
    mockFetch()
      .on('POST', '/api/v1/work-items/work-001/block')
      .body((body) => {
        const input = body as any;
        return input.claimOwner === 'codex-test'
          && input.claimToken === 'claim-token'
          && input.blockedReason === 'Waiting on OAuth'
          && input.failureReason === 'Waiting on OAuth';
      })
      .reply(200, {
        workItem: {
          id: 'work-001',
          title: 'Run verification',
          status: 'blocked',
          blockedReason: 'Waiting on OAuth',
        },
      })
      .install();

    const result = await runCommand([
      'work',
      'block',
      'work-001',
      '--owner',
      'codex-test',
      '--claim-token',
      'claim-token',
      '--reason',
      'Waiting on OAuth',
      '--token',
      'sift_pat_test',
      '--json',
    ]);
    const json = JSON.parse(result.stdout);
    expect(json.workItem.id).toBe('work-001');
    expect(json.workItem.status).toBe('blocked');
    expect(json.workItem.blockedReason).toBe('Waiting on OAuth');
  });

  it('completes work by positional ID with summary and artifacts', async () => {
    mockFetch()
      .on('POST', '/api/v1/work-items/work-001/complete')
      .body((body) => {
        const input = body as any;
        return input.claimOwner === 'codex-test'
          && input.claimToken === 'claim-token'
          && input.resultSummary === 'Tests passed'
          && Array.isArray(input.artifactRefs)
          && input.artifactRefs[0]?.path === 'packages/exf-cli/test/commands/agents-work.test.ts';
      })
      .reply(200, {
        workItem: {
          id: 'work-001',
          title: 'Run verification',
          status: 'done',
          resultSummary: 'Tests passed',
        },
      })
      .install();

    const result = await runCommand([
      'work',
      'complete',
      'work-001',
      '--owner',
      'codex-test',
      '--claim-token',
      'claim-token',
      '--summary',
      'Tests passed',
      '--artifacts',
      '[{"path":"packages/exf-cli/test/commands/agents-work.test.ts"}]',
      '--token',
      'sift_pat_test',
      '--json',
    ]);
    const json = JSON.parse(result.stdout);
    expect(json.workItem.id).toBe('work-001');
    expect(json.workItem.status).toBe('done');
    expect(json.workItem.resultSummary).toBe('Tests passed');
  });
});

describe('codex daily-review collect', () => {
  it('collects read-only Siftable sources and local git summary', async () => {
    mockFetch()
      .on('GET', '/api/v1/projects').query(true).reply(200, {projects: [fixtures.project()]})
      .on('GET', '/api/v1/agents').query(true).reply(200, {agents: [{alias: 'codex'}]})
      .on('GET', '/api/v1/work-items').query(true).reply(200, {workItems: []})
      .on('GET', '/api/v1/tasks').query(true).reply(200, {tasks: [fixtures.task()]})
      .on('GET', '/api/v1/tasks').query(true).reply(200, {tasks: []})
      .on('GET', '/api/v1/code/repositories').reply(200, {repositories: [fixtures.repository()]})
      .on('GET', '/api/v1/code/memories').query(true).reply(200, {memories: [fixtures.memory()], total: 1})
      .on('GET', '/api/v1/calendar/events').query(true).reply(200, {events: [fixtures.event()]})
      .on('GET', '/api/v1/vault/entries').query(true).reply(200, {entries: [fixtures.vaultEntry()]})
      .install();

    const result = await runCommand([
      'codex',
      'daily-review',
      'collect',
      '--token',
      'sift_pat_test',
      '--skip-git',
      '--json',
    ]);
    const json = JSON.parse(result.stdout);
    expect(json.coverage.unavailable).toEqual([]);
    expect(json.sources.projects.projects).toHaveLength(1);
    expect(json.sources.workItems.workItems).toEqual([]);
    expect(json.localGit.skipped).toBe(true);
  });
});

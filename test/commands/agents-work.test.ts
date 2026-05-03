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
          },
        ],
      })
      .install();

    const result = await runCommand(['work', 'list', '--token', 'sift_pat_test', '--json']);
    const json = JSON.parse(result.stdout);
    expect(json).toHaveLength(1);
    expect(json[0].title).toBe('Run verification');
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

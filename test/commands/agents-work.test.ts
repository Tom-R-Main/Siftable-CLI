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
    const predecessorId = '11111111-1111-4111-8111-111111111111';
    mockFetch()
      .on('POST', '/api/v1/work-items')
      .body((body) => {
        const input = body as any;
        return input.title === 'Implement Deploy v2'
          && input.taskId === 'task-001'
          && input.assignedAlias === 'codex'
          && Array.isArray(input.verificationCommands)
          && input.verificationCommands[0] === 'npm run build'
          && input.dependsOn?.[0]?.workItemId === predecessorId
          && input.dependsOn?.[0]?.requiredGate === 'verified';
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
      '--depends-on',
      `[{"workItemId":"${predecessorId}","requiredGate":"verified"}]`,
      '--token',
      'sift_pat_test',
      '--json',
    ]);

    const json = JSON.parse(result.stdout);
    expect(json.workItem.id).toBe('work-new');
    expect(json.workItem.taskId).toBe('task-001');
  });

  it('rejects non-UUID dependency references before calling the API', async () => {
    mockFetch().install();
    const result = await runCommand([
      'work',
      'create',
      '--title',
      'Unsafe dependency',
      '--depends-on',
      '[{"workItemId":"QUEUE-DEP-01"}]',
      '--token',
      'sift_pat_test',
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('workItemId must be a UUID');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends workspace context when creating executable work', async () => {
    mockFetch()
      .on('POST', '/api/v1/work-items')
      .body((body) => (body as any).title === 'Workspace work')
      .reply(201, {
        workItem: {
          id: 'work-workspace',
          title: 'Workspace work',
          status: 'queued',
        },
      })
      .install();

    await runCommand([
      'work',
      'create',
      '--workspace',
      'org-001',
      '--title',
      'Workspace work',
      '--token',
      'sift_pat_test',
      '--json',
    ]);

    expect((global.fetch as jest.Mock).mock.calls[0][1].headers['X-Workspace-Id']).toBe('org-001');
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

  it('sends workspace context when listing executable work', async () => {
    mockFetch()
      .on('GET', '/api/v1/work-items')
      .query(true)
      .reply(200, {workItems: []})
      .install();

    await runCommand(['work', 'list', '--workspace', 'org-001', '--token', 'sift_pat_test', '--json']);

    expect((global.fetch as jest.Mock).mock.calls[0][1].headers['X-Workspace-Id']).toBe('org-001');
  });

  it('explains workspace token mismatches clearly', async () => {
    mockFetch()
      .on('GET', '/api/v1/work-items')
      .query(true)
      .reply(403, {
        type: 'workspace_token_mismatch',
        title: 'Forbidden',
        detail: 'Workspace service token is bound to org-001 but the request used org-002.',
      })
      .install();

    const result = await runCommand(['work', 'list', '--workspace', 'org-002', '--token', 'sift_pat_test', '--json']);
    const json = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(json.error.message).toContain('Workspace mismatch');
    expect(json.error.code).toBe('workspace_token_mismatch');
    expect(json.error.suggestions.join(' ')).toContain('SIFT_WORKSPACE_ID');
  });

  it('explains missing work scopes clearly', async () => {
    mockFetch()
      .on('GET', '/api/v1/work-items')
      .query(true)
      .reply(403, {
        type: 'insufficient_pat_scope',
        title: 'Insufficient permissions',
        detail: 'This token is missing required scope work:read.',
        extra: {required: 'work:read', available: ['org:read']},
      })
      .install();

    const result = await runCommand(['work', 'list', '--workspace', 'org-001', '--token', 'sift_pat_test', '--json']);
    const json = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(json.error.message).toContain('Insufficient token scope');
    expect(json.error.code).toBe('insufficient_pat_scope');
    expect(json.error.suggestions.join(' ')).toContain('work:read/work:write');
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
          dependencies: [{
            predecessorId: '11111111-1111-4111-8111-111111111111',
            requiredGate: 'commands_passed',
            satisfied: false,
          }],
          claimability: {state: 'waiting', blockedBy: []},
        },
      })
      .install();

    const result = await runCommand(['work', 'get', 'work-001', '--token', 'sift_pat_test', '--json']);
    const json = JSON.parse(result.stdout);
    expect(json.claimToken).toBeUndefined();
    expect(json.dependencies[0].requiredGate).toBe('commands_passed');
    expect(json.claimability.state).toBe('waiting');
    expect(result.stdout).not.toContain('should-not-render');
  });

  it('reads authoritative dependencies and claimability', async () => {
    mockFetch()
      .on('GET', '/api/v1/work-items/22222222-2222-4222-8222-222222222222')
      .reply(200, {
        workItem: {
          id: '22222222-2222-4222-8222-222222222222',
          dependencies: [{
            predecessorId: '11111111-1111-4111-8111-111111111111',
            requiredGate: 'verified',
            satisfied: false,
          }],
          claimability: {state: 'waiting', blockedBy: []},
        },
      })
      .install();
    const result = await runCommand([
      'work', 'dependencies', 'get', '22222222-2222-4222-8222-222222222222',
      '--token', 'sift_pat_test', '--json',
    ]);
    const json = JSON.parse(result.stdout);
    expect(json.workItemId).toBe('22222222-2222-4222-8222-222222222222');
    expect(json.dependencies[0].requiredGate).toBe('verified');
    expect(json.claimability.state).toBe('waiting');
  });

  it('atomically replaces authoritative dependencies', async () => {
    const predecessorId = '11111111-1111-4111-8111-111111111111';
    mockFetch()
      .on('PUT', '/api/v1/work-items/22222222-2222-4222-8222-222222222222/dependencies')
      .body((body) => (body as any).dependsOn?.[0]?.workItemId === predecessorId
        && (body as any).dependsOn?.[0]?.requiredGate === 'done')
      .reply(200, {workItem: {id: '22222222-2222-4222-8222-222222222222'}})
      .install();
    const result = await runCommand([
      'work', 'dependencies', 'set', '22222222-2222-4222-8222-222222222222',
      '--depends-on', `[{"workItemId":"${predecessorId}","requiredGate":"done"}]`,
      '--token', 'sift_pat_test', '--json',
    ]);
    expect(JSON.parse(result.stdout).workItem.id).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('gets and updates the project dependency policy', async () => {
    const projectId = '33333333-3333-4333-8333-333333333333';
    mockFetch()
      .on('GET', `/api/v1/projects/${projectId}/work-dependency-policy`)
      .reply(200, {defaultRequiredGate: 'commands_passed'})
      .on('PUT', `/api/v1/projects/${projectId}/work-dependency-policy`)
      .body((body) => (body as any).defaultRequiredGate === 'verified')
      .reply(200, {defaultRequiredGate: 'verified'})
      .install();
    const read = await runCommand([
      'work', 'dependency-policy', 'get', '--project', projectId,
      '--token', 'sift_pat_test', '--json',
    ]);
    expect(JSON.parse(read.stdout).defaultRequiredGate).toBe('commands_passed');
    const update = await runCommand([
      'work', 'dependency-policy', 'set', '--project', projectId, '--gate', 'verified',
      '--token', 'sift_pat_test', '--json',
    ]);
    expect(JSON.parse(update.stdout).defaultRequiredGate).toBe('verified');
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

  it('submits verification command evidence on completion', async () => {
    mockFetch()
      .on('POST', '/api/v1/work-items/work-001/complete')
      .body((body) => {
        const input = body as any;
        return Array.isArray(input.verificationResults)
          && input.verificationResults[0]?.command === 'npm test'
          && input.verificationResults[0]?.exitCode === 0;
      })
      .reply(200, {
        workItem: {
          id: 'work-001',
          title: 'Run verification',
          status: 'done',
          verificationState: 'commands_passed',
        },
      })
      .install();

    const result = await runCommand([
      'work',
      'complete',
      'work-001',
      '--verification-results',
      '[{"command":"npm test","exitCode":0}]',
      '--token',
      'sift_pat_test',
      '--json',
    ]);
    const json = JSON.parse(result.stdout);
    expect(json.workItem.verificationState).toBe('commands_passed');
  });

  it('runs verification with an explicit hosted model override', async () => {
    mockFetch()
      .on('POST', '/api/v1/work-items/work-001/verify')
      .body((body) => (body as any).repetitions === 2 && (body as any).model === 'provider/verifier-model')
      .reply(200, {
        run: {
          id: 'run-001',
          verdict: 'verified',
          aggregateScore: 0.91,
          verifierModel: 'provider/verifier-model',
          repetitions: 2,
          rationale: 'All criteria passed.',
          criterionScores: [
            {criterionText: 'Tests pass', score: 0.94, uncertainty: 0.01, passed: true},
          ],
        },
      })
      .install();

    const result = await runCommand([
      'work',
      'verify',
      'work-001',
      '--reps',
      '2',
      '--model',
      'provider/verifier-model',
      '--token',
      'sift_pat_test',
      '--json',
    ]);
    const json = JSON.parse(result.stdout);
    expect(json.verdict).toBe('verified');
    expect(json.criterionScores[0].criterionText).toBe('Tests pass');
  });

  it('defers model selection to server policy when no override is provided', async () => {
    mockFetch()
      .on('POST', '/api/v1/work-items/work-001/verify')
      .body((body) => !Object.prototype.hasOwnProperty.call(body, 'model'))
      .reply(200, {
        run: {
          id: 'run-002',
          verdict: 'needs_review',
          aggregateScore: 0.65,
          verifierModel: 'server-policy-model',
          repetitions: 3,
          criterionScores: [],
        },
      })
      .install();

    const result = await runCommand([
      'work',
      'verify',
      'work-001',
      '--token',
      'sift_pat_test',
      '--json',
    ]);
    const json = JSON.parse(result.stdout);
    expect(json.verifierModel).toBe('server-policy-model');
  });

  it('lists verifier run history for a work item', async () => {
    mockFetch()
      .on('GET', '/api/v1/work-items/work-001/verifier-runs')
      .reply(200, {
        runs: [
          {
            id: 'run-001',
            createdAt: '2026-07-08T12:00:00.000Z',
            verdict: 'needs_review',
            aggregateScore: 0.63,
            verifierModel: 'server-policy-model',
            repetitions: 3,
            criterionScores: [],
          },
        ],
      })
      .install();

    const result = await runCommand([
      'work',
      'verify',
      'work-001',
      '--history',
      '--token',
      'sift_pat_test',
      '--json',
    ]);
    const json = JSON.parse(result.stdout);
    expect(json).toHaveLength(1);
    expect(json[0].verdict).toBe('needs_review');
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

describe('worker run command', () => {
  it('claims, starts, runs, heartbeats, and marks work as needing review', async () => {
    const transitions: string[] = [];
    mockFetch()
      .on('POST', '/api/v1/work-items/claim')
      .body((body) => {
        const input = body as any;
        return input.assignedAlias === 'codex'
          && input.claimOwner === 'codex@test'
          && input.leaseSeconds === 60;
      })
      .reply(200, {
        workItem: {
          id: 'work-run',
          title: 'Run worker',
          status: 'claimed',
          claimToken: 'claim-token',
          inputContext: {cwd: process.cwd()},
        },
      })
      .on('POST', '/api/v1/work-items/work-run/start')
      .body((body) => {
        transitions.push('start');
        return (body as any).claimToken === 'claim-token';
      })
      .reply(200, {workItem: {id: 'work-run', status: 'running'}})
      .on('POST', '/api/v1/work-items/work-run/heartbeat')
      .body((body) => {
        transitions.push('heartbeat');
        return (body as any).claimToken === 'claim-token';
      })
      .reply(200, {workItem: {id: 'work-run', status: 'running'}})
      .on('POST', '/api/v1/work-items/work-run/review')
      .body((body) => {
        const input = body as any;
        transitions.push('review');
        return input.claimToken === 'claim-token'
          && input.resultSummary.includes('Exit code: 0')
          && input.artifactRefs[0]?.type === 'worker_run';
      })
      .reply(200, {workItem: {id: 'work-run', status: 'needs_review'}})
      .install();

    const result = await runCommand([
      'worker',
      'run',
      '--agent',
      'codex',
      '--owner',
      'codex@test',
      '--command',
      'printf worker-ok',
      '--lease',
      '60',
      '--token',
      'sift_pat_test',
      '--json',
    ]);
    const json = JSON.parse(result.stdout);

    expect(transitions).toEqual(['start', 'heartbeat', 'review']);
    expect(json.workItem.status).toBe('needs_review');
    expect(json.command.exitCode).toBe(0);
  });
});

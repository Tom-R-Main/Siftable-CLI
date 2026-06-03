import {runInteractiveCommand, commandSuggestions, type CommandMessage, type InteractiveCommandContext} from '../../interactive-tui/commands';
import {collectDailyReviewContext} from '../../src/lib/daily-review-context';

function response(data: unknown) {
  return Promise.resolve({statusCode: 200, data});
}

function buildContext(overrides: Partial<InteractiveCommandContext> = {}) {
  const messages: CommandMessage[] = [];
  const createdWork: unknown[] = [];
  const apiClient = {
    listProjects: jest.fn(() => response({projects: []})),
    listAgents: jest.fn(() => response({agents: [{alias: 'codex', status: 'active'}]})),
    listWorkItems: jest.fn(() => response({workItems: [
      {id: 'work-1', title: 'Fix composer', status: 'queued', assignedAlias: {alias: 'codex'}, queueRank: 10},
      {id: 'work-2', title: 'Review proof', status: 'needs_review', assignedAlias: {alias: 'claude-code'}, claimOwner: 'claude@tty1'},
    ]})),
    listTasks: jest.fn((input: Record<string, unknown>) => response({
      tasks: input.status === 'in_progress'
        ? [{id: 'task-1', title: 'Ship interactive commands'}]
        : [{id: 'task-2', title: 'Plan recap'}],
    })),
    listCodeRepositories: jest.fn(() => response({repositories: [{id: 'repo-1', rootPath: '/repo'}]})),
    listCodeMemories: jest.fn(() => response({memories: [{id: 'mem-1', content: 'Use work queue'}]})),
    listCalendarEvents: jest.fn(() => response({events: [{id: 'event-1', title: 'Demo'}]})),
    listVaultEntries: jest.fn(() => response({entries: []})),
    createWorkItem: jest.fn((payload: unknown) => {
      createdWork.push(payload);
      return response({workItem: {id: 'work-new', title: (payload as Record<string, unknown>).title}});
    }),
    searchCode: jest.fn(() => response({results: []})),
    storeCodeMemory: jest.fn(() => response({id: 'mem-new'})),
  };
  const ctx: InteractiveCommandContext = {
    client: {
      state: jest.fn(),
      config: jest.fn(async (input) => ({provider: input.provider ?? 'openrouter', model: input.model ?? 'model'})),
      login: jest.fn(async () => ({verificationUri: 'https://example.test', userCode: 'ABCD'})),
      send: jest.fn(),
    },
    apiClient: apiClient as any,
    baseUrl: 'in-process (test)',
    model: () => 'google/gemini-3.5-flash',
    setModel: jest.fn(),
    agents: () => [{workspaceId: 'ws-1', workItemId: null, taskId: null, agentType: 'codex', state: 'idle', assignedAlias: 'codex'}],
    queuedCount: () => 2,
    cwd: () => '/repo',
    setCwd: jest.fn(),
    workspaceRoot: () => '/repo',
    push: (message) => messages.push(message),
    setMessages: (next) => {
      messages.splice(0, messages.length, ...next);
    },
    quit: jest.fn(),
    latestAssistantText: () => 'latest answer',
    conversationText: () => 'you: please hand this off\nsiftable: ok',
    copyText: jest.fn(async (text) => `copied ${text.length} chars.`),
    setAwaitingLogin: jest.fn(),
    ...overrides,
  };
  return {ctx, apiClient, messages, createdWork};
}

describe('interactive command registry', () => {
  it('exposes command suggestions from registry metadata', () => {
    expect(commandSuggestions().map((command) => command.name)).toEqual(expect.arrayContaining([
      'help',
      'status',
      'copy',
      'queue',
      'handoff',
      'focus',
      'proof',
      'remember',
      'ship',
      'recap',
    ]));
  });

  it('runs core commands through a context object', async () => {
    const {ctx, messages} = buildContext();

    await runInteractiveCommand(ctx, '/status');
    expect(messages.at(-1)?.text).toContain('google/gemini-3.5-flash');
    expect(messages.at(-1)?.text).toContain('queued:  2');

    await runInteractiveCommand(ctx, '/copy all');
    expect(messages.at(-1)?.text).toBe('copied 38 chars.');
  });

  it('reports the real read/write boundary in /status', async () => {
    const {ctx, messages} = buildContext();

    await runInteractiveCommand(ctx, '/status');
    const text = messages.at(-1)?.text ?? '';
    expect(text).toContain('workdir: /repo');
    expect(text).toContain('read:    repo + machine-wide, read-only');
    expect(text).toContain('write:   /repo (approval-gated)');
  });

  it('shows write as disabled when there is no workspace root', async () => {
    const {ctx, messages} = buildContext({workspaceRoot: () => ''});

    await runInteractiveCommand(ctx, '/status');
    expect(messages.at(-1)?.text).toContain('write:   disabled (no workspace root)');
  });

  it('shows the workdir on /cwd and changes it via setCwd', async () => {
    const setCwd = jest.fn();
    const {ctx, messages} = buildContext({setCwd});

    await runInteractiveCommand(ctx, '/cwd');
    expect(messages.at(-1)?.text).toBe('workdir: /repo');

    await runInteractiveCommand(ctx, '/cwd packages/exf-cli');
    expect(setCwd).toHaveBeenCalledWith('packages/exf-cli');
  });

  it('surfaces a /cwd failure without throwing', async () => {
    const setCwd = jest.fn(() => {
      throw new Error('not a directory: /nope');
    });
    const {ctx, messages} = buildContext({setCwd});

    await runInteractiveCommand(ctx, '/cwd /nope');
    expect(messages.at(-1)?.text).toContain('not a directory: /nope');
  });

  it('renders the agent queue board from work and agent APIs', async () => {
    const {ctx, messages, apiClient} = buildContext();

    await runInteractiveCommand(ctx, '/queue');

    expect(apiClient.listAgents).toHaveBeenCalledWith({includeDisabled: true});
    expect(apiClient.listWorkItems).toHaveBeenCalledWith({limit: 50});
    expect(messages.at(-1)?.text).toContain('Agents');
    expect(messages.at(-1)?.text).toContain('needs_review');
    expect(messages.at(-1)?.text).toContain('Review proof');
  });

  it('creates handoff work items from transcript, cwd, and explicit args', async () => {
    const {ctx, messages, createdWork} = buildContext();

    await runInteractiveCommand(ctx, '/handoff Fix composer wrapping --agent codex --files=packages/exf-cli/interactive-tui/index.tsx --acceptance=wraps;tests-pass --verify=npm-test');

    expect(createdWork).toHaveLength(1);
    expect(createdWork[0]).toMatchObject({
      title: 'Fix composer wrapping',
      assignedAlias: 'codex',
      inputContext: {
        cwd: '/repo',
        files: ['packages/exf-cli/interactive-tui/index.tsx'],
      },
      acceptanceCriteria: [{text: 'wraps', met: false}, {text: 'tests-pass', met: false}],
      verificationCommands: ['npm-test'],
    });
    expect(messages.at(-1)?.text).toContain('Work item created: work-new');
  });

  it('builds focus output from the reusable daily context collector', async () => {
    const {ctx, messages} = buildContext();

    await runInteractiveCommand(ctx, '/focus');

    expect(messages.at(-1)?.text).toContain('Focus');
    expect(messages.at(-1)?.text).toContain('Review agent work');
    expect(messages.at(-1)?.text).toContain('Ship interactive commands');
  });

  it('requires an explicit remember category before storing code memory', async () => {
    const {ctx, messages, apiClient} = buildContext();

    await runInteractiveCommand(ctx, '/remember This repo uses explicit work leases');
    expect(messages.at(-1)?.text).toContain('usage: /remember');
    expect(apiClient.storeCodeMemory).not.toHaveBeenCalled();

    await runInteractiveCommand(ctx, '/remember This repo uses explicit work leases --category architecture');
    expect(apiClient.storeCodeMemory).toHaveBeenCalledWith({
      fact: 'This repo uses explicit work leases',
      category: 'architecture',
    });
    expect(messages.at(-1)?.text).toContain('Remembered');
  });
});

describe('daily review context library', () => {
  it('keeps the read-only source collection contract reusable', async () => {
    const {apiClient} = buildContext();

    const context = await collectDailyReviewContext(apiClient as any, {
      skipGit: true,
      now: new Date('2026-06-03T12:00:00Z'),
    });

    expect(context.coverage.checked).toEqual([
      'projects',
      'agents',
      'workItems',
      'tasksInProgress',
      'tasksOpenPhase',
      'codeRepositories',
      'codeMemories',
      'calendar',
      'vaultMetadata',
    ]);
    expect(context.localGit.skipped).toBe(true);
    expect((context.sources.workItems as any).workItems).toHaveLength(2);
  });
});

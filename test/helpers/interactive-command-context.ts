/**
 * Shared test context for the interactive slash-command registry. Builds an
 * InteractiveCommandContext backed by jest mocks so command handlers can be
 * dispatched without a live brain, API client, or TUI. Used by the per-command
 * behavior tests and by the registry coverage gate.
 */
import type {CommandMessage, InteractiveCommandContext} from '../../interactive-tui/commands';

export function response(data: unknown) {
  return Promise.resolve({statusCode: 200, data});
}

export function buildCommandContext(overrides: Partial<InteractiveCommandContext> = {}) {
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
    readVaultSecret: jest.fn(() => response({payload: {key: 'sk-test'}})),
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

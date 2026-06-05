import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {ControlTransport, SseEvent} from '../../interactive-tui/controlClient';
import {
  commandSuggestions,
  runInteractiveCommand,
  type CommandMessage,
  type InteractiveCommandContext,
} from '../../interactive-tui/commands';
import {listCollabSessions, resetCollabEngineForTests} from '../../interactive-tui/collabEngine';

describe('interactive crew commands', () => {
  const previousNoNative = process.env.SIFT_NO_NATIVE;
  const previousHome = process.env.HOME;
  let root: string;
  let home: string;

  function buildCtx() {
    const messages: CommandMessage[] = [];
    const send = jest.fn(async (input: string, onEvent: (event: SseEvent) => void) => {
      onEvent({type: 'text', text: `done: ${input.match(/Task ([a-z-]+):/)?.[1] ?? 'task'}`});
      onEvent({type: 'done', result: {text: 'fallback'}});
    });
    const ctx = {
      client: {send} as unknown as ControlTransport,
      apiClient: {} as any,
      baseUrl: 'in-process (test)',
      model: () => 'test-model',
      setModel: jest.fn(),
      agents: () => [],
      queuedCount: () => 0,
      cwd: () => path.join(root, 'pkg'),
      setCwd: jest.fn(),
      workspaceRoot: () => root,
      push: (m: CommandMessage) => messages.push(m),
      setMessages: jest.fn(),
      quit: jest.fn(),
      latestAssistantText: () => '',
      conversationText: () => '',
      copyText: jest.fn(async () => ''),
      setAwaitingLogin: jest.fn(),
    } as unknown as InteractiveCommandContext;
    return {ctx, messages, send};
  }

  beforeEach(() => {
    process.env.SIFT_NO_NATIVE = '1';
    root = mkdtempSync(path.join(tmpdir(), 'sift-crew-root-'));
    home = mkdtempSync(path.join(tmpdir(), 'sift-crew-home-'));
    process.env.HOME = home;
    resetCollabEngineForTests();
  });

  afterEach(() => {
    resetCollabEngineForTests();
    rmSync(root, {recursive: true, force: true});
    rmSync(home, {recursive: true, force: true});
    if (previousNoNative === undefined) delete process.env.SIFT_NO_NATIVE;
    else process.env.SIFT_NO_NATIVE = previousNoNative;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  it('lists built-in crews and exposes the crew command in suggestions', async () => {
    expect(commandSuggestions().some((command) => command.name === 'crew')).toBe(true);
    const {ctx, messages} = buildCtx();

    await runInteractiveCommand(ctx, '/crew list');

    expect(messages.at(-1)?.text).toContain('repo-investigation');
    expect(messages.at(-1)?.text).toContain('Run:    /crew run <id> <request>');
  });

  it('creates and inspects a named project crew from a template', async () => {
    const {ctx, messages} = buildCtx();

    await runInteractiveCommand(ctx, '/crew new audit-team --scope project --template repo-investigation --name "Audit Team"');
    await runInteractiveCommand(ctx, '/crew show audit-team');

    expect(messages[messages.length - 2]?.text).toContain('Created crew audit-team');
    expect(messages.at(-1)?.text).toContain('Audit Team (audit-team)');
    expect(messages.at(-1)?.text).toContain('scope:   project');
    expect(messages.at(-1)?.text).toContain(path.join(root, '.siftable/crews/audit-team.json'));
  });

  it('runs a configured crew through the collab substrate', async () => {
    const {ctx, messages, send} = buildCtx();

    await runInteractiveCommand(ctx, '/crew new audit-team --scope project --template repo-investigation --name "Audit Team"');
    await runInteractiveCommand(ctx, '/crew run audit-team trace traversal');

    expect(send).toHaveBeenCalledTimes(3);
    expect(messages.at(-1)?.text).toContain('Crew audit-team');
    expect(messages.at(-1)?.text).toContain('map:completed');
    expect(messages.at(-1)?.text).toContain('verify:completed');
    expect(messages.at(-1)?.text).toContain('summarize:completed');

    const sessions = listCollabSessions({limit: 5});
    expect(sessions).toHaveLength(1);
    expect(sessions[0].branches.map((branch) => branch.worker)).toEqual([
      'crew:audit-team:map',
      'crew:audit-team:verify',
      'crew:audit-team:summarize',
    ]);
  });
});

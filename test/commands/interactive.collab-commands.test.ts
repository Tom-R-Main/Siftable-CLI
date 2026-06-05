import type {ControlTransport} from '../../interactive-tui/controlClient';
import {
  commandSuggestions,
  runInteractiveCommand,
  type CommandMessage,
  type InteractiveCommandContext,
} from '../../interactive-tui/commands';
import {createCollabSession, enqueueCollabBranch, resetCollabEngineForTests} from '../../interactive-tui/collabEngine';

describe('interactive collab commands', () => {
  const previousNoNative = process.env.SIFT_NO_NATIVE;
  const previousCrewDebug = process.env.SIFT_CREW_DEBUG;

  function buildCtx() {
    const messages: CommandMessage[] = [];
    const ctx = {
      client: {} as ControlTransport,
      apiClient: {} as any,
      baseUrl: 'in-process (test)',
      model: () => 'test-model',
      setModel: jest.fn(),
      agents: () => [],
      queuedCount: () => 0,
      cwd: () => '/repo/pkg',
      setCwd: jest.fn(),
      workspaceRoot: () => '/repo',
      push: (m: CommandMessage) => messages.push(m),
      setMessages: jest.fn(),
      quit: jest.fn(),
      latestAssistantText: () => '',
      conversationText: () => '',
      copyText: jest.fn(async () => ''),
      setAwaitingLogin: jest.fn(),
    } as unknown as InteractiveCommandContext;
    return {ctx, messages};
  }

  beforeEach(() => {
    process.env.SIFT_NO_NATIVE = '1';
    delete process.env.SIFT_CREW_DEBUG;
    resetCollabEngineForTests();
  });

  afterEach(() => {
    resetCollabEngineForTests();
    if (previousNoNative === undefined) delete process.env.SIFT_NO_NATIVE;
    else process.env.SIFT_NO_NATIVE = previousNoNative;
    if (previousCrewDebug === undefined) delete process.env.SIFT_CREW_DEBUG;
    else process.env.SIFT_CREW_DEBUG = previousCrewDebug;
  });

  it('shows no sessions before collab work has run', async () => {
    const {ctx, messages} = buildCtx();
    await runInteractiveCommand(ctx, '/collab');
    expect(messages.at(-1)?.text).toContain('No in-process collab sessions yet');
  });

  it('renders recent collab sessions read-only', async () => {
    const sessionId = createCollabSession({root: '/repo', cwd: '/repo/pkg', maxBranches: 2});
    enqueueCollabBranch(sessionId, {role: 'Mapper', focus: 'Map files'});
    const {ctx, messages} = buildCtx();

    await runInteractiveCommand(ctx, '/collab');

    expect(messages.at(-1)?.text).toContain(`session #${sessionId}`);
    expect(messages.at(-1)?.text).toContain('root /repo');
    expect(messages.at(-1)?.text).toContain('Mapper');
    expect(messages.at(-1)?.text).toContain('pending');
  });

  it('hides crew smoke from suggestions but allows forced deterministic smoke', async () => {
    expect(commandSuggestions().some((command) => command.name === 'crew-smoke')).toBe(false);
    const {ctx, messages} = buildCtx();

    await runInteractiveCommand(ctx, '/crew-smoke');
    expect(messages.at(-1)?.text).toContain('Set SIFT_CREW_DEBUG=1');

    await runInteractiveCommand(ctx, '/crew-smoke --force');
    expect(messages.at(-1)?.text).toContain('Crew smoke');
    expect(messages.at(-1)?.text).toContain('map:completed');
    expect(messages.at(-1)?.text).toContain('check:completed');

    await runInteractiveCommand(ctx, '/collab');
    expect(messages.at(-1)?.text).toContain('crew:ui_smoke:map');
    expect(messages.at(-1)?.text).toContain('crew:ui_smoke:check');
  });
});

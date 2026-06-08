import {
  mapCodexNotification,
  codexApprovalResponse,
  buildApprovalRequest,
} from '../../interactive-tui/codexEngine';
import {LocalControlClient} from '../../interactive-tui/localControlClient';
import {
  applyModelChoice,
  findModelChoice,
  runInteractiveCommand,
  INTERACTIVE_MODEL_CHOICES,
  type CommandMessage,
  type InteractiveCommandContext,
} from '../../interactive-tui/commands';
import type {ControlTransport} from '../../interactive-tui/controlClient';

describe('mapCodexNotification (Codex app-server → BrainEvent)', () => {
  it('maps an agent message delta to a streamed token', () => {
    expect(mapCodexNotification('item/agentMessage/delta', {delta: 'hi'})).toEqual({type: 'token', content: 'hi'});
  });

  it('maps tool-bearing item lifecycle to tool_call / tool_result', () => {
    const started = mapCodexNotification('item/started', {item: {type: 'commandExecution', id: '1'}});
    expect(started).toEqual({type: 'tool_call', toolCall: {name: 'shell'}});

    const okResult = mapCodexNotification('item/completed', {item: {type: 'webSearch', id: '2'}});
    expect(okResult).toEqual({type: 'tool_result', toolResult: {name: 'web_search', success: true}});

    const failResult = mapCodexNotification('item/completed', {item: {type: 'commandExecution', id: '3', exitCode: 1}});
    expect(failResult).toEqual({type: 'tool_result', toolResult: {name: 'shell', success: false}});
  });

  it('surfaces the command on the call and its output on completion', () => {
    const started = mapCodexNotification('item/started', {
      item: {type: 'commandExecution', id: '1', command: 'npx tsc --noEmit'},
    });
    expect(started).toEqual({type: 'tool_call', toolCall: {name: 'shell', detail: 'npx tsc --noEmit'}});

    const completed = mapCodexNotification('item/completed', {
      item: {type: 'commandExecution', id: '1', command: 'npx tsc --noEmit', exitCode: 0, aggregatedOutput: 'no errors\n'},
    });
    expect(completed).toEqual({
      type: 'tool_result',
      toolResult: {name: 'shell', success: true, output: 'no errors\n'},
    });
  });

  it('surfaces the search query as the call detail', () => {
    const started = mapCodexNotification('item/started', {
      item: {type: 'webSearch', id: '2', query: 'zig atomic file write'},
    });
    expect(started).toEqual({type: 'tool_call', toolCall: {name: 'web_search', detail: 'zig atomic file write'}});
  });

  it('omits detail/output when the item has none (no empty keys)', () => {
    expect(mapCodexNotification('item/started', {item: {type: 'commandExecution', id: '3'}})).toEqual({
      type: 'tool_call',
      toolCall: {name: 'shell'},
    });
    expect(
      mapCodexNotification('item/completed', {item: {type: 'commandExecution', id: '3', exitCode: 0, aggregatedOutput: '   '}}),
    ).toEqual({type: 'tool_result', toolResult: {name: 'shell', success: true}});
  });

  it('does not surface conversational items (agentMessage / reasoning) as tools', () => {
    expect(mapCodexNotification('item/started', {item: {type: 'agentMessage', id: '1'}})).toBeNull();
    expect(mapCodexNotification('item/completed', {item: {type: 'reasoning', id: '1'}})).toBeNull();
  });

  it('surfaces only terminal errors, not retryable ones', () => {
    expect(mapCodexNotification('error', {error: {message: 'boom'}, willRetry: false})).toEqual({type: 'error', error: 'boom'});
    expect(mapCodexNotification('error', {error: {message: 'transient'}, willRetry: true})).toBeNull();
  });

  it('ignores lifecycle chatter the copilot does not render', () => {
    expect(mapCodexNotification('turn/started', {})).toBeNull();
    expect(mapCodexNotification('thread/tokenUsage/updated', {})).toBeNull();
  });
});

describe('codex approval mapping (4-way decision → JSON-RPC)', () => {
  it('maps v2 command/fileChange decisions', () => {
    const m = 'item/commandExecution/requestApproval';
    expect(codexApprovalResponse(m, 'deny')).toEqual({decision: 'decline'});
    expect(codexApprovalResponse(m, 'allow')).toEqual({decision: 'accept'});
    expect(codexApprovalResponse(m, 'always')).toEqual({decision: 'acceptForSession'});
    // bypass responds like allow at the wire level (session policy flip is elsewhere).
    expect(codexApprovalResponse(m, 'bypass')).toEqual({decision: 'accept'});
    expect(codexApprovalResponse('item/fileChange/requestApproval', 'always')).toEqual({decision: 'acceptForSession'});
  });

  it('maps v1 ReviewDecision casing for exec/applyPatch', () => {
    expect(codexApprovalResponse('execCommandApproval', 'deny')).toEqual({decision: 'denied'});
    expect(codexApprovalResponse('execCommandApproval', 'allow')).toEqual({decision: 'approved'});
    expect(codexApprovalResponse('applyPatchApproval', 'always')).toEqual({decision: 'approved_for_session'});
  });

  it('normalizes command approval params for display', () => {
    const req = buildApprovalRequest('item/commandExecution/requestApproval', {
      command: 'rm -rf build',
      cwd: '/repo',
      reason: 'writes outside workspace',
    });
    expect(req).toEqual({
      method: 'item/commandExecution/requestApproval',
      kind: 'command',
      target: 'rm -rf build',
      detail: 'writes outside workspace',
    });
  });

  it('normalizes file-change approval params to the first changed path', () => {
    const req = buildApprovalRequest('item/fileChange/requestApproval', {
      changes: [{path: '/repo/a.ts'}, {path: '/repo/b.ts'}],
    });
    expect(req.kind).toBe('edit');
    expect(req.target).toBe('/repo/a.ts');
    expect(req.detail).toBe('2 files');
  });
});

describe('LocalControlClient — Codex engine', () => {
  it('gates auth on the Codex account when Codex is the active engine', async () => {
    const authed = new LocalControlClient({
      getModel: () => ({provider: 'codex', model: 'gpt-5.5'}),
      getCodexAccount: async () => ({type: 'chatgpt', email: 'tom@execufunction.com', planType: 'plus'}),
      getToken: () => undefined, // no Siftable token, but Codex is signed in
    });
    const s = await authed.state();
    expect(s.authStatus).toBe('authenticated');
    expect(s.available).toBe(true);
    expect(s.model?.provider).toBe('codex');

    const loggedOut = new LocalControlClient({
      getModel: () => ({provider: 'codex', model: 'gpt-5.5'}),
      getCodexAccount: async () => null,
      getToken: () => 'sift_pat_x', // Siftable token present but Codex is not
    });
    const s2 = await loggedOut.state();
    expect(s2.authStatus).toBe('unauthenticated');
  });

  it('keeps Siftable-token auth for non-Codex engines', async () => {
    const client = new LocalControlClient({
      getModel: () => ({provider: 'openrouter', model: 'google/gemini-3.5-flash'}),
      getToken: () => 'sift_pat_x',
      getCodexAccount: async () => null,
    });
    const s = await client.state();
    expect(s.authStatus).toBe('authenticated');
  });

  it('reports codexStatus with account and active flag', async () => {
    const client = new LocalControlClient({
      getModel: () => ({provider: 'codex', model: 'gpt-5.5'}),
      getCodexAccount: async () => ({type: 'chatgpt', email: 'tom@execufunction.com', planType: 'plus'}),
    });
    const status = await client.codexStatus();
    expect(status.active).toBe(true);
    expect(status.account?.email).toBe('tom@execufunction.com');
    expect(status.model).toBe('gpt-5.5');
  });

  it('codexSetActive switches the brain provider on and off', async () => {
    const setModel = jest.fn((input: {provider?: string; model?: string}) => ({
      provider: input.provider ?? 'openrouter',
      model: input.model ?? 'google/gemini-3.5-flash',
    }));
    const client = new LocalControlClient({setModel});

    const on = await client.codexSetActive(true);
    expect(setModel).toHaveBeenCalledWith({provider: 'codex', model: 'gpt-5.5'});
    expect(on.provider).toBe('codex');

    const off = await client.codexSetActive(false);
    expect(off.provider).toBe('openrouter');
  });
});

describe('/codex command', () => {
  function buildCtx(client: Partial<ControlTransport>) {
    const messages: CommandMessage[] = [];
    const ctx = {
      client: client as ControlTransport,
      apiClient: {} as any,
      baseUrl: 'in-process (test)',
      model: () => 'gpt-5.5',
      setModel: jest.fn(),
      agents: () => [],
      queuedCount: () => 0,
      cwd: () => '/repo',
      push: (m: CommandMessage) => messages.push(m),
      setMessages: () => {},
      quit: jest.fn(),
      latestAssistantText: () => '',
      conversationText: () => '',
      copyText: jest.fn(async () => ''),
      setAwaitingLogin: jest.fn(),
    } as unknown as InteractiveCommandContext;
    return {ctx, messages};
  }

  it('shows status with the signed-in account', async () => {
    const {ctx, messages} = buildCtx({
      codexStatus: async () => ({installed: true, account: {type: 'chatgpt', email: 'tom@x.io', planType: 'plus'}, active: true, model: 'gpt-5.5'}),
      codexLogin: async () => ({verificationUri: 'u', userCode: 'c'}),
    });
    await runInteractiveCommand(ctx, '/codex status');
    expect(messages.at(-1)?.text).toContain('signed in as tom@x.io');
    expect(messages.at(-1)?.text).toContain('active');
  });

  it('activates the engine via the unified model-selection path on /codex on', async () => {
    const {ctx, messages} = buildCtx({
      codexStatus: async () => ({installed: true, account: {type: 'chatgpt', email: 'tom@x.io'}, active: false, model: 'gpt-5.5'}),
      codexLogin: async () => ({verificationUri: 'u', userCode: 'c'}),
      config: async (input) => ({provider: input.provider ?? 'codex', model: input.model ?? 'gpt-5.5'}),
    });
    await runInteractiveCommand(ctx, '/codex on');
    // Goes through applyModelChoice → client.config, same as picking it in /model.
    expect(ctx.setModel).toHaveBeenCalledWith('gpt-5.5');
    expect(messages.at(-1)?.text).toContain('codex/gpt-5.5');
    expect(messages.at(-1)?.text).toContain('signed in as tom@x.io');
  });

  it('falls back gracefully when Codex ops are unavailable (daemon mode)', async () => {
    const {ctx, messages} = buildCtx({}); // no codex* methods
    await runInteractiveCommand(ctx, '/codex');
    expect(messages.at(-1)?.text).toContain('only available in local mode');
  });
});

describe('model catalog + reasoning effort', () => {
  function buildCtx(client: Partial<ControlTransport>) {
    const messages: CommandMessage[] = [];
    const ctx = {
      client: client as ControlTransport,
      apiClient: {} as any,
      baseUrl: 'in-process (test)',
      model: () => 'gpt-5.5',
      setModel: jest.fn(),
      agents: () => [],
      queuedCount: () => 0,
      cwd: () => '/repo',
      push: (m: CommandMessage) => messages.push(m),
      setMessages: () => {},
      quit: jest.fn(),
      latestAssistantText: () => '',
      conversationText: () => '',
      copyText: jest.fn(async () => ''),
      setAwaitingLogin: jest.fn(),
    } as unknown as InteractiveCommandContext;
    return {ctx, messages};
  }

  it('catalogued models with reasoning efforts keep a coherent default (apply-only models may omit them)', () => {
    for (const choice of INTERACTIVE_MODEL_CHOICES) {
      // Apply-only models (e.g. Morph fast-apply) have no reasoning axis, so the
      // picker confirms on Enter with no effort step — omitting the list is valid.
      if (choice.reasoningEfforts === undefined) {
        expect(choice.defaultEffort).toBeUndefined();
        continue;
      }
      expect(choice.reasoningEfforts.length).toBeGreaterThan(0);
      if (choice.defaultEffort) {
        expect(choice.reasoningEfforts).toContain(choice.defaultEffort);
      }
    }
  });

  it('resolves both Opus doors by alias', () => {
    // Door A — via OpenRouter.
    expect(findModelChoice('opus')?.provider).toBe('openrouter');
    // Door B — direct Anthropic API (/claude-api).
    const direct = findModelChoice('claude-api');
    expect(direct?.provider).toBe('anthropic');
    expect(direct?.auth).toBe('anthropic');
  });

  it('catalogues cheap scout models across OpenRouter and first-party providers', () => {
    expect(findModelChoice('haiku')?.model).toBe('anthropic/claude-haiku-4.5');
    expect(findModelChoice('haiku-direct')?.provider).toBe('anthropic');
    expect(findModelChoice('flash-lite')?.model).toBe('google/gemini-3.1-flash-lite');
    expect(findModelChoice('gemini-direct')?.provider).toBe('gemini');
    expect(findModelChoice('gpt-5.4-mini')?.model).toBe('openai/gpt-5.4-mini');
    expect(findModelChoice('openai-mini')?.provider).toBe('openai');
    expect(findModelChoice('nano')?.model).toBe('openai/gpt-5.4-nano');
  });

  it('forwards the chosen reasoning effort to config and reports it', async () => {
    const config = jest.fn(async (input: {provider?: string; model?: string; effort?: string}) => ({
      provider: input.provider ?? 'openrouter',
      model: input.model ?? 'x',
      effort: input.effort,
    }));
    const {ctx, messages} = buildCtx({config});
    const gptMini = findModelChoice('gpt-5.4-mini')!;
    await applyModelChoice(ctx, gptMini, 'high');
    expect(config).toHaveBeenCalledWith({provider: 'openrouter', model: 'openai/gpt-5.4-mini', effort: 'high'});
    expect(messages.at(-1)?.text).toContain('reasoning high');
  });

  it('routes ad-hoc OpenRouter model ids through OpenRouter by default', async () => {
    const config = jest.fn(async (input: {provider?: string; model?: string; effort?: string}) => ({
      provider: input.provider ?? 'openrouter',
      model: input.model ?? 'x',
      effort: input.effort,
    }));
    const {ctx, messages} = buildCtx({config});

    await runInteractiveCommand(ctx, '/model google/gemini-3.1-flash-lite low');
    expect(config).toHaveBeenCalledWith({provider: 'openrouter', model: 'google/gemini-3.1-flash-lite', effort: 'low'});
    expect(messages.at(-1)?.text).toContain('openrouter/google/gemini-3.1-flash-lite');

    await runInteractiveCommand(ctx, '/model openrouter/moonshotai/kimi-k2');
    expect(config).toHaveBeenLastCalledWith({provider: 'openrouter', model: 'moonshotai/kimi-k2'});
  });

  it('gates the direct-Anthropic door behind an API key instead of failing a turn', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const config = jest.fn(async () => ({provider: 'anthropic', model: 'claude-opus-4-8'}));
    const {ctx, messages} = buildCtx({config});
    await applyModelChoice(ctx, findModelChoice('claude-api')!, 'high');
    expect(config).not.toHaveBeenCalled();
    expect(messages.at(-1)?.text).toContain('ANTHROPIC_API_KEY');
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  });
});

import {
  mapCodexNotification,
  codexApprovalResponse,
  buildApprovalRequest,
  isCodexReasoningEffort,
  resolveCodexBin,
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
import {resolveContextWindow} from '../../interactive-tui/modelLimits';
import * as prefs from '../../interactive-tui/prefs';

beforeEach(() => {
  jest.spyOn(prefs, 'loadPrefs').mockReturnValue({});
  jest.spyOn(prefs, 'savePrefs').mockReturnValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Codex binary resolution', () => {
  it('prefers an explicit CODEX_BIN override', () => {
    expect(resolveCodexBin({CODEX_BIN: '/custom/codex'}, 'darwin', () => true))
      .toBe('/custom/codex');
  });

  it('uses the ChatGPT app runtime on macOS when available', () => {
    expect(resolveCodexBin({}, 'darwin', () => true))
      .toBe('/Applications/ChatGPT.app/Contents/Resources/codex');
  });

  it('falls back to PATH on other platforms', () => {
    expect(resolveCodexBin({}, 'linux', () => false)).toBe('codex');
  });
});

describe('mapCodexNotification (Codex app-server → BrainEvent)', () => {
  it('maps an agent message delta to a streamed token', () => {
    expect(mapCodexNotification('item/agentMessage/delta', {delta: 'hi'})).toEqual({type: 'token', content: 'hi'});
  });

  it('maps tool-bearing item lifecycle to tool_call / tool_result with the item id as callId', () => {
    const started = mapCodexNotification('item/started', {item: {type: 'commandExecution', id: '1'}});
    expect(started).toEqual({type: 'tool_call', toolCall: {name: 'shell', callId: '1'}});

    const okResult = mapCodexNotification('item/completed', {item: {type: 'webSearch', id: '2'}});
    expect(okResult).toEqual({type: 'tool_result', toolResult: {name: 'web_search', success: true, callId: '2'}});

    const failResult = mapCodexNotification('item/completed', {item: {type: 'commandExecution', id: '3', exitCode: 1}});
    expect(failResult).toEqual({type: 'tool_result', toolResult: {name: 'shell', success: false, callId: '3'}});
  });

  it('surfaces the command on the call and its output on completion', () => {
    const started = mapCodexNotification('item/started', {
      item: {type: 'commandExecution', id: '1', command: 'npx tsc --noEmit'},
    });
    expect(started).toEqual({type: 'tool_call', toolCall: {name: 'shell', detail: 'npx tsc --noEmit', callId: '1'}});

    const completed = mapCodexNotification('item/completed', {
      item: {type: 'commandExecution', id: '1', command: 'npx tsc --noEmit', exitCode: 0, aggregatedOutput: 'no errors\n'},
    });
    expect(completed).toEqual({
      type: 'tool_result',
      toolResult: {name: 'shell', success: true, output: 'no errors\n', outputFormat: 'text', callId: '1'},
    });
  });

  it('surfaces the search query as the call detail', () => {
    const started = mapCodexNotification('item/started', {
      item: {type: 'webSearch', id: '2', query: 'zig atomic file write'},
    });
    expect(started).toEqual({type: 'tool_call', toolCall: {name: 'web_search', detail: 'zig atomic file write', callId: '2'}});
  });

  it('omits detail/output/callId when the item has none (no empty keys)', () => {
    expect(mapCodexNotification('item/started', {item: {type: 'commandExecution', id: '3'}})).toEqual({
      type: 'tool_call',
      toolCall: {name: 'shell', callId: '3'},
    });
    expect(
      mapCodexNotification('item/completed', {item: {type: 'commandExecution', id: '3', exitCode: 0, aggregatedOutput: '   '}}),
    ).toEqual({type: 'tool_result', toolResult: {name: 'shell', success: true, callId: '3'}});
    expect(mapCodexNotification('item/started', {item: {type: 'commandExecution'}})).toEqual({
      type: 'tool_call',
      toolCall: {name: 'shell'},
    });
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
      getModel: () => ({provider: 'codex', model: 'gpt-6.1-sol'}),
      getCodexAccount: async () => ({type: 'chatgpt', email: 'tom@execufunction.com', planType: 'plus'}),
      getToken: () => undefined, // no Siftable token, but Codex is signed in
    });
    const s = await authed.state();
    expect(s.authStatus).toBe('authenticated');
    expect(s.available).toBe(true);
    expect(s.model?.provider).toBe('codex');

    const loggedOut = new LocalControlClient({
      getModel: () => ({provider: 'codex', model: 'gpt-6.1-sol'}),
      getCodexAccount: async () => null,
      getToken: () => 'sift_pat_x', // Siftable token present but Codex is not
    });
    const s2 = await loggedOut.state();
    expect(s2.authStatus).toBe('unauthenticated');
  });

  it('does not substitute a hosted Sift token for a local provider credential', async () => {
    const client = new LocalControlClient({
      getModel: () => ({provider: 'openrouter', model: 'google/gemini-3.8-flash'}),
      getToken: () => 'sift_pat_x',
      hasProviderCredential: () => false,
      getCodexAccount: async () => null,
    });
    const s = await client.state();
    expect(s.authStatus).toBe('unauthenticated');
  });

  it('reports codexStatus with account and active flag', async () => {
    const client = new LocalControlClient({
      getModel: () => ({provider: 'codex', model: 'gpt-6.1-sol'}),
      getCodexAccount: async () => ({type: 'chatgpt', email: 'tom@execufunction.com', planType: 'plus'}),
    });
    const status = await client.codexStatus();
    expect(status.active).toBe(true);
    expect(status.account?.email).toBe('tom@execufunction.com');
    expect(status.model).toBe('gpt-6.1-sol');
  });

  it('codexSetActive switches the brain provider on and off', async () => {
    const setModel = jest.fn((input: {provider?: string; model?: string}) => ({
      provider: input.provider ?? 'openrouter',
      model: input.model ?? 'google/gemini-3.8-flash',
    }));
    const client = new LocalControlClient({setModel});

    const on = await client.codexSetActive(true);
    expect(setModel).toHaveBeenCalledWith({provider: 'codex', model: 'gpt-6.1-sol'});
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
      model: () => 'gpt-6.1-sol',
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
      codexStatus: async () => ({installed: true, account: {type: 'chatgpt', email: 'tom@x.io', planType: 'plus'}, active: true, model: 'gpt-6.1-sol'}),
      codexLogin: async () => ({verificationUri: 'u', userCode: 'c'}),
    });
    await runInteractiveCommand(ctx, '/codex status');
    expect(messages.at(-1)?.text).toContain('signed in as tom@x.io');
    expect(messages.at(-1)?.text).toContain('active');
  });

  it('activates the engine via the unified model-selection path on /codex on', async () => {
    const {ctx, messages} = buildCtx({
      codexStatus: async () => ({installed: true, account: {type: 'chatgpt', email: 'tom@x.io'}, active: false, model: 'gpt-6.1-sol'}),
      codexLogin: async () => ({verificationUri: 'u', userCode: 'c'}),
      config: async (input) => ({provider: input.provider ?? 'codex', model: input.model ?? 'gpt-6.1-sol'}),
    });
    await runInteractiveCommand(ctx, '/codex on');
    // Goes through applyModelChoice → client.config, same as picking it in /model.
    expect(ctx.setModel).toHaveBeenCalledWith('gpt-6.1-sol');
    expect(messages.at(-1)?.text).toContain('codex/gpt-6.1-sol');
    expect(messages.at(-1)?.text).toContain('signed in as tom@x.io');
  });

  it('activates GPT-6.1 Sol after a successful Codex login', async () => {
    let finishLogin!: (value: {success: boolean; email?: string}) => void;
    const completion = new Promise<{success: boolean; email?: string}>((resolve) => {
      finishLogin = resolve;
    });
    const codexSetActive = jest.fn(async () => ({provider: 'codex', model: 'gpt-6.1-sol'}));
    const {ctx, messages} = buildCtx({
      codexStatus: async () => ({installed: true, account: null, active: false, model: 'gpt-6.1-sol'}),
      codexLogin: async () => ({verificationUri: 'u', userCode: 'c', completion}),
      codexSetActive,
    });

    await runInteractiveCommand(ctx, '/codex login');
    finishLogin({success: true, email: 'tom@x.io'});
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(codexSetActive).toHaveBeenCalledWith(true);
    expect(ctx.setModel).toHaveBeenCalledWith('gpt-6.1-sol');
    expect(messages.at(-1)?.text).toContain('Codex is now your engine');
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
      model: () => 'gpt-6.1-sol',
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

  it('description context claims never exceed the resolved compaction window', () => {
    // Prose like "1M context" is not authoritative — but it is user-facing, so
    // a claim the shared limits table cannot honor is a defect either way:
    // fix the table or fix the description. This asserts resolved >= claimed.
    const claim = /(\d+(?:\.\d+)?)\s*([kKmM])\s*-?\s*context/i;
    const mismatches: string[] = [];
    for (const choice of INTERACTIVE_MODEL_CHOICES) {
      const match = claim.exec(choice.description);
      if (!match) continue;
      const claimed = Number(match[1]) * (match[2]!.toLowerCase() === 'm' ? 1_000_000 : 1_000);
      const resolution = resolveContextWindow(choice.model);
      if (resolution.window < claimed) {
        mismatches.push(`${choice.id} claims "${match[0]}" but resolves to ${resolution.window} (${resolution.source})`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every catalogued model resolves a positive finite context window', () => {
    for (const choice of INTERACTIVE_MODEL_CHOICES) {
      const resolution = resolveContextWindow(choice.model);
      expect(Number.isFinite(resolution.window)).toBe(true);
      expect(resolution.window).toBeGreaterThan(0);
    }
  });

  it('resolves both Opus doors by alias', () => {
    // Door A — via OpenRouter. Opus 5 is retired; family aliases, OpenRouter
    // slugs, and saved OpenRouter ids resolve to OpenRouter Opus 5.5.
    for (const alias of [
      'opus',
      'claude',
      'openrouter',
      'openrouter/anthropic/claude-opus-5',
      'openrouter/anthropic/claude-opus-4.8',
      'claude-opus-4.8',
    ]) {
      expect(findModelChoice(alias)).toMatchObject({
        provider: 'openrouter',
        model: 'anthropic/claude-opus-5.5',
        defaultEffort: 'medium',
      });
    }
    expect(INTERACTIVE_MODEL_CHOICES.some((choice) => /claude-opus-5$/.test(choice.model))).toBe(false);
    // Retired Sonnet selections resolve to the current Sonnet rather than
    // resurrecting an obsolete catalog option.
    for (const alias of ['sonnet', 'claude-sonnet-4.6', 'anthropic/claude-sonnet-5', 'openrouter/anthropic/claude-sonnet-4.6']) {
      expect(findModelChoice(alias)).toMatchObject({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-5.5',
        defaultEffort: 'high',
      });
    }
    for (const alias of ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4', 'claude-sonnet-5-5']) {
      expect(findModelChoice(alias)).toMatchObject({provider: 'anthropic', model: 'claude-sonnet-5-5'});
    }
    expect(findModelChoice('anthropic')).toMatchObject({model: 'claude-opus-5-5'});
    // Door B — direct Anthropic API (/claude-api).
    for (const alias of ['claude-api', 'opus-direct', 'anthropic-opus', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8']) {
      expect(findModelChoice(alias)).toMatchObject({
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        auth: 'anthropic',
      });
    }
  });

  it('keeps each saved selection on the door it was saved from', () => {
    // A saved direct-Anthropic Opus 5 selection must stay direct.
    expect(findModelChoice('anthropic/claude-opus-5')?.id).toBe('anthropic/claude-opus-5-5');
    expect(findModelChoice('anthropic/claude-opus-4-8')?.id).toBe('anthropic/claude-opus-5-5');
    expect(findModelChoice('openrouter/anthropic/claude-opus-5')?.id).toBe('openrouter/anthropic/claude-opus-5.5');
    expect(findModelChoice('openrouter/anthropic/claude-opus-4.8')?.id).toBe('openrouter/anthropic/claude-opus-5.5');
    expect(findModelChoice('openrouter/anthropic/claude-sonnet-4.6')?.id).toBe('openrouter/anthropic/claude-sonnet-5.5');
    expect(findModelChoice('claude-fable-5-1')?.id).toBe('anthropic/claude-fable-5-1');
    // Every Claude alias names exactly one door: an alias never shadows another
    // Claude entry's id or model string, and no alias repeats across entries.
    const owners = new Map<string, string>();
    for (const choice of INTERACTIVE_MODEL_CHOICES.filter((entry) => /claude/.test(entry.model))) {
      for (const key of [choice.id, choice.model, ...(choice.aliases ?? [])]) {
        const lower = key.toLowerCase();
        const owner = owners.get(lower);
        if (owner !== undefined && owner !== choice.id) {
          throw new Error(`${key} resolves to both ${owner} and ${choice.id}`);
        }
        owners.set(lower, choice.id);
      }
    }
    for (const choice of INTERACTIVE_MODEL_CHOICES) {
      if (!/claude/.test(choice.model)) continue;
      for (const alias of choice.aliases ?? []) {
        const firstPartyId = /^(?:anthropic\/)?claude-[a-z]+-\d+(?:-\d+)*$/.test(alias) && !alias.includes('.');
        const openRouterSaved = alias.startsWith('openrouter/');
        if (firstPartyId && alias !== 'anthropic/claude-sonnet-5' && alias !== 'anthropic/claude-sonnet-4') {
          expect([choice.provider, alias]).toEqual(['anthropic', alias]);
        }
        if (openRouterSaved) expect([choice.provider, alias]).toEqual(['openrouter', alias]);
      }
    }
  });

  it('resolves the current Claude models with their effort defaults', () => {
    expect(findModelChoice('opus-5.5')).toMatchObject({
      provider: 'openrouter',
      model: 'anthropic/claude-opus-5.5',
      defaultEffort: 'medium',
    });
    expect(findModelChoice('anthropic/claude-opus-5-5')).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      defaultEffort: 'medium',
    });
    expect(findModelChoice('fable')).toMatchObject({
      provider: 'openrouter',
      model: 'anthropic/claude-fable-5.1',
      defaultEffort: 'high',
    });
    expect(findModelChoice('fable-direct')).toMatchObject({provider: 'anthropic', model: 'claude-fable-5-1'});
    expect(findModelChoice('sonnet-direct')).toMatchObject({provider: 'anthropic', model: 'claude-sonnet-5-5'});
    for (const model of ['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'anthropic/claude-fable-5.1']) {
      expect(findModelChoice(model)?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    }
  });

  it('routes standard and Contributor Muse to distinct Meta model IDs', async () => {
    const config = jest.fn(async (input: {provider?: string; model?: string; effort?: string}) => ({
      provider: input.provider ?? 'meta',
      model: input.model ?? 'x',
      effort: input.effort,
    }));
    const {ctx, messages} = buildCtx({config});

    expect(findModelChoice('spark')).toMatchObject({
      provider: 'meta',
      model: 'muse-spark-1.3',
    });
    expect(findModelChoice('muse')?.id).toBe('meta/muse-spark-1.3');
    expect(findModelChoice('muse-contributor')?.id).toBe('meta/muse-spark-1.3-contributor');
    expect(findModelChoice('meta/muse-spark-1.3-contributor')?.label).toBe('Muse Spark 1.3 Contributor');
    expect(findModelChoice('muse')?.reasoningEfforts).toContain('max');
    expect(findModelChoice('muse-contributor')?.reasoningEfforts).not.toContain('max');

    process.env.META_API_KEY = 'test-meta-key';
    try {
      await runInteractiveCommand(ctx, '/model spark max');
      await runInteractiveCommand(ctx, '/model muse-contributor high');
    } finally {
      delete process.env.META_API_KEY;
    }
    expect(config).toHaveBeenCalledWith({provider: 'meta', model: 'muse-spark-1.3', effort: 'max'});
    expect(config).toHaveBeenCalledWith({provider: 'meta', model: 'muse-spark-1.3-contributor', effort: 'high'});
    expect(messages.at(-1)?.text).toContain('meta/muse-spark-1.3-contributor');
  });

  it('catalogues GPT-6.1 Sol and preserves retained Codex tiers', async () => {
    const config = jest.fn(async (input: {provider?: string; model?: string; effort?: string}) => ({
      provider: input.provider ?? 'codex',
      model: input.model ?? 'gpt-6.1-sol',
      effort: input.effort,
    }));
    const {ctx, messages} = buildCtx({
      config,
      codexStatus: async () => ({
        installed: true,
        account: {type: 'chatgpt', email: 'tom@x.io'},
        active: true,
        model: 'gpt-6.1-sol',
      }),
      codexLogin: jest.fn(),
    });

    expect(findModelChoice('gpt-5.6')).toMatchObject({provider: 'codex', model: 'gpt-6.1-sol'});
    expect(findModelChoice('codex')).toMatchObject({provider: 'codex', model: 'gpt-6.1-sol'});
    expect(findModelChoice('sol')?.model).toBe('gpt-6.1-sol');
    for (const alias of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'codex/gpt-6-sol', 'codex/gpt-5.6-sol']) {
      expect(findModelChoice(alias)?.model).toBe('gpt-6.1-sol');
    }
    expect(findModelChoice('sol')?.reasoningEfforts).not.toContain('none');
    expect(findModelChoice('sol')?.reasoningEfforts).not.toContain('minimal');
    expect(findModelChoice('astra')?.reasoningEfforts).not.toContain('none');
    expect(findModelChoice('astra')?.reasoningEfforts).not.toContain('minimal');
    expect(findModelChoice('luna-6')).toMatchObject({ provider: 'codex', model: 'gpt-6-luna' });
    expect(findModelChoice('gpt-6-luna')?.reasoningEfforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    await runInteractiveCommand(ctx, '/model gpt-6-luna none');
    expect(config).toHaveBeenCalledWith({provider: 'codex', model: 'gpt-6-luna', effort: 'none'});
    expect(isCodexReasoningEffort('none')).toBe(true);
    expect(isCodexReasoningEffort('none', 'gpt-6-luna')).toBe(true);
    expect(isCodexReasoningEffort('none', 'gpt-6.1-sol')).toBe(false);
    expect(isCodexReasoningEffort('none', 'gpt-6-astra')).toBe(false);
    expect(isCodexReasoningEffort('minimal', 'gpt-6.1-sol')).toBe(false);
    expect(isCodexReasoningEffort('ultra', 'gpt-6.1-sol')).toBe(false);
    await runInteractiveCommand(ctx, '/model codex/gpt-5.6-sol high');
    expect(config).toHaveBeenCalledWith({provider: 'codex', model: 'gpt-6.1-sol', effort: 'high'});
    expect(findModelChoice('terra')?.model).toBe('gpt-5.6-terra');
    expect(findModelChoice('luna')?.model).toBe('gpt-5.6-luna');
    for (const alias of ['sol', 'terra', 'luna']) {
      expect(findModelChoice(alias)?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
      expect(findModelChoice(alias)?.defaultEffort).toBe('medium');
    }
    expect(isCodexReasoningEffort('max')).toBe(true);
    expect(findModelChoice('astra')).toMatchObject({provider: 'codex', model: 'gpt-6-astra'});
    expect(findModelChoice('astra')?.reasoningEfforts).toContain('ultra');
    expect(isCodexReasoningEffort('ultra')).toBe(true);
    await runInteractiveCommand(ctx, '/model astra ultra');
    expect(config).toHaveBeenCalledWith({provider: 'codex', model: 'gpt-6-astra', effort: 'ultra'});

    await runInteractiveCommand(ctx, '/model gpt-5.6-terra max');
    expect(config).toHaveBeenCalledWith({provider: 'codex', model: 'gpt-5.6-terra', effort: 'max'});
    expect(messages.at(-1)?.text).toContain('codex/gpt-5.6-terra · reasoning max');
  });

  it('retires legacy full-size GPT models while retaining GPT-5.4 Mini', () => {
    const models = INTERACTIVE_MODEL_CHOICES.map((choice) => choice.model);
    expect(models).not.toContain('gpt-5.5');
    expect(models).not.toContain('gpt-5.4');
    expect(models).not.toContain('gpt-5.3-codex-spark');
    expect(models).toContain('openai/gpt-5.4-mini');
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

  it('catalogues Gemini 3.8 Flash and promotes retired 3.7 selections', () => {
    for (const alias of [
      'gemini',
      'gemini-3.8-flash',
      'google/gemini-3.8-flash',
      'openrouter:google/gemini-3.8-flash',
      'gemini-3.7-flash',
      'google/gemini-3.7-flash',
      'openrouter/google/gemini-3.7-flash',
      'openrouter:google/gemini-3.7-flash',
      'gemini-3.6-flash',
      'google/gemini-3.6-flash',
      'openrouter/google/gemini-3.6-flash',
      'openrouter:google/gemini-3.6-flash',
    ]) {
      expect(findModelChoice(alias)).toMatchObject({
        id: 'openrouter/google/gemini-3.8-flash',
        provider: 'openrouter',
        model: 'google/gemini-3.8-flash',
        reasoningEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      });
    }
  });

  it('catalogues Grok 4.6 and resolves current and retired aliases through OpenRouter', async () => {
    const config = jest.fn(async (input: {provider?: string; model?: string; effort?: string}) => ({
      provider: input.provider ?? 'openrouter',
      model: input.model ?? 'x',
      effort: input.effort,
    }));
    const {ctx, messages} = buildCtx({config});

    expect(findModelChoice('grok')).toMatchObject({
      id: 'openrouter/x-ai/grok-4.6',
      provider: 'openrouter',
      model: 'x-ai/grok-4.6',
    });
    expect(findModelChoice('grok-4-6')?.model).toBe('x-ai/grok-4.6');
    expect(findModelChoice('grok-4-5')?.model).toBe('x-ai/grok-4.6');
    expect(findModelChoice('openrouter:x-ai/grok-4.5')?.model).toBe('x-ai/grok-4.6');

    await runInteractiveCommand(ctx, '/model grok-45 high');
    expect(config).toHaveBeenCalledWith({provider: 'openrouter', model: 'x-ai/grok-4.6', effort: 'high'});
    expect(messages.at(-1)?.text).toContain('openrouter/x-ai/grok-4.6');
  });

  it('offers Kimi K3 and K2.6 while migrating retired K2 aliases to K2.6', async () => {
    const config = jest.fn(async (input: {provider?: string; model?: string; effort?: string}) => ({
      provider: input.provider ?? 'openrouter',
      model: input.model ?? 'x',
      effort: input.effort,
    }));
    const {ctx, messages} = buildCtx({config});

    expect(findModelChoice('kimi')).toMatchObject({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k3',
      reasoningEfforts: ['max'],
      defaultEffort: 'max',
    });
    expect(findModelChoice('kimi-k2.6')?.model).toBe('moonshotai/kimi-k2.6');
    expect(findModelChoice('kimi-k2.7-code')?.model).toBe('moonshotai/kimi-k2.6');
    const kimiModels = INTERACTIVE_MODEL_CHOICES
      .map((choice) => choice.model)
      .filter((model) => model.includes('kimi'));
    expect(kimiModels).toEqual(['moonshotai/kimi-k3', 'moonshotai/kimi-k2.6']);

    await runInteractiveCommand(ctx, '/model kimi');
    expect(config).toHaveBeenCalledWith({provider: 'openrouter', model: 'moonshotai/kimi-k3', effort: 'max'});
    expect(messages.at(-1)?.text).toContain('openrouter/moonshotai/kimi-k3');
  });

  it.each([
    ['/model sol ultra', 'GPT-6.1 Sol', 'Supported efforts: low, medium, high, xhigh, max.'],
    ['/model codex/gpt-5.6-terra ultra', 'GPT-5.6 Terra', 'Supported efforts: low, medium, high, xhigh, max.'],
    ['/model muse-contributor max', 'Muse Spark 1.3 Contributor', 'Supported efforts: minimal, low, medium, high, xhigh.'],
    ['/model morph high', 'Morph v3 Large', 'This model does not offer configurable reasoning effort.'],
  ])('rejects an effort outside the selected catalog model: %s', async (command, label, guidance) => {
    const config = jest.fn(async () => ({provider: 'codex', model: 'gpt-6.1-sol'}));
    const {ctx, messages} = buildCtx({config});
    await runInteractiveCommand(ctx, command);
    expect(config).not.toHaveBeenCalled();
    expect(prefs.savePrefs).not.toHaveBeenCalled();
    expect(messages.at(-1)?.text).toContain(`${label} does not support reasoning effort`);
    expect(messages.at(-1)?.text).toContain(guidance);
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
    expect(config).toHaveBeenLastCalledWith({provider: 'openrouter', model: 'moonshotai/kimi-k2.6', effort: ''});

    await runInteractiveCommand(ctx, '/model openrouter/z-ai/glm-5');
    expect(config).toHaveBeenLastCalledWith({provider: 'openrouter', model: 'z-ai/glm-5.2'});

    await runInteractiveCommand(ctx, '/model glm-5');
    expect(config).toHaveBeenLastCalledWith({provider: 'openrouter', model: 'z-ai/glm-5.2', effort: 'high'});
  });

  it('gates the direct-Anthropic door behind an API key instead of failing a turn', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const config = jest.fn(async () => ({provider: 'anthropic', model: 'claude-opus-5-5'}));
    const {ctx, messages} = buildCtx({config});
    await applyModelChoice(ctx, findModelChoice('claude-api')!, 'high');
    expect(config).not.toHaveBeenCalled();
    expect(messages.at(-1)?.text).toContain('ANTHROPIC_API_KEY');
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  });
});

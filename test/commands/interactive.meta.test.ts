import {findModelChoice, modelSuggestions, restoreSavedModel, runInteractiveCommand, type InteractiveCommandContext} from '../../interactive-tui/commands';
import {getBrainModel, setBrainModel} from '../../interactive-tui/brain';
import * as prefs from '../../interactive-tui/prefs';
import * as providerKeychain from '../../interactive-tui/providerKeychain';
import {resolveAdapter} from '../../interactive-tui/agent-harness/framework/chat-agent-resolve';
import {ToolRegistry} from '../../interactive-tui/agent-harness/framework/registry';


const model = 'muse-spark-1.3-contributor';
const id = `meta/${model}`;
const originalKey = process.env.META_API_KEY;
const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;

beforeEach(() => {
  jest.spyOn(prefs, 'loadPrefs').mockReturnValue({});
  jest.spyOn(prefs, 'savePrefs').mockReturnValue(true);
  // Keychain access stays hermetic: the spies keep remembered-key tests off
  // the developer's real keychain (recall would otherwise find stored keys).
  jest.spyOn(providerKeychain, 'recallProviderKey').mockReturnValue(null);
  jest.spyOn(providerKeychain, 'rememberProviderKey').mockImplementation(() => undefined);
  jest.spyOn(providerKeychain, 'forgetProviderKey').mockImplementation(() => undefined);
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.META_API_KEY;
  else process.env.META_API_KEY = originalKey;
  if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAIKey;
  if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
  jest.restoreAllMocks();
});

function context() {
  const config = jest.fn(async (input: {provider?: string; model?: string}) => ({provider: input.provider ?? '', model: input.model ?? ''}));
  const push = jest.fn();
  const ctx = {client: {config}, setModel: jest.fn(), push} as unknown as InteractiveCommandContext;
  return {ctx, config, push};
}

describe('direct Meta Muse model selection', () => {
  it('exposes the exact model and aliases in the picker', () => {
    for (const alias of [id, model, 'muse-contributor', 'spark-contributor']) {
      expect(findModelChoice(alias)).toMatchObject({id, provider: 'meta', model, requiredEnv: 'META_API_KEY'});
    }
    expect(modelSuggestions('muse')).toContainEqual(expect.objectContaining({id, label: 'Muse Spark 1.3 Contributor'}));
  });

  it('selects and persists the Meta route with its own key', async () => {
    process.env.META_API_KEY = 'fixture-meta-key';
    const {ctx, config} = context();
    await runInteractiveCommand(ctx, '/model muse-contributor');
    expect(config).toHaveBeenCalledWith({provider: 'meta', model, effort: ''});
    expect(prefs.savePrefs).toHaveBeenCalledWith({model: {id}});
  });

  it('requires the Meta key instead of accepting another provider credential', async () => {
    delete process.env.META_API_KEY;
    process.env.OPENAI_API_KEY = 'fixture-openai-key';
    const {ctx, config, push} = context();
    await runInteractiveCommand(ctx, `/model ${id}`);
    expect(config).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith(expect.objectContaining({text: expect.stringContaining('META_API_KEY')}));
  });

  it('routes session key setup to the Meta model provider', async () => {
    const {ctx, config} = context();
    await runInteractiveCommand(ctx, '/key meta fixture-meta-key');
    expect(config).toHaveBeenCalledWith({provider: 'meta', apiKey: 'fixture-meta-key'});
  });

  for (const provider of ['meta', 'openrouter'] as const) {
    it(`stores a ${provider} key without changing fresh Sol model selection`, async () => {
      delete process.env.META_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      const prior = getBrainModel();
      const {ctx, config, push} = context();
      config.mockImplementation(async input => setBrainModel(input));
      const initial = {provider: 'codex', model: 'gpt-5.6-sol', effort: 'medium'};
      setBrainModel(initial);
      try {
        if (provider === 'meta') {
          await runInteractiveCommand(ctx, '/model muse-contributor');
          expect(config).not.toHaveBeenCalled();
        }
        await runInteractiveCommand(ctx, `/key ${provider} fixture-provider-key`);
        expect(getBrainModel()).toEqual(initial);
        expect(process.env[`${provider.toUpperCase()}_API_KEY`]).toBe('fixture-provider-key');
        expect(JSON.stringify(push.mock.calls)).not.toContain('fixture-provider-key');
        if (provider === 'meta') {
          await runInteractiveCommand(ctx, '/model muse-contributor');
          expect(getBrainModel()).toEqual({provider: 'meta', model, effort: undefined});
        }
      } finally {
        setBrainModel({...prior, effort: prior.effort ?? ''});
      }
    });
  }

  it('retains explicit provider and mixed model configuration behavior', () => {
    const prior = getBrainModel();
    try {
      setBrainModel({provider: 'codex', model: 'gpt-5.6-sol', effort: 'medium'});
      expect(setBrainModel({provider: 'meta'}).provider).toBe('meta');
      expect(setBrainModel({provider: 'openrouter', model: 'google/gemini-3.8-flash', apiKey: 'fixture-provider-key', effort: 'low'}))
        .toEqual({provider: 'openrouter', model: 'google/gemini-3.8-flash', effort: 'low'});
    } finally {
      setBrainModel({...prior, effort: prior.effort ?? ''});
    }
  });

  it('restores the saved Meta route without requesting credentials', async () => {
    delete process.env.META_API_KEY;
    jest.mocked(prefs.loadPrefs).mockReturnValueOnce({model: {id}});
    const {ctx, config} = context();
    await restoreSavedModel(ctx);
    expect(config).toHaveBeenCalledWith({provider: 'meta', model, effort: ''});
  });

  for (const selection of ['command', 'restore'] as const) {
    it(`clears prior reasoning effort on Muse ${selection} before invoking Meta`, async () => {
      process.env.META_API_KEY = 'fixture-meta-key';
      const prior = getBrainModel();
      const {ctx, config} = context();
      config.mockImplementation(async input => setBrainModel(input));
      setBrainModel({provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh'});
      try {
        if (selection === 'command') await runInteractiveCommand(ctx, '/model muse-contributor');
        else {
          jest.mocked(prefs.loadPrefs).mockReturnValueOnce({model: {id}});
          await restoreSavedModel(ctx);
        }
        const selected = getBrainModel();
        expect(selected).toEqual({provider: 'meta', model, effort: undefined});
        const fetchImpl = jest.fn(async () => new Response(JSON.stringify({
          choices: [{finish_reason: 'stop', message: {role: 'assistant', content: 'ok'}}],
        }), {headers: {'content-type': 'application/json'}}));
        const adapter = resolveAdapter({provider: selected.provider, model: selected.model,
          reasoningEffort: selected.effort as 'xhigh' | undefined,
          adapterConfig: {fetchImpl: fetchImpl as unknown as typeof fetch}});
        await adapter.chat([{role: 'user', content: 'hello'}], new ToolRegistry(), {stream: false});
        const [, init] = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
        expect(JSON.parse(String(init.body))).not.toHaveProperty('reasoning_effort');
      } finally {
        setBrainModel({...prior, effort: prior.effort ?? ''});
      }
    });
  }

  it('sends the resolved adapter request to Meta with the Meta key and exact model', async () => {
    process.env.META_API_KEY = 'fixture-meta-key';
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({
      id: 'fixture-response', model,
      choices: [{finish_reason: 'stop', message: {role: 'assistant', content: 'ok'}}],
    }), {headers: {'content-type': 'application/json'}}));
    const adapter = resolveAdapter({provider: 'meta', model, adapterConfig: {fetchImpl: fetchImpl as unknown as typeof fetch}});
    expect(adapter.name).toBe('Meta');
    await adapter.chat([{role: 'user', content: 'hello'}], new ToolRegistry(), {stream: false});
    const [url, init] = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
    expect(url).toBe('https://api.meta.ai/v1/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-meta-key');
    expect(JSON.parse(String(init.body)).model).toBe(model);
  });
});

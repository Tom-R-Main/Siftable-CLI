import {
  autoloadProviderKeysFromKeychain,
  runInteractiveCommand,
  type InteractiveCommandContext,
} from '../../interactive-tui/commands';
import * as prefs from '../../interactive-tui/prefs';
import * as providerKeychain from '../../interactive-tui/providerKeychain';

const ENV_VARS = ['META_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'MORPH_API_KEY'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.spyOn(prefs, 'loadPrefs').mockReturnValue({});
  jest.spyOn(prefs, 'savePrefs').mockReturnValue(true);
  for (const name of ENV_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  jest.spyOn(providerKeychain, 'recallProviderKey').mockReturnValue(null);
  jest.spyOn(providerKeychain, 'rememberProviderKey').mockImplementation(() => undefined);
  jest.spyOn(providerKeychain, 'forgetProviderKey').mockImplementation(() => undefined);
});

const mockRecall = () => jest.mocked(providerKeychain.recallProviderKey);
const mockRemember = () => jest.mocked(providerKeychain.rememberProviderKey);
const mockForget = () => jest.mocked(providerKeychain.forgetProviderKey);

afterEach(() => {
  for (const name of ENV_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  jest.restoreAllMocks();
});

function context() {
  const config = jest.fn(async (input: { provider?: string; model?: string; apiKey?: string }) => ({
    provider: input.provider ?? '',
    model: input.model ?? '',
  }));
  const push = jest.fn();
  const ctx = { client: { config }, setModel: jest.fn(), push } as unknown as InteractiveCommandContext;
  const messages: Array<{ role: string; text: string }> = [];
  const ctxWithMessages = {
    ...ctx,
    push: (message: { role: string; text: string }) => {
      messages.push(message);
      push(message);
    },
  } as unknown as InteractiveCommandContext;
  return { ctx: ctxWithMessages, config, messages };
}

describe('autoloadProviderKeysFromKeychain', () => {
  it('fills unset provider env vars from remembered keys', () => {
    mockRecall().mockImplementation((envVar: string) => (envVar === 'META_API_KEY' ? 'remembered-meta' : null));
    const loaded = autoloadProviderKeysFromKeychain();
    expect(process.env.META_API_KEY).toBe('remembered-meta');
    expect(loaded).toContain('META_API_KEY');
  });

  it('never overwrites keys already in the environment', () => {
    process.env.OPENROUTER_API_KEY = 'explicit-key';
    mockRecall().mockReturnValue('remembered-key');
    autoloadProviderKeysFromKeychain();
    expect(process.env.OPENROUTER_API_KEY).toBe('explicit-key');
    expect(mockRecall()).not.toHaveBeenCalledWith('OPENROUTER_API_KEY');
  });
});

describe('/key remember wiring', () => {
  it('remembers brain-provider keys and says so', async () => {
    const { ctx, config, messages } = context();
    await runInteractiveCommand(ctx, '/key meta remembered-meta');
    expect(config).toHaveBeenCalledWith({ provider: 'meta', apiKey: 'remembered-meta' });
    expect(mockRemember()).toHaveBeenCalledWith('META_API_KEY', 'remembered-meta');
    expect(messages.at(-1)?.text).toContain('Remembered in the system keychain');
  });

  it('stays session-only when the keychain refuses', async () => {
    mockRemember().mockImplementation(() => { throw new Error('System keychain refused the key'); });
    const { ctx, config, messages } = context();
    await runInteractiveCommand(ctx, '/key meta session-meta');
    expect(config).toHaveBeenCalledWith({ provider: 'meta', apiKey: 'session-meta' });
    expect(messages.at(-1)?.text).not.toContain('Remembered');
    expect(process.env.META_API_KEY).toBeUndefined();
  });

  it('forgets keys from env and keychain', async () => {
    process.env.META_API_KEY = 'old-key';
    const { ctx, messages } = context();
    await runInteractiveCommand(ctx, '/key forget meta');
    expect(process.env.META_API_KEY).toBeUndefined();
    expect(mockForget()).toHaveBeenCalledWith('META_API_KEY');
    expect(messages.at(-1)?.text).toContain('forgot meta key');
  });

  it('reports refused deletions instead of a false success', async () => {
    mockForget().mockImplementation(() => { throw new Error('System keychain refused the deletion'); });
    process.env.META_API_KEY = 'old-key';
    const { ctx, messages } = context();
    await runInteractiveCommand(ctx, '/key forget meta');
    expect(messages.at(-1)?.text).toContain('/key forget failed');
  });

  it('configures the brain before persisting the key', async () => {
    const { ctx, config } = context();
    await runInteractiveCommand(ctx, '/key meta ordered-key');
    expect(config.mock.invocationCallOrder[0]).toBeLessThan(mockRemember().mock.invocationCallOrder[0]);
  });
});

describe('/model recall wiring', () => {
  it('unlocks a remembered key during selection with no extra message', async () => {
    mockRecall().mockImplementation((envVar: string) => (envVar === 'META_API_KEY' ? 'remembered-meta' : null));
    const { ctx, config } = context();
    await runInteractiveCommand(ctx, '/model muse');
    expect(process.env.META_API_KEY).toBe('remembered-meta');
    expect(config).toHaveBeenCalledWith({ provider: 'meta', model: 'muse-spark-1.3', effort: '' });
  });
});

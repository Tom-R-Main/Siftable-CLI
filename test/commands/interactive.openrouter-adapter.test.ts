import {createOpenRouterAdapter} from '../../interactive-tui/openfunction/framework/adapters/openai';

const registry = {
  getAll: () => [],
  toOpenAIFormat: () => [{type: 'function', function: {name: 'noop', description: 'noop', parameters: {type: 'object'}}}],
};

describe('OpenRouter chat-completions adapter', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('retries an empty tool-enabled response as plain text', async () => {
    const calls: unknown[] = [];
    global.fetch = jest.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      calls.push(body);
      if (calls.length === 1) {
        return response({
          choices: [{
            finish_reason: 'stop',
            message: {role: 'assistant', content: null},
          }],
        });
      }
      return response({
        choices: [{
          finish_reason: 'stop',
          message: {role: 'assistant', content: 'Hello from retry.'},
        }],
      });
    }) as typeof fetch;

    const adapter = createOpenRouterAdapter({apiKey: 'test-key', model: 'google/gemini-3.5-flash'});
    const result = await adapter.chat([{role: 'user', content: 'hello'}], registry as any);

    expect(result.text).toBe('Hello from retry.');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveProperty('tools');
    expect(calls[1]).not.toHaveProperty('tools');
    expect(calls[1]).not.toHaveProperty('reasoning');
  });

  it('returns a diagnostic instead of literal no response when retry is also empty', async () => {
    global.fetch = jest.fn(async () => response({
      choices: [{
        finish_reason: 'stop',
        message: {role: 'assistant', content: null},
      }],
    })) as typeof fetch;

    const adapter = createOpenRouterAdapter({apiKey: 'test-key', model: 'google/gemini-3.5-flash'});
    const result = await adapter.chat([{role: 'user', content: 'hello'}], registry as any);

    expect(result.text).toContain('OpenRouter returned an empty assistant message');
    expect(result.text).toContain('finish_reason: stop');
    expect(result.text).not.toBe('(no response)');
  });
});

function response(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

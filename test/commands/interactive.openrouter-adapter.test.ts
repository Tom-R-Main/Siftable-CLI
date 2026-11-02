import {createOpenRouterAdapter} from '../../interactive-tui/agent-harness/framework/adapters/openai';

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

    const adapter = createOpenRouterAdapter({apiKey: 'test-key', model: 'google/gemini-3.8-flash'});
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

    const adapter = createOpenRouterAdapter({apiKey: 'test-key', model: 'google/gemini-3.8-flash'});
    const result = await adapter.chat([{role: 'user', content: 'hello'}], registry as any);

    expect(result.text).toContain('OpenRouter returned an empty assistant message');
    expect(result.text).toContain('finish_reason: stop');
    expect(result.text).not.toBe('(no response)');
  });

  it.each([
    ['a non-function call', {id: 'call-1', type: 'custom', function: {name: 'noop', arguments: '{}'}}, /type must be "function"/],
    ['a missing function object', {id: 'call-1', type: 'function'}, /\.function must be an object/],
    ['a missing call ID', {type: 'function', function: {name: 'noop', arguments: '{}'}}, /\.id must be a non-empty string/],
    ['a missing function name', {id: 'call-1', type: 'function', function: {arguments: '{}'}}, /\.function\.name must be a non-empty string/],
    ['invalid argument JSON', {id: 'call-1', type: 'function', function: {name: 'noop', arguments: '{bad'}}, /arguments must be valid JSON/],
    ['non-object arguments', {id: 'call-1', type: 'function', function: {name: 'noop', arguments: '[]'}}, /arguments must encode an object/],
  ])('rejects %s with a provider-boundary error', async (_label, toolCall, expected) => {
    global.fetch = jest.fn(async () => response({
      choices: [{
        finish_reason: 'tool_calls',
        message: {role: 'assistant', content: null, tool_calls: [toolCall]},
      }],
    })) as typeof fetch;
    const adapter = createOpenRouterAdapter({apiKey: 'test-key', model: 'test-model'});

    await expect(adapter.chat([{role: 'user', content: 'use a tool'}], registry as any))
      .rejects.toThrow(expected as RegExp);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-array tool_calls field instead of silently ignoring it', async () => {
    global.fetch = jest.fn(async () => response({
      choices: [{
        finish_reason: 'tool_calls',
        message: {role: 'assistant', content: null, tool_calls: {id: 'call-1'}},
      }],
    })) as typeof fetch;
    const adapter = createOpenRouterAdapter({apiKey: 'test-key', model: 'test-model'});

    await expect(adapter.chat([{role: 'user', content: 'use a tool'}], registry as any))
      .rejects.toThrow('OpenRouter response tool_calls must be an array');
  });
});

function response(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

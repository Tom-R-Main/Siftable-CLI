/**
 * Recorded (cassette) tests for the Anthropic adapter — replays committed
 * provider responses through the adapter's injected `fetchImpl` instead of
 * hand-written fetch mocks, so both the request the adapter builds and the
 * response shape it parses are exercised against authentic Messages-API data.
 *
 * Re-record after a provider/adapter change with:
 *   RECORD=1 ANTHROPIC_API_KEY=… npx jest interactive.anthropic-recorded
 * (a record harness calls cassette.save(); see http-cassette.ts).
 */
import {createAnthropicAdapter} from '../../interactive-tui/agent-harness/framework/adapters/anthropic';
import {createCassetteFetch} from '../helpers/http-cassette';

const emptyRegistry = {toAnthropicFormat: () => []} as any;
const weatherRegistry = {
  toAnthropicFormat: () => [
    {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      input_schema: {
        type: 'object',
        properties: {city: {$ref: '#/$defs/city'}},
        required: ['city'],
        additionalProperties: false,
        $defs: {city: {type: 'string', minLength: 1}},
      },
    },
  ],
} as any;

describe('Anthropic adapter (recorded)', () => {
  it('promotes a persisted pre-Opus-5 selection before calling Anthropic', async () => {
    const cassette = createCassetteFetch('anthropic-text-answer');
    const adapter = createAnthropicAdapter({apiKey: 'test-key', model: 'claude-opus-4-8', fetchImpl: cassette.fetch});

    await adapter.chat([{role: 'user', content: 'What is the capital of France? Answer in one word.'}], emptyRegistry);

    expect((cassette.sent[0].body as any).model).toBe('claude-opus-5');
  });

  it('replays a plain text answer and maps it to AdapterResponse.text', async () => {
    const cassette = createCassetteFetch('anthropic-text-answer');
    const adapter = createAnthropicAdapter({apiKey: 'test-key', model: 'claude-opus-5', fetchImpl: cassette.fetch});

    const result = await adapter.chat(
      [{role: 'user', content: 'What is the capital of France? Answer in one word.'}],
      emptyRegistry,
    );

    expect(result.text).toBe('Paris.');
    expect(result.toolCall).toBeUndefined();

    // Opus 5 uses adaptive thinking even when the caller omits effort.
    expect(cassette.sent).toHaveLength(1);
    const body = cassette.sent[0].body as any;
    expect(cassette.sent[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(body.model).toBe('claude-opus-5');
    expect(body.max_tokens).toBe(16000);
    expect(body.thinking).toEqual({type: 'adaptive'});
    expect(body.output_config).toEqual({effort: 'high'});
    expect(body.tools).toEqual([]);
  });

  it('replays a tool_use turn, preserving thinking blocks and text preamble', async () => {
    const cassette = createCassetteFetch('anthropic-tool-use');
    const adapter = createAnthropicAdapter({
      apiKey: 'test-key',
      model: 'claude-opus-5',
      reasoningEffort: 'medium',
      fetchImpl: cassette.fetch,
    });

    const result = await adapter.chat([{role: 'user', content: "What's the weather in Paris?"}], weatherRegistry);

    expect(result.toolCall).toEqual({id: 'toolu_01ReplayWeatherCall', name: 'get_weather', args: {city: 'Paris'}});
    expect(result.text).toBe('Let me check the weather in Paris for you.');
    // Thinking blocks are preserved verbatim for replay on the next turn.
    expect(Array.isArray(result.thinking)).toBe(true);
    expect((result.thinking as any[])[0]).toMatchObject({type: 'thinking', signature: expect.any(String)});

    // Adaptive thinking uses effort instead of the removed fixed token budget.
    const body = cassette.sent[0].body as any;
    expect(body.thinking).toEqual({type: 'adaptive'});
    expect(body.output_config).toEqual({effort: 'medium'});
    expect(body.max_tokens).toBe(16000);
    expect(body.tool_choice).toEqual({type: 'auto', disable_parallel_tool_use: true});
    expect(body.tools[0].input_schema).toEqual(weatherRegistry.toAnthropicFormat()[0].input_schema);
  });
});

describe('cassette transport behavior', () => {
  it('throws when the cassette is exhausted (more requests than recorded)', async () => {
    const cassette = createCassetteFetch('anthropic-text-answer');
    const adapter = createAnthropicAdapter({apiKey: 'k', model: 'claude-opus-5', fetchImpl: cassette.fetch});
    await adapter.chat([{role: 'user', content: 'first — consumes the only interaction'}], emptyRegistry);
    const error = await adapter
      .chat([{role: 'user', content: 'second — nothing left to replay'}], emptyRegistry)
      .catch((caught: unknown) => caught as Error & {cause?: Error});

    // The official SDK wraps exhausted fetch transports after its retry pass,
    // but keeps the original cassette diagnostic on `cause`.
    expect(error.message).toMatch(/Connection error/);
    expect(error.cause?.message).toMatch(/exhausted/);
  });

  it('throws on a method/URL mismatch (re-record signal)', async () => {
    const cassette = createCassetteFetch('anthropic-text-answer');
    await expect(cassette.fetch('https://api.anthropic.com/v1/WRONG', {method: 'POST'})).rejects.toThrow(/mismatch/);
  });
});

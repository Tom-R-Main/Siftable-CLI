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
import {createAnthropicAdapter} from '../../interactive-tui/openfunction/framework/adapters/anthropic';
import {createCassetteFetch} from '../helpers/http-cassette';

const emptyRegistry = {toAnthropicFormat: () => []} as any;
const weatherRegistry = {
  toAnthropicFormat: () => [
    {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      input_schema: {type: 'object', properties: {city: {type: 'string'}}, required: ['city']},
    },
  ],
} as any;

describe('Anthropic adapter (recorded)', () => {
  it('replays a plain text answer and maps it to AdapterResponse.text', async () => {
    const cassette = createCassetteFetch('anthropic-text-answer');
    const adapter = createAnthropicAdapter({apiKey: 'test-key', model: 'claude-sonnet-4-6', fetchImpl: cassette.fetch});

    const result = await adapter.chat(
      [{role: 'user', content: 'What is the capital of France? Answer in one word.'}],
      emptyRegistry,
    );

    expect(result.text).toBe('Paris.');
    expect(result.toolCall).toBeUndefined();

    // The adapter built a correct, non-thinking request.
    expect(cassette.sent).toHaveLength(1);
    const body = cassette.sent[0].body as any;
    expect(cassette.sent[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.max_tokens).toBe(8192);
    expect(body.thinking).toBeUndefined();
    expect(body.tools).toEqual([]);
  });

  it('replays a tool_use turn, preserving thinking blocks and text preamble', async () => {
    const cassette = createCassetteFetch('anthropic-tool-use');
    const adapter = createAnthropicAdapter({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-6',
      reasoningEffort: 'medium',
      fetchImpl: cassette.fetch,
    });

    const result = await adapter.chat([{role: 'user', content: "What's the weather in Paris?"}], weatherRegistry);

    expect(result.toolCall).toEqual({id: 'toolu_01ReplayWeatherCall', name: 'get_weather', args: {city: 'Paris'}});
    expect(result.text).toBe('Let me check the weather in Paris for you.');
    // Thinking blocks are preserved verbatim for replay on the next turn.
    expect(Array.isArray(result.thinking)).toBe(true);
    expect((result.thinking as any[])[0]).toMatchObject({type: 'thinking', signature: expect.any(String)});

    // Extended thinking shaped the request: budget + reserved headroom, auto+serial tools.
    const body = cassette.sent[0].body as any;
    expect(body.thinking).toEqual({type: 'enabled', budget_tokens: 6144});
    expect(body.max_tokens).toBe(6144 + 8192);
    expect(body.tool_choice).toEqual({type: 'auto', disable_parallel_tool_use: true});
  });
});

describe('cassette transport behavior', () => {
  it('throws when the cassette is exhausted (more requests than recorded)', async () => {
    const cassette = createCassetteFetch('anthropic-text-answer');
    const adapter = createAnthropicAdapter({apiKey: 'k', model: 'claude-sonnet-4-6', fetchImpl: cassette.fetch});
    await adapter.chat([{role: 'user', content: 'first — consumes the only interaction'}], emptyRegistry);
    await expect(
      adapter.chat([{role: 'user', content: 'second — nothing left to replay'}], emptyRegistry),
    ).rejects.toThrow(/exhausted/);
  });

  it('throws on a method/URL mismatch (re-record signal)', async () => {
    const cassette = createCassetteFetch('anthropic-text-answer');
    await expect(cassette.fetch('https://api.anthropic.com/v1/WRONG', {method: 'POST'})).rejects.toThrow(/mismatch/);
  });
});

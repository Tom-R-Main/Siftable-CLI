import {createGeminiAdapter} from '../../interactive-tui/agent-harness/framework/adapters/gemini';
import type {ChatMessage, ToolCall} from '../../interactive-tui/agent-harness/framework/adapters/types';

const registry = {
  toGeminiFormat: () => [],
};

describe('Gemini adapter', () => {
  it('keeps synthetic IDs internal while replaying mixed provider-native IDs', async () => {
    const requests: Array<Record<string, any>> = [];
    let callCount = 0;
    const fetchImpl = jest.fn(async (_url, init) => {
      requests.push(JSON.parse(String((init as RequestInit).body)));
      callCount += 1;
      return response(callCount === 1
        ? {
            candidates: [{
              content: {
                parts: [
                  {functionCall: {name: 'without_provider_id', args: {value: 1}}},
                  {functionCall: {id: 'provider-call-2', name: 'with_provider_id', args: {value: 2}}},
                ],
              },
            }],
          }
        : {candidates: [{content: {parts: [{text: 'done'}]}}]});
    }) as typeof fetch;
    const adapter = createGeminiAdapter({apiKey: 'test-key', fetchImpl});

    const first = await adapter.chat(
      [{role: 'user', content: 'call both tools'}],
      registry as any,
    );

    expect(first.toolCalls).toEqual([
      {id: 'gemini-0', name: 'without_provider_id', args: {value: 1}},
      {id: 'provider-call-2', name: 'with_provider_id', args: {value: 2}},
    ]);
    const calls = first.toolCalls as ToolCall[];
    const replay: ChatMessage[] = [
      {role: 'user', content: 'call both tools'},
      {
        role: 'assistant',
        content: '',
        toolCalls: calls,
        thinkingBlocks: first.thinking,
      },
      {
        role: 'tool',
        content: JSON.stringify({success: true, data: 'first'}),
        toolCallId: calls[0].id,
        toolName: calls[0].name,
      },
      {
        role: 'tool',
        content: JSON.stringify({success: true, data: 'second'}),
        toolCallId: calls[1].id,
        toolName: calls[1].name,
      },
    ];

    await adapter.chat(replay, registry as any);

    const contents = requests[1].contents;
    expect(contents[1].parts).toEqual([
      {functionCall: {name: 'without_provider_id', args: {value: 1}}},
      {functionCall: {id: 'provider-call-2', name: 'with_provider_id', args: {value: 2}}},
    ]);
    expect(contents[2].parts).toEqual([
      {
        functionResponse: {
          name: 'without_provider_id',
          response: {success: true, data: 'first'},
        },
      },
      {
        functionResponse: {
          id: 'provider-call-2',
          name: 'with_provider_id',
          response: {success: true, data: 'second'},
        },
      },
    ]);
  });
});

function response(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

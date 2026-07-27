import {runInteractiveAiRequest} from '../../src/commands/interactive.js';

const selected = {
  connectionId: 'connection-1',
  connectionName: 'Primary',
  provider: 'openrouter',
  model: 'safe/model',
  status: 'available' as const,
};

describe('connected-model CLI streaming', () => {
  test('interactive consumes successive deltas before the terminal event', async () => {
    const deltas: string[] = [];
    const client = {
      listAiModels: jest.fn().mockResolvedValue({
        statusCode: 200,
        data: {models: [selected]},
      }),
      generateAi: jest.fn(),
      generateAiStream: jest.fn(async function* () {
        yield {type: 'delta', text: 'first'} as const;
        yield {type: 'delta', text: ' second'} as const;
        yield {type: 'usage', inputTokens: 3, outputTokens: 2} as const;
        yield {type: 'completed', finishReason: 'stop'} as const;
      }),
    };

    const result = await runInteractiveAiRequest(client, {
      model: selected.model,
      prompt: '<system>private prompt</system>',
      stream: true,
      onDelta: delta => deltas.push(delta),
    });

    expect(deltas).toEqual(['first', ' second']);
    expect(result.response).toEqual({
      connectionId: selected.connectionId,
      model: selected.model,
      text: 'first second',
      finishReason: 'stop',
      usage: {inputTokens: 3, outputTokens: 2},
    });
    expect(client.generateAi).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private prompt');
  });

  test.each([
    'ai_stream_truncated',
    'ai_global_disabled',
    'ai_rate_limited',
    'ai_billing_blocked',
  ] as const)('surfaces the bounded terminal state %s', async code => {
    const client = {
      listAiModels: jest.fn().mockResolvedValue({
        statusCode: 200,
        data: {models: [selected]},
      }),
      generateAi: jest.fn(),
      generateAiStream: jest.fn(async function* () {
        yield {type: 'failed', code, statusCode: 503} as const;
      }),
    };
    await expect(runInteractiveAiRequest(client, {
      model: selected.model,
      prompt: 'private',
      stream: true,
    })).rejects.toThrow(`Connected model stream failed (${code}).`);
  });
});

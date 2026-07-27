import {runInteractiveAiRequest} from '../../src/commands/interactive.js';
import AiList from '../../src/commands/ai/list.js';
import AiStatus from '../../src/commands/ai/status.js';
import AiInvoke from '../../src/commands/ai/invoke.js';
import AiUsage from '../../src/commands/ai/usage.js';

describe('model connection interactive CLI transport', () => {
  const model = {
    connectionId: 'connection-1',
    connectionName: 'Primary',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6',
    status: 'available' as const,
  };

  it('lists, selects, and invokes through the same typed client without a credential field', async () => {
    const canary = 'sk-ai-gateway-canary-plaintext';
    const client = {
      listAiModels: jest.fn().mockResolvedValue({
        statusCode: 200,
        data: {models: [model], credentialHandle: canary},
      }),
      generateAi: jest.fn().mockResolvedValue({
        statusCode: 200,
        data: {
          response: {
            connectionId: model.connectionId,
            model: model.model,
            text: 'safe response',
            finishReason: 'stop',
            usage: {inputTokens: 3, outputTokens: 2},
          },
          secretReference: canary,
        },
      }),
    };

    const result = await runInteractiveAiRequest(client as never, {
      model: model.model,
      prompt: 'hello',
    });
    expect(result.selected).toEqual(model);
    expect(result.response?.text).toBe('safe response');
    expect(client.generateAi).toHaveBeenCalledWith({
      connectionId: model.connectionId,
      model: model.model,
      prompt: 'hello',
      maxOutputTokens: undefined,
    });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain('credentialHandle');
    expect(JSON.stringify(result)).not.toContain('secretReference');
  });

  it('exports the four stable named command contracts', () => {
    expect(AiList.requiredScope).toBe('ai:models:read');
    expect(AiStatus.requiredScope).toBe('ai:connections:use');
    expect(AiInvoke.requiredScope).toBe('ai:invoke');
    expect(AiUsage.requiredScope).toBe('ai:usage:read');
  });

  it('fails closed when selection is absent and never dispatches', async () => {
    const client = {
      listAiModels: jest.fn().mockResolvedValue({statusCode: 200, data: {models: []}}),
      generateAi: jest.fn(),
    };
    await expect(runInteractiveAiRequest(client as never, {
      model: 'missing/model',
      prompt: 'do not dispatch',
    })).rejects.toThrow('No eligible connected model matched');
    expect(client.generateAi).not.toHaveBeenCalled();
  });
});

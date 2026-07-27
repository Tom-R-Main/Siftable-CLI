import path from 'node:path';
import {Config} from '@oclif/core';
import {runInteractiveAiRequest} from '../../src/commands/interactive.js';
import Interactive from '../../src/commands/interactive.js';
import AiList from '../../src/commands/ai/list.js';
import AiStatus from '../../src/commands/ai/status.js';
import AiInvoke from '../../src/commands/ai/invoke.js';
import AiUsage from '../../src/commands/ai/usage.js';
import {BaseCommand} from '../../src/lib/base-command.js';
import {SiftClient} from '@siftable/mcp-server/dist/exfClient.js';
import {mockFetch, restoreFetch, runCommand} from '../helpers/mock-api';

async function runCommandEntry(
  CommandClass: new (argv: string[], config: Config) => {run(): Promise<unknown>},
  argv: string[],
): Promise<{stdout: string; error?: Error; exitCode: number}> {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalExitCode = process.exitCode;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  console.error = () => {};
  console.warn = () => {};
  let error: Error | undefined;
  let exitCode = 0;
  try {
    const config = await Config.load({
      root: path.join(__dirname, '..', '..'),
    });
    const command = new CommandClass(argv, config);
    await command.run();
    exitCode = process.exitCode ?? 0;
  } catch (caught) {
    error = caught as Error;
    exitCode = (caught as {oclif?: {exit?: number}}).oclif?.exit ?? 1;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    process.exitCode = originalExitCode;
  }
  return {stdout: lines.join('\n'), error, exitCode};
}

describe('model connection interactive CLI transport', () => {
  const model = {
    connectionId: 'connection-1',
    connectionName: 'Primary',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6',
    status: 'available' as const,
  };

  afterEach(() => {
    jest.restoreAllMocks();
    restoreFetch();
  });

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

  it('dispatches ai:list through the committed oclif manifest', async () => {
    mockFetch()
      .on('GET', '/api/v1/mcp/ai/models')
      .reply(200, {models: [model]})
      .install();

    const result = await runCommand(['ai', 'list', '--token', 'sift_pat_test']);

    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain(model.model);
  });

  it('binds CLI AI commands to the real MCP SiftClient transport', () => {
    const client = new SiftClient({
      apiUrl: 'https://siftable.test',
      pat: 'opaque-test-pat',
    });

    expect(client).toEqual(expect.objectContaining({
      listAiModels: expect.any(Function),
      getAiConnectionStatus: expect.any(Function),
      generateAi: expect.any(Function),
      getAiUsage: expect.any(Function),
    }));
  });

  it.each([
    {
      CommandClass: AiList,
      argv: ['--token', 'sift_pat_test'],
      method: 'listAiModels',
      response: {statusCode: 200, data: {models: [model]}},
      expected: 'claude-sonnet-4.6',
    },
    {
      CommandClass: AiStatus,
      argv: ['--token', 'sift_pat_test'],
      method: 'getAiConnectionStatus',
      response: {
        statusCode: 200,
        data: {
          connections: [{
            connectionId: model.connectionId,
            connectionName: model.connectionName,
            provider: model.provider,
            lifecycleStatus: 'active',
            validationStatus: 'valid',
            availableModelCount: 1,
          }],
        },
      },
      expected: 'active',
    },
    {
      CommandClass: AiUsage,
      argv: ['--token', 'sift_pat_test'],
      method: 'getAiUsage',
      response: {
        statusCode: 200,
        data: {
          usage: {
            periodStart: '2026-01-01T00:00:00.000Z',
            periodEnd: '2026-01-02T00:00:00.000Z',
            invocationCount: 1,
            inputTokens: '3',
            outputTokens: '2',
            siftableModelChargeMicros: '0',
            externalProviderCostMicros: '10',
          },
        },
      },
      expected: 'CALLS',
    },
  ])('executes the $method command entrypoint', async ({
    CommandClass,
    argv,
    method,
    response,
    expected,
  }) => {
    const client = {[method]: jest.fn().mockResolvedValue(response)};
    jest.spyOn(BaseCommand.prototype as never, 'client' as never)
      .mockResolvedValueOnce(client as never);

    const result = await runCommandEntry(CommandClass, argv);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(expected);
    expect(client[method as keyof typeof client]).toHaveBeenCalled();
  });

  it('executes named invoke and interactive run paths without surfacing request canaries', async () => {
    const prompt = '<system>create and execute a safe summary</system>';
    const credentialCanary = 'sk-provider-canary';
    const generated = {
      statusCode: 200,
      data: {
        response: {
          connectionId: model.connectionId,
          model: model.model,
          text: 'safe response',
          finishReason: 'stop',
          usage: {inputTokens: 3, outputTokens: 2},
        },
        credentialHandle: credentialCanary,
      },
    };
    const invokeClient = {
      generateAi: jest.fn().mockResolvedValue(generated),
    };
    jest.spyOn(BaseCommand.prototype as never, 'client' as never)
      .mockResolvedValueOnce(invokeClient as never);
    const invoked = await runCommandEntry(AiInvoke, [
      '--connection', model.connectionId,
      '--model', model.model,
      '--prompt', prompt,
      '--token', 'sift_pat_test',
    ]);

    expect(invoked.exitCode).toBe(0);
    expect(invokeClient.generateAi).toHaveBeenCalledWith(expect.objectContaining({prompt}));
    expect(invoked.stdout).toContain('safe response');
    expect(invoked.stdout).not.toContain(prompt);
    expect(invoked.stdout).not.toContain(credentialCanary);

    const interactiveClient = {
      listAiModels: jest.fn().mockResolvedValue({statusCode: 200, data: {models: [model]}}),
      generateAi: jest.fn().mockResolvedValue(generated),
    };
    jest.spyOn(BaseCommand.prototype as never, 'client' as never)
      .mockResolvedValueOnce(interactiveClient as never);
    const interactive = await runCommandEntry(Interactive, [
      '--connection', model.connectionId,
      '--model', model.model,
      '--prompt', prompt,
      '--token', 'sift_pat_test',
    ]);

    expect(interactive.exitCode).toBe(0);
    expect(interactiveClient.generateAi).toHaveBeenCalledWith(expect.objectContaining({prompt}));
    expect(interactive.stdout).toContain('safe response');
    expect(interactive.stdout).not.toContain(prompt);
    expect(interactive.stdout).not.toContain(credentialCanary);
  });

  it('bounds command error output without echoing server-provided canaries', async () => {
    const canary = 'sk-error-provider-canary';
    const client = {
      generateAi: jest.fn().mockResolvedValue({
        statusCode: 403,
        error: JSON.stringify({detail: `Required ai:invoke ${canary}`, prompt: canary}),
      }),
    };
    jest.spyOn(BaseCommand.prototype as never, 'client' as never)
      .mockResolvedValueOnce(client as never);

    const result = await runCommandEntry(AiInvoke, [
      '--connection', model.connectionId,
      '--model', model.model,
      '--prompt', '<system>execute test</system>',
      '--token', 'sift_pat_test',
    ]);
    const surface = `${result.stdout}\n${result.error?.message ?? ''}`;
    expect(result.exitCode).toBe(403);
    expect(surface).toContain('ai:invoke');
    expect(surface).not.toContain(canary);
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

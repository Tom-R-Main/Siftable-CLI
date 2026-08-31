// Vitest-native: this is the suite's only module-mock test, and it relied on
// CommonJS require() of TS modules + a synchronous jest.mock factory — both
// ts-jest idioms vite's ESM pipeline doesn't transform. Rather than contort it
// into a dual-runner shape (sync require vs async importActual have no shared
// form), it's authored against vitest and excluded from jest (see jest.config.js
// testPathIgnorePatterns). vi.mock is hoisted above the imports below.
import {describe, it, expect, vi} from 'vitest';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import type {AdapterResponse, AIAdapter, ChatMessage} from '../../interactive-tui/agent-harness/framework/adapters/types';
import type {ChatAgentConfig, ChatStreamChunk} from '../../interactive-tui/agent-harness/framework/chat-agent-types';
import {RunExecutionError} from '../../interactive-tui/agent-harness/framework/chat-agent-types';
import {mimeFromPath} from '../../interactive-tui/agent-harness/framework/adapters/content';
import {
  createOpenAIAdapter,
  createOpenRouterAdapter,
} from '../../interactive-tui/agent-harness/framework/adapters/openai';
import {createChatAgent} from '../../interactive-tui/agent-harness/framework/chat-agent';
import {createChatAgentHttpServer} from '../../interactive-tui/agent-harness/framework/chat-agent-http';
import {ToolRegistry} from '../../interactive-tui/agent-harness/framework/registry';
import type {SessionEventStore} from '../../interactive-tui/agent-harness/framework/session';
import {
  digestJson,
  InMemorySessionEventStore,
  SessionKernel,
} from '../../interactive-tui/agent-harness/framework/session';
import {defineTool, normalizeToolResult, ok} from '../../interactive-tui/agent-harness/framework/tool';

vi.mock('../../interactive-tui/agent-harness/framework/memory', () => ({
  createConversationMemory: vi.fn(),
  createFactMemory: vi.fn(),
  createMemoryTools: vi.fn(() => []),
}));

vi.mock('../../interactive-tui/agent-harness/framework/chat-agent-resolve', async () => {
  // The real ToolRegistry class is needed inside buildAgentRegistry; under vitest
  // that must come from importActual (async), not a sync require.
  const {ToolRegistry} = await vi.importActual<
    typeof import('../../interactive-tui/agent-harness/framework/registry')
  >('../../interactive-tui/agent-harness/framework/registry');
  return {
    resolveAdapter: vi.fn(),
    resolveContextProviders: vi.fn(async () => []),
    resolveSystemPrompt: vi.fn((config: {prompt?: string}) => config.prompt ?? 'You are a test assistant.'),
    buildAgentRegistry: vi.fn((config: Pick<ChatAgentConfig, 'tools'>) => {
      if (config.tools instanceof ToolRegistry) return config.tools;
      const registry = new ToolRegistry();
      if (Array.isArray(config.tools)) registry.registerAll(config.tools);
      return registry;
    }),
  };
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('Siftable agent-harness chat loop', () => {
  it('rejects orphan and mismatched terminal lifecycle events', () => {
    const session = new SessionKernel({sessionId: 'matched-lifecycle-test'});

    expect(() => session.append({
      type: 'step/completed',
      data: {outcome: 'completed'},
      stepId: 'never-started-step',
    })).toThrow('cannot complete step never-started-step: no matching step is open');
    expect(() => session.append({
      type: 'turn/completed',
      data: {assistantTurnComplete: true},
      turnId: 'never-started-turn',
    })).toThrow('cannot close turn never-started-turn: no matching turn is open');

    session.append({type: 'turn/started', data: {}, turnId: 'turn-a'});
    session.append({type: 'step/started', data: {index: 0}, turnId: 'turn-a', stepId: 'step-a'});
    expect(() => session.append({
      type: 'step/completed',
      data: {outcome: 'completed'},
      turnId: 'turn-b',
      stepId: 'step-a',
    })).toThrow('cannot complete step step-a: it is not open in turn turn-b');
  });

  it('fails closed on malformed truncation metadata in durable tool results', () => {
    const session = new SessionKernel({sessionId: 'output-metadata-validation-test'});
    const context = {turnId: 'turn-a', stepId: 'step-a'};
    const call = {id: 'call-malformed', name: 'big_output', args: {}};
    session.append({type: 'turn/started', data: {}, turnId: 'turn-a'});
    session.appendMessage({role: 'user', content: 'fetch'}, {turnId: 'turn-a'});
    session.append({type: 'step/started', data: {index: 0}, ...context});
    session.append({
      type: 'model/request-prepared',
      data: {
        history: {
          throughSeq: session.getEventCount(),
          messageCount: 1,
          sha256: digestJson([{role: 'user', content: 'fetch'}]),
        },
        systemPromptSha256: digestJson('test'),
        tools: {names: ['big_output'], sha256: digestJson(['big_output'])},
      },
      ...context,
    });
    session.append({type: 'model/response-received', data: {toolCall: call}, ...context});
    session.appendMessage({
      role: 'assistant',
      content: JSON.stringify(call.args),
      toolCallId: call.id,
      toolName: call.name,
    }, context);
    session.append({type: 'tool/call', data: {call}, ...context});
    session.append({type: 'tool/execution-started', data: {call}, ...context});

    const appendResult = (output: unknown, extra: Record<string, unknown> = {}) => () => session.append({
      type: 'tool/result',
      data: {
        toolCallId: call.id,
        toolName: call.name,
        outcome: 'succeeded',
        modelContent: 'preview',
        output,
        ...extra,
      } as never,
      ...context,
    });
    // Codex review repro: this exact shape must be rejected, not accepted.
    expect(appendResult({truncated: 'not-boolean', byteCount: -1, lineCount: 0, fullOutputRef: 123}))
      .toThrow('output metadata requires truncated=true');
    expect(appendResult({truncated: true, byteCount: -1, lineCount: 1}))
      .toThrow('byteCount must be a positive integer');
    // NaN is caught one layer earlier by the envelope's JSON sanitizer.
    expect(appendResult({truncated: true, byteCount: Number.NaN, lineCount: 1}))
      .toThrow('contains a non-finite number');
    expect(appendResult({truncated: true, byteCount: 2048, lineCount: 0}))
      .toThrow('lineCount must be a positive integer');
    expect(appendResult({truncated: true, byteCount: 2048, lineCount: 1, fullOutputRef: 123}))
      .toThrow('fullOutputRef');
    expect(appendResult('not-an-object')).toThrow('output metadata must be an object');
    expect(appendResult(
      {truncated: true, byteCount: 2048, lineCount: 1},
      {result: {success: true, data: {huge: 'blob'}}},
    )).toThrow('must not persist the full result');
    // Without modelContent the bounded receipt would vanish: recovery falls
    // back to bare outcome/error when result is (correctly) absent too.
    expect(appendResult(
      {truncated: true, byteCount: 2048, lineCount: 1},
      {modelContent: undefined},
    )).toThrow('must carry its bounded modelContent');

    // A well-formed truncated receipt is accepted.
    expect(appendResult({truncated: true, byteCount: 2048, lineCount: 1, fullOutputRef: '/tmp/x.json'})())
      .toMatchObject({type: 'tool/result'});
  });

  it('validates appends without rescanning the prior event array', () => {
    const session = new SessionKernel({sessionId: 'incremental-validation-test'});
    const internals = session as unknown as {events: unknown[]};
    let priorEventIndexReads = 0;
    internals.events = new Proxy(internals.events, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^(?:0|[1-9][0-9]*)$/.test(property)) {
          priorEventIndexReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    void internals.events[0];
    expect(priorEventIndexReads).toBe(1);
    priorEventIndexReads = 0;

    for (let index = 0; index < 128; index += 1) {
      session.replaceHistory([], `constant-size-event-${index}`);
    }

    expect(priorEventIndexReads).toBe(0);
    expect(session.getEventCount()).toBe(129);
  });

  it('rejects unsupported image extensions instead of mislabelling them as PNG', () => {
    expect(mimeFromPath('photo.PNG')).toBe('image/png');
    expect(mimeFromPath('photo.jpeg')).toBe('image/jpeg');
    expect(mimeFromPath('photo.webp')).toBe('image/webp');
    expect(() => mimeFromPath('photo.bmp')).toThrow('unsupported image file extension: .bmp');
    expect(() => mimeFromPath('photo')).toThrow('unsupported image file extension: (none)');
  });

  it('forwards the selected OpenAI reasoning effort without an incompatible temperature', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: 'response-1',
        output: [{
          type: 'message',
          content: [{type: 'output_text', text: 'ok'}],
        }],
      }), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      });
    }) as typeof fetch;
    const adapter = createOpenAIAdapter({
      apiKey: 'test-key',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      fetchImpl,
    });

    await adapter.chat([{role: 'user', content: 'hello'}], new ToolRegistry());

    expect(requestBody?.reasoning).toEqual({effort: 'high'});
    expect(requestBody).not.toHaveProperty('temperature');
  });

  it('caps GLM 5.3 Flash OpenRouter routes at the advertised Normal and Fast prices', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}],
      }), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      });
    }) as typeof fetch;

    for (const model of ['z-ai/glm-5.3-flash', 'z-ai/glm-5.3-flash:nitro']) {
      const adapter = createOpenRouterAdapter({apiKey: 'test-key', model, fetchImpl});
      await adapter.chat([{role: 'user', content: 'hello'}], new ToolRegistry());
    }

    expect(requestBodies.map(body => body.provider)).toEqual([
      {max_price: {prompt: 0.075, completion: 0.25}},
      {max_price: {prompt: 0.15, completion: 0.5}},
    ]);
  });

  it('uses the session journal as the model-history source of truth', async () => {
    const observedRequests: ChatMessage[][] = [];
    const adapter: AIAdapter = {
      name: 'journal-mock',
      model: 'journal-model',
      async chat(messages) {
        observedRequests.push(structuredClone(messages));
        return {text: 'journal answer'};
      },
    };
    const store = new InMemorySessionEventStore();
    const agent = await createChatAgent({
      adapter,
      memory: false,
      tools: [],
      session: {id: 'siftable-journal-test', store},
    });

    const result = await agent.chat('journal question');
    const events = agent.getSessionEvents();
    const request = events.find((event) => event.type === 'model/request-prepared');

    expect(result.text).toBe('journal answer');
    expect(result.run.status).toBe('completed');
    expect(result.run.manifest.model).toEqual({provider: 'journal-mock', model: 'journal-model'});
    expect(result.run.manifest.execution).toEqual({
      scheduling: {
        policyVersion: 'siftable.tool-scheduling/1',
        maxParallelTools: 4,
        failClosedMode: 'exclusive',
      },
      output: {
        policyVersion: 'siftable.tool-output/1',
        maxBytes: 50 * 1024,
        maxLines: 2000,
        spill: {
          enabled: false,
          maxBytes: 100 * 1024 * 1024,
          maxFiles: 256,
          maxAgeMs: 7 * 24 * 60 * 60 * 1000,
          orphanGraceMs: 5 * 60 * 1000,
        },
      },
    });
    expect(result.outcome).toMatchObject({runId: result.run.manifest.runId, output: 'journal answer'});
    expect(events.map((event) => event.type)).toEqual([
      'session/started',
      'turn/started',
      'message/appended',
      'step/started',
      'model/request-prepared',
      'model/response-received',
      'message/appended',
      'step/completed',
      'turn/completed',
    ]);
    expect(request?.type).toBe('model/request-prepared');
    if (request?.type === 'model/request-prepared') {
      expect(request.data.history.throughSeq).toBe(request.seq - 1);
      expect(request.data.history.messageCount).toBe(observedRequests[0]?.length);
      expect(request.data.history.sha256).toBe(digestJson(observedRequests[0]));
      expect('messages' in request.data).toBe(false);
      expect('systemPrompt' in request.data).toBe(false);
    }
    expect(agent.getHistory()).toEqual([
      {role: 'user', content: 'journal question'},
      {role: 'assistant', content: 'journal answer'},
    ]);
  });

  it('restores the recorded thread on reopen and rejects a conflicting thread id', async () => {
    const store = new InMemorySessionEventStore();
    const first = await createChatAgent({
      adapter: {
        name: 'first-mock',
        model: 'first-model',
        async chat() {
          return {text: 'answer one'};
        },
      },
      memory: false,
      tools: [],
      session: {id: 'durable-thread-reopen', threadId: 'thread-a', store},
    });
    await first.chat('question one');

    const observed: ChatMessage[][] = [];
    const reopened = await createChatAgent({
      adapter: {
        name: 'reopen-mock',
        model: 'reopen-model',
        async chat(messages) {
          observed.push(structuredClone(messages));
          return {text: 'answer two'};
        },
      },
      memory: false,
      tools: [],
      session: {id: 'durable-thread-reopen', store},
    });
    const result = await reopened.chat('question two');

    expect(result.metadata.threadId).toBe('thread-a');
    expect(observed[0]).toEqual([
      {role: 'user', content: 'question one'},
      {role: 'assistant', content: 'answer one'},
      {role: 'user', content: 'question two'},
    ]);
    await expect(createChatAgent({
      adapter: {
        name: 'conflict-mock',
        model: 'conflict-model',
        async chat() {
          return {text: 'must not run'};
        },
      },
      memory: false,
      tools: [],
      session: {id: 'durable-thread-reopen', threadId: 'thread-b', store},
    })).rejects.toThrow('session journal belongs to thread thread-a, not thread-b');
  });

  it('reopens a stably reset journal and deduplicates external inbox messages', async () => {
    const store = new InMemorySessionEventStore();
    const session = {id: 'stable-reset-reopen', threadId: 'stable-thread', store};
    const first = await createChatAgent({
      adapter: {
        name: 'stable-reset-first',
        model: 'test-model',
        async chat() {
          return {text: 'old answer'};
        },
      },
      memory: false,
      tools: [],
      session,
    });
    await first.chat('old question');
    await first.reset();
    await first.close();

    const reopened = await createChatAgent({
      adapter: {
        name: 'stable-reset-second',
        model: 'test-model',
        async chat() {
          return {text: 'unused'};
        },
      },
      memory: false,
      tools: [],
      session,
    });
    expect(reopened.getHistory()).toEqual([]);
    await expect(reopened.ingestExternalMessage('resume this child', {id: 'mail-1'})).resolves.toBe(true);
    await expect(reopened.ingestExternalMessage('duplicate', {id: 'mail-1'})).resolves.toBe(false);
    expect(reopened.getHistory()).toEqual([{role: 'user', content: 'resume this child'}]);
  });

  it('retains aligned continuation state and provider replay after an uncertain tool outcome', async () => {
    const observedStates: unknown[] = [];
    let call = 0;
    const unserializable = defineTool({
      name: 'unserializable_after_state',
      description: 'Returns a value that cannot be serialized into model history',
      inputSchema: {type: 'object', properties: {}},
      handler: async () => ok({value: 1n}),
    });
    const adapter: AIAdapter = {
      name: 'stateful-mock',
      model: 'stateful-model',
      sessionStateKey: 'stateful.responses',
      async chat(_messages, _registry, options) {
        observedStates.push(options?.sessionState);
        call += 1;
        if (call === 1) {
          return {
            text: 'first answer',
            sessionState: {
              key: 'stateful.responses',
              continuationId: 'continuation-a',
              fingerprint: 'stateful-fingerprint',
            },
            providerReplay: {
              key: 'stateful.responses',
              outputItems: [{type: 'message', id: 'message-a'}],
            },
          };
        }
        if (call === 2) {
          return {
            toolCall: {id: 'call-b', name: 'unserializable_after_state', args: {}},
            sessionState: {
              key: 'stateful.responses',
              continuationId: 'continuation-b',
              fingerprint: 'stateful-fingerprint',
            },
            providerReplay: {
              key: 'stateful.responses',
              outputItems: [{type: 'function_call', call_id: 'call-b'}],
            },
            continuationRecovery: {
              reason: 'missing_or_expired',
              failedContinuationId: 'expired-continuation',
            },
          };
        }
        return {text: 'third answer'};
      },
    };
    const agent = await createChatAgent({
      adapter,
      memory: false,
      tools: [unserializable],
    });

    await agent.chat('first');
    await expect(agent.chat('second')).rejects.toThrow(
      /outcomes are unknown; verify side effects before deciding whether any retry is safe/i,
    );
    await agent.chat('third');

    expect(observedStates[0]).toBeUndefined();
    expect(observedStates[1]).toEqual({
      key: 'stateful.responses',
      continuationId: 'continuation-a',
      fingerprint: 'stateful-fingerprint',
    });
    expect(observedStates[2]).toEqual({
      key: 'stateful.responses',
      continuationId: 'continuation-b',
      fingerprint: 'stateful-fingerprint',
    });
    const retainedHistory = agent.getHistory();
    expect(retainedHistory.slice(0, 4)).toEqual([
      {role: 'user', content: 'first'},
      {
        role: 'assistant',
        content: 'first answer',
        providerReplay: {
          key: 'stateful.responses',
          outputItems: [{type: 'message', id: 'message-a'}],
        },
      },
      {role: 'user', content: 'second'},
      {
        role: 'assistant',
        content: '{}',
        toolCallId: 'call-b',
        toolName: 'unserializable_after_state',
        providerReplay: {
          key: 'stateful.responses',
          outputItems: [{type: 'function_call', call_id: 'call-b'}],
        },
      },
    ]);
    expect(retainedHistory[4]?.role).toBe('tool');
    expect(retainedHistory[4]?.toolCallId).toBe('call-b');
    expect(String(retainedHistory[4]?.content)).toMatch(/outcome is unknown.*serializ/i);
    expect(retainedHistory.slice(5)).toEqual([
      {role: 'user', content: 'third'},
      {role: 'assistant', content: 'third answer'},
    ]);
    const events = agent.getSessionEvents();
    const stateUpdates = events.filter((event) => event.type === 'adapter/state-updated');
    expect(stateUpdates.map((event) => event.data.state.continuationId)).toEqual([
      'continuation-a',
      'continuation-b',
      'continuation-b',
    ]);
    expect(events.some((event) => event.type === 'adapter/state-cleared')).toBe(false);
    const responseEvent = events.filter(
      (event) => event.type === 'model/response-received',
    )[1];
    expect(responseEvent?.type).toBe('model/response-received');
    if (responseEvent?.type === 'model/response-received') {
      expect('sessionState' in responseEvent.data).toBe(false);
      expect(responseEvent.data.providerReplay).toEqual({
        key: 'stateful.responses',
        outputItems: [{type: 'function_call', call_id: 'call-b'}],
      });
      expect(responseEvent.data.continuationRecovery).toEqual({
        reason: 'missing_or_expired',
        failedContinuationId: 'expired-continuation',
      });
    }
  });

  it('keeps failed-turn evidence while restoring the active model projection', async () => {
    const adapter: AIAdapter = {
      name: 'failure-mock',
      model: 'failure-model',
      async chat() {
        throw new Error('simulated adapter failure');
      },
    };
    const agent = await createChatAgent({adapter, memory: false, tools: []});

    await expect(agent.chat('do not orphan me')).rejects.toThrow('simulated adapter failure');

    expect(agent.getHistory()).toEqual([]);
    const events = agent.getSessionEvents();
    expect(events.some((event) => event.type === 'message/appended')).toBe(true);
    expect(events.some((event) => event.type === 'history/replaced')).toBe(true);
    expect(events.at(-1)?.type).toBe('turn/failed');
  });

  it('serializes concurrent callers instead of racing shared history', async () => {
    let active = 0;
    let maxActive = 0;
    const adapter: AIAdapter = {
      name: 'serial-mock',
      model: 'serial-model',
      async chat(messages) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const latest = messages.at(-1);
        active -= 1;
        return {text: `answer:${String(latest?.content)}`};
      },
    };
    const agent = await createChatAgent({adapter, memory: false, tools: []});

    const [first, second] = await Promise.all([
      agent.chat('first'),
      agent.chat('second'),
    ]);

    expect(maxActive).toBe(1);
    expect(first.text).toBe('answer:first');
    expect(second.text).toBe('answer:second');
    expect(agent.getHistory().map((entry) => entry.content)).toEqual([
      'first',
      'answer:first',
      'second',
      'answer:second',
    ]);
  });

  it('closes an early stream return as an interruption and restores history', async () => {
    const store = new InMemorySessionEventStore();
    const adapter: AIAdapter = {
      name: 'early-close-mock',
      model: 'early-close-model',
      sessionStateKey: 'early-close.responses',
      async chat() {
        return {
          text: 'visible before close',
          sessionState: {
            key: 'early-close.responses',
            continuationId: 'continuation-before-close',
            fingerprint: 'early-close-fingerprint',
          },
        };
      },
    };
    const agent = await createChatAgent({
      adapter,
      memory: false,
      tools: [],
      session: {id: 'siftable-early-close-test', store},
    });

    const iterator = agent.chat('do not retain me', {stream: true})[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.type).toBe('text');
    await iterator.return?.();

    expect(agent.getHistory()).toEqual([]);
    const events = agent.getSessionEvents();
    const stepTerminal = events.findLast((event) => event.type === 'step/completed');
    expect(stepTerminal?.type).toBe('step/completed');
    if (stepTerminal?.type === 'step/completed') {
      expect(stepTerminal.data.outcome).toBe('interrupted');
    }
    expect(events.at(-3)?.type).toBe('history/replaced');
    expect(events.at(-2)?.type).toBe('adapter/state-cleared');
    expect(events.at(-1)?.type).toBe('turn/interrupted');

    const replayed = new SessionKernel({sessionId: 'siftable-early-close-test', store});
    expect(replayed.getAdapterSessionState('early-close.responses')).toBeUndefined();
    expect(replayed.recoverInterrupted()).toHaveLength(0);
  });

  it('restores state A and its replay projection after aborting state B', async () => {
    const observedStates: unknown[] = [];
    let call = 0;
    const adapter: AIAdapter = {
      name: 'abort-restore-mock',
      model: 'abort-restore-model',
      sessionStateKey: 'abort-restore.responses',
      async chat(_messages, _registry, options) {
        observedStates.push(options?.sessionState);
        call += 1;
        if (call === 1) {
          return {
            text: 'state A answer',
            sessionState: {
              key: 'abort-restore.responses',
              continuationId: 'state-a',
              fingerprint: 'abort-restore-fingerprint',
            },
            providerReplay: {
              key: 'abort-restore.responses',
              outputItems: [{type: 'message', id: 'message-a'}],
            },
          };
        }
        if (call === 2) {
          return {
            text: 'state B answer',
            sessionState: {
              key: 'abort-restore.responses',
              continuationId: 'state-b',
              fingerprint: 'abort-restore-fingerprint',
            },
            providerReplay: {
              key: 'abort-restore.responses',
              outputItems: [{type: 'message', id: 'message-b'}],
            },
          };
        }
        return {text: 'answer after abort'};
      },
    };
    const agent = await createChatAgent({adapter, memory: false, tools: []});
    await agent.chat('establish A');

    const controller = new AbortController();
    const iterator = agent.chat('attempt B', {
      stream: true,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({type: 'text', text: 'state B answer'});
    controller.abort(new Error('abort state B'));
    await expect(iterator.next()).rejects.toThrow('abort state B');

    await agent.chat('after abort');
    expect(observedStates).toEqual([
      undefined,
      {
        key: 'abort-restore.responses',
        continuationId: 'state-a',
        fingerprint: 'abort-restore-fingerprint',
      },
      {
        key: 'abort-restore.responses',
        continuationId: 'state-a',
        fingerprint: 'abort-restore-fingerprint',
      },
    ]);
    expect(agent.getHistory()).toEqual([
      {role: 'user', content: 'establish A'},
      {
        role: 'assistant',
        content: 'state A answer',
        providerReplay: {
          key: 'abort-restore.responses',
          outputItems: [{type: 'message', id: 'message-a'}],
        },
      },
      {role: 'user', content: 'after abort'},
      {role: 'assistant', content: 'answer after abort'},
    ]);
    const updates = agent.getSessionEvents().filter(
      (event) => event.type === 'adapter/state-updated',
    );
    expect(updates.map((event) => event.data.state.continuationId)).toEqual([
      'state-a',
      'state-b',
      'state-a',
    ]);
  });

  it('does not admit a pre-aborted turn', async () => {
    let adapterCalls = 0;
    const adapter: AIAdapter = {
      name: 'pre-abort-mock',
      model: 'pre-abort-model',
      async chat() {
        adapterCalls += 1;
        return {text: 'should not run'};
      },
    };
    const agent = await createChatAgent({adapter, memory: false, tools: []});
    const controller = new AbortController();
    controller.abort(new Error('cancel before admission'));

    await expect(agent.chat('never admit', {signal: controller.signal})).rejects.toThrow(
      'cancel before admission',
    );
    expect(adapterCalls).toBe(0);
    expect(agent.getHistory()).toEqual([]);
    expect(agent.getSessionEvents().map((event) => event.type)).toEqual(['session/started']);
  });

  it('removes an aborted queued turn without blocking later callers', async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    let adapterCalls = 0;
    const adapter: AIAdapter = {
      name: 'queued-abort-mock',
      model: 'queued-abort-model',
      async chat(messages) {
        adapterCalls += 1;
        if (adapterCalls === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return {text: `answer:${String(messages.at(-1)?.content)}`};
      },
    };
    const agent = await createChatAgent({adapter, memory: false, tools: []});
    const first = agent.chat('first');
    await firstStarted.promise;

    const controller = new AbortController();
    const cancelled = agent.chat('cancelled while queued', {signal: controller.signal});
    await nextEventLoopTurn();
    controller.abort(new Error('cancel queued turn'));
    await expect(cancelled).rejects.toThrow('cancel queued turn');
    expect(
      agent.getSessionEvents().filter((event) => event.type === 'turn/started'),
    ).toHaveLength(1);

    const third = agent.chat('third');
    releaseFirst.resolve();
    await expect(first).resolves.toMatchObject({text: 'answer:first'});
    await expect(third).resolves.toMatchObject({text: 'answer:third'});
    expect(adapterCalls).toBe(2);
  });

  it('waits for started tools before closing an aborted turn', async () => {
    const toolStarted = deferred<void>();
    const releaseTool = deferred<void>();
    const slow = defineTool({
      name: 'slow_abortable_boundary',
      description: 'Waits so cancellation can be observed at the harness boundary',
      inputSchema: {type: 'object', properties: {}},
      handler: async () => {
        toolStarted.resolve();
        await releaseTool.promise;
        return ok({finished: true});
      },
    });
    const adapter: AIAdapter = {
      name: 'tool-abort-mock',
      model: 'tool-abort-model',
      async chat() {
        return {
          toolCall: {id: 'call-abort', name: 'slow_abortable_boundary', args: {}},
        };
      },
    };
    const agent = await createChatAgent({adapter, tools: [slow], memory: false});
    const controller = new AbortController();
    let turnSettled = false;
    const turn = agent.chat('run and abort', {signal: controller.signal}).finally(() => {
      turnSettled = true;
    });
    await toolStarted.promise;
    controller.abort(new Error('stop after tool start'));
    await nextEventLoopTurn();
    expect(turnSettled).toBe(false);

    releaseTool.resolve();
    await expect(turn).rejects.toThrow('stop after tool start');
    const events = agent.getSessionEvents();
    const resultIndex = events.findIndex((event) => event.type === 'tool/result');
    const stepIndex = events.findIndex((event) => event.type === 'step/completed');
    const turnIndex = events.findIndex((event) => event.type === 'turn/interrupted');
    expect(resultIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeLessThan(stepIndex);
    expect(stepIndex).toBeLessThan(turnIndex);
    const step = events[stepIndex];
    expect(step?.type).toBe('step/completed');
    if (step?.type === 'step/completed') expect(step.data.outcome).toBe('interrupted');
    expect(agent.getHistory()).toEqual([
      {role: 'user', content: 'run and abort'},
      {
        role: 'assistant',
        content: '{}',
        toolCallId: 'call-abort',
        toolName: 'slow_abortable_boundary',
      },
      {
        role: 'tool',
        content: JSON.stringify({success: true, data: {finished: true}}),
        toolCallId: 'call-abort',
        toolName: 'slow_abortable_boundary',
      },
    ]);
  });

  it('settles every parallel tool execution before closing a failed turn', async () => {
    const slowStarted = deferred<void>();
    const releaseSlow = deferred<void>();
    const store = new InMemorySessionEventStore();
    const unserializable = defineTool({
      name: 'unserializable',
      description: 'Returns a value the event journal cannot encode',
      inputSchema: {type: 'object', properties: {}},
      handler: async () => ok({value: 1n}),
    });
    const slow = defineTool({
      name: 'slow',
      description: 'Waits for explicit release',
      inputSchema: {type: 'object', properties: {}},
      handler: async () => {
        slowStarted.resolve();
        await releaseSlow.promise;
        return ok({finished: true});
      },
    });
    const adapter: AIAdapter = {
      name: 'parallel-failure-mock',
      model: 'parallel-failure-model',
      async chat() {
        return {
          toolCalls: [
            {id: 'call-bad', name: 'unserializable', args: {}},
            {id: 'call-slow', name: 'slow', args: {}},
          ],
        };
      },
    };
    const agent = await createChatAgent({
      adapter,
      memory: false,
      tools: [unserializable, slow],
      session: {id: 'siftable-parallel-failure-test', store},
    });

    let turnSettled = false;
    const turn = agent.chat('run both').finally(() => {
      turnSettled = true;
    });
    await slowStarted.promise;
    await nextEventLoopTurn();
    expect(turnSettled).toBe(false);

    releaseSlow.resolve();
    await expect(turn).rejects.toThrow(
      /outcomes are unknown; verify side effects before deciding whether any retry is safe/i,
    );

    const events = agent.getSessionEvents();
    const results = events.filter((event) => event.type === 'tool/result');
    expect(results.map((event) => event.data.toolCallId).sort()).toEqual(['call-bad', 'call-slow']);
    expect(results.find((event) => event.data.toolCallId === 'call-bad')?.data.outcome).toBe('unknown');
    const lastResultIndex = Math.max(...results.map((event) => events.indexOf(event)));
    const stepTerminalIndex = events.findIndex((event) => event.type === 'step/completed');
    const turnTerminalIndex = events.findIndex((event) => event.type === 'turn/failed');
    expect(lastResultIndex).toBeLessThan(stepTerminalIndex);
    expect(stepTerminalIndex).toBeLessThan(turnTerminalIndex);
    const lengthAtFailure = events.length;
    await nextEventLoopTurn();
    expect(agent.getSessionEvents()).toHaveLength(lengthAtFailure);
    const retained = agent.getHistory();
    expect(retained.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
    ]);
    expect(retained[2]?.toolCallId).toBe('call-bad');
    expect(String(retained[2]?.content)).toMatch(/outcome is unknown.*serializ/i);
    expect(retained[3]?.toolCallId).toBe('call-slow');

    const replayed = new SessionKernel({sessionId: 'siftable-parallel-failure-test', store});
    expect(replayed.recoverInterrupted()).toHaveLength(0);
  });

  it('streams callId on tool chunks so parallel same-name calls stay correlated', async () => {
    const releaseFirst = deferred<void>();
    const echo = defineTool({
      name: 'echo',
      description: 'Echoes its tag; the first call finishes after the second',
      // The two calls block on each other, so they must actually run
      // concurrently — the fail-closed exclusive default would deadlock.
      executionMode: () => 'parallel-safe',
      inputSchema: {type: 'object', properties: {tag: {type: 'string'}}},
      handler: async ({tag}: {tag: string}) => {
        if (tag === 'first') {
          await releaseFirst.promise; // completes only after 'second' has finished
        } else {
          releaseFirst.resolve();
        }
        return ok({tag});
      },
    });
    let round = 0;
    const adapter: AIAdapter = {
      name: 'parallel-callid-mock',
      model: 'parallel-callid-model',
      async chat() {
        round += 1;
        if (round === 1) {
          return {
            toolCalls: [
              {id: 'call-first', name: 'echo', args: {tag: 'first'}},
              {id: 'call-second', name: 'echo', args: {tag: 'second'}},
            ],
          };
        }
        return {text: 'done'};
      },
    };
    const agent = await createChatAgent({
      adapter,
      memory: false,
      tools: [echo],
      session: {id: 'siftable-parallel-callid-test', store: new InMemorySessionEventStore()},
    });

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of agent.chat('run both', {stream: true})) chunks.push(chunk);

    const calls = chunks.filter((chunk) => chunk.type === 'tool_call');
    expect(calls.map((chunk) => chunk.toolCall)).toEqual([
      {name: 'echo', args: {tag: 'first'}, callId: 'call-first'},
      {name: 'echo', args: {tag: 'second'}, callId: 'call-second'},
    ]);
    // Executions completed in reverse order; each result chunk still carries
    // the id AND payload of its own call.
    const results = chunks.filter((chunk) => chunk.type === 'tool_result');
    expect(
      results.map((chunk) => [chunk.toolResult?.callId, (chunk.toolResult?.data as {tag?: string})?.tag]),
    ).toEqual([
      ['call-first', 'first'],
      ['call-second', 'second'],
    ]);
  });

  it('caps parallel-safe tools at maxParallelTools and serializes undeclared tools', async () => {
    let active = 0;
    let maxActiveParallel = 0;
    let maxActiveExclusive = 0;
    const probe = defineTool({
      name: 'probe_parallel',
      description: 'Records concurrent execution depth',
      executionMode: () => 'parallel-safe',
      inputSchema: {type: 'object', properties: {n: {type: 'number'}}},
      handler: async () => {
        active += 1;
        maxActiveParallel = Math.max(maxActiveParallel, active);
        await nextEventLoopTurn();
        await nextEventLoopTurn();
        active -= 1;
        return ok({});
      },
    });
    const undeclared = defineTool({
      name: 'probe_undeclared',
      description: 'No executionMode: must fail closed to exclusive',
      inputSchema: {type: 'object', properties: {n: {type: 'number'}}},
      handler: async () => {
        active += 1;
        maxActiveExclusive = Math.max(maxActiveExclusive, active);
        await nextEventLoopTurn();
        active -= 1;
        return ok({});
      },
    });
    let round = 0;
    const adapter: AIAdapter = {
      name: 'pool-cap-mock',
      model: 'pool-cap-model',
      async chat() {
        round += 1;
        if (round === 1) {
          return {
            toolCalls: [1, 2, 3, 4].map((n) => ({id: `p-${n}`, name: 'probe_parallel', args: {n}})),
          };
        }
        if (round === 2) {
          return {
            toolCalls: [1, 2, 3].map((n) => ({id: `x-${n}`, name: 'probe_undeclared', args: {n}})),
          };
        }
        return {text: 'done'};
      },
    };
    const agent = await createChatAgent({
      adapter,
      memory: false,
      tools: [probe, undeclared],
      maxParallelTools: 2,
    });
    const result = await agent.chat('exercise the pool');
    expect(maxActiveParallel).toBe(2); // capped, but actually concurrent
    expect(maxActiveExclusive).toBe(1); // fail-closed default is a barrier
    expect(result.run.manifest.execution?.scheduling).toEqual({
      policyVersion: 'siftable.tool-scheduling/1',
      maxParallelTools: 2,
      failClosedMode: 'exclusive',
    });
    expect(result.toolCalls.map(({callId, executionMode}) => ({callId, executionMode}))).toEqual([
      {callId: 'p-1', executionMode: 'parallel-safe'},
      {callId: 'p-2', executionMode: 'parallel-safe'},
      {callId: 'p-3', executionMode: 'parallel-safe'},
      {callId: 'p-4', executionMode: 'parallel-safe'},
      {callId: 'x-1', executionMode: 'exclusive'},
      {callId: 'x-2', executionMode: 'exclusive'},
      {callId: 'x-3', executionMode: 'exclusive'},
    ]);
  });

  it('abort stops admissions: started calls drain, never-started calls settle as cancelled', async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const startedTags: string[] = [];
    const slowPair = defineTool({
      name: 'slow_pair',
      description: 'First call blocks until released so the abort window is deterministic',
      executionMode: () => 'parallel-safe',
      inputSchema: {type: 'object', properties: {tag: {type: 'string'}}},
      handler: async ({tag}: {tag: string}) => {
        startedTags.push(tag);
        if (tag === 'first') {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return ok({tag});
      },
    });
    const adapter: AIAdapter = {
      name: 'cancel-admission-mock',
      model: 'cancel-admission-model',
      async chat() {
        return {
          toolCalls: [
            {id: 'call-ran', name: 'slow_pair', args: {tag: 'first'}},
            {id: 'call-never', name: 'slow_pair', args: {tag: 'second'}},
          ],
        };
      },
    };
    const agent = await createChatAgent({
      adapter,
      memory: false,
      tools: [slowPair],
      maxParallelTools: 1, // the second call must wait for the only slot
    });
    const controller = new AbortController();
    const turn = agent.chat('run and cancel', {signal: controller.signal});
    await firstStarted.promise;
    controller.abort(new Error('cancel mid-batch'));
    releaseFirst.resolve();
    const failure = await turn.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunExecutionError);
    expect((failure as RunExecutionError).message).toContain('cancel mid-batch');
    expect((failure as RunExecutionError).run.toolEffects?.receipts).toMatchObject([{
      callId: 'call-ran',
      name: 'slow_pair',
      executionMode: 'parallel-safe',
    }]);

    expect(startedTags).toEqual(['first']); // the second call never executed
    const events = agent.getSessionEvents();
    const results = events.filter((event) => event.type === 'tool/result');
    const ran = results.find((event) => event.data.toolCallId === 'call-ran');
    const never = results.find((event) => event.data.toolCallId === 'call-never');
    expect(ran?.data.outcome).toBe('succeeded');
    // The kernel's interruption repair closes the declared-but-never-started
    // call with a definitive failed receipt — NOT unknown, so it is safely
    // retryable — marked as recovered.
    expect(never?.data.outcome).toBe('failed');
    expect(never?.data.recovered).toBe(true);
    expect(String(never?.data.error)).toMatch(/did not start before recovery/i);
    // Both calls still have paired tool receipts in retained history.
    const retained = agent.getHistory();
    expect(retained.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(retained[2]?.toolCallId).toBe('call-ran');
    expect(retained[3]?.toolCallId).toBe('call-never');
    expect(String(retained[3]?.content)).toMatch(/did not start before recovery/i);
  });

  it('repairs a mixed completed/cancelled batch when a stream consumer closes at a result yield', async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const tool = defineTool({
      name: 'stream_return_tool',
      description: 'Creates a deterministic cancellation admission boundary',
      executionMode: () => 'parallel-safe',
      inputSchema: {type: 'object', properties: {tag: {type: 'string'}}},
      handler: async ({tag}: {tag: string}) => {
        if (tag === 'first') {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return ok({tag});
      },
    });
    let adapterCalls = 0;
    const adapter: AIAdapter = {
      name: 'stream-return-mock',
      model: 'stream-return-model',
      async chat() {
        adapterCalls += 1;
        if (adapterCalls === 1) {
          return {
            toolCalls: [
              {id: 'stream-ran', name: 'stream_return_tool', args: {tag: 'first'}},
              {id: 'stream-never', name: 'stream_return_tool', args: {tag: 'second'}},
            ],
          };
        }
        return {text: 'next turn works'};
      },
    };
    const store = new InMemorySessionEventStore();
    const agent = await createChatAgent({
      adapter,
      memory: false,
      tools: [tool],
      maxParallelTools: 1,
      session: {id: 'stream-return-recovery', store},
    });
    const controller = new AbortController();
    const iterator = agent.chat('start streamed batch', {
      stream: true,
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.toolCall?.callId).toBe('stream-ran');
    expect((await iterator.next()).value?.toolCall?.callId).toBe('stream-never');
    const resultChunk = iterator.next();
    await firstStarted.promise;
    controller.abort(new Error('cancel before second admission'));
    releaseFirst.resolve();
    expect((await resultChunk).value?.toolResult?.callId).toBe('stream-ran');

    await iterator.return?.();

    const events = agent.getSessionEvents();
    const recoveredNever = events.find((event) => (
      event.type === 'tool/result' && event.data.toolCallId === 'stream-never'
    ));
    expect(recoveredNever?.type).toBe('tool/result');
    if (recoveredNever?.type === 'tool/result') {
      expect(recoveredNever.data).toMatchObject({
        outcome: 'failed',
        recovered: true,
      });
    }
    expect(events.at(-1)).toMatchObject({
      type: 'turn/interrupted',
      data: {recovered: true},
    });
    expect(agent.getHistory().map((entry) => [entry.role, entry.toolCallId])).toEqual([
      ['user', undefined],
      ['assistant', undefined],
      ['tool', 'stream-ran'],
      ['tool', 'stream-never'],
    ]);
    expect(new SessionKernel({
      sessionId: 'stream-return-recovery',
      store,
    }).recoverInterrupted()).toHaveLength(0);

    const next = await agent.chat('continue after stream return');
    expect(next.text).toBe('next turn works');
  });

  it('bounds oversized tool output for the model and spills the full bytes', async () => {
    const spillRoot = await mkdtemp(join(tmpdir(), 'sift-chat-spill-'));
    try {
      const store = new InMemorySessionEventStore();
      const big = defineTool({
        name: 'big_output',
        description: 'Returns more data than the model-facing cap allows',
        inputSchema: {type: 'object', properties: {}},
        handler: async () => ok({blob: 'x'.repeat(100_000)}),
      });
      let round = 0;
      const adapter: AIAdapter = {
        name: 'big-output-mock',
        model: 'big-output-model',
        async chat() {
          round += 1;
          if (round === 1) return {toolCall: {id: 'call-big', name: 'big_output', args: {}}};
          return {text: 'done'};
        },
      };
      const agent = await createChatAgent({
        adapter,
        memory: false,
        tools: [big],
        session: {id: 'bounded-output-manifest', store},
        toolOutput: {
          maxBytes: 2048,
          spillDir: spillRoot,
          spillPolicy: {
            maxBytes: 200_000,
            maxFiles: 4,
            maxAgeMs: 60_000,
            orphanGraceMs: 0,
          },
        },
      });

      const chunks: ChatStreamChunk[] = [];
      for await (const chunk of agent.chat('fetch it all', {stream: true})) chunks.push(chunk);

      const toolMessage = agent.getHistory().find((message) => message.role === 'tool');
      const content = String(toolMessage?.content);
      expect(content).toContain('[tool output truncated:');
      expect(content).toContain('full output retained privately');
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(2048); // configured cap honored

      const resultEvent = agent.getSessionEvents().find((event) => event.type === 'tool/result');
      const output = (resultEvent?.data as {output?: {truncated?: boolean; fullOutputRef?: string; byteCount?: number}}).output;
      expect(output?.truncated).toBe(true);
      expect(output?.byteCount).toBeGreaterThan(100_000);
      expect(output?.fullOutputRef).toBeDefined();
      expect(content).not.toContain(output!.fullOutputRef!);
      expect(chunks.at(-1)?.result?.run.manifest.execution?.output).toEqual({
        policyVersion: 'siftable.tool-output/1',
        maxBytes: 2048,
        maxLines: 2000,
        spill: {
          enabled: true,
          maxBytes: 200_000,
          maxFiles: 4,
          maxAgeMs: 60_000,
          orphanGraceMs: 0,
        },
      });
      const spilled = await readFile(output!.fullOutputRef!, 'utf8');
      expect(spilled).toContain('x'.repeat(1000)); // complete bytes retained
      expect(Buffer.byteLength(spilled)).toBe(output!.byteCount!);

      // The DURABLE journal is bounded too: the full result lives only in
      // the spill file, never inside the persisted event.
      expect(resultEvent?.data.result).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(resultEvent?.data))).toBeLessThanOrEqual(8192);

      // The stream preview matches what the model saw; full data still flows to API consumers.
      const resultChunk = chunks.find((chunk) => chunk.type === 'tool_result');
      expect(resultChunk?.toolResult?.outputPreview).toBe(content);
      expect((resultChunk?.toolResult?.data as {blob?: string})?.blob?.length).toBe(100_000);

      // A reopened agent derives the journal's live refs before startup GC:
      // it removes a same-directory orphan without deleting referenced bytes.
      const orphan = join(dirname(output!.fullOutputRef!), 'spill-orphan.json');
      await writeFile(orphan, 'orphan', {mode: 0o600});
      await createChatAgent({
        adapter: {...adapter, async chat() { return {text: 'unused'}; }},
        memory: false,
        tools: [big],
        session: {id: 'bounded-output-manifest', store},
        toolOutput: {
          maxBytes: 2048,
          spillDir: spillRoot,
          spillPolicy: {
            maxBytes: 200_000,
            maxFiles: 4,
            maxAgeMs: 60_000,
            orphanGraceMs: 0,
          },
        },
      });
      expect(await readFile(output!.fullOutputRef!, 'utf8')).toBe(spilled);
      expect(await readdir(dirname(output!.fullOutputRef!))).not.toContain('spill-orphan.json');
    } finally {
      await rm(spillRoot, {recursive: true, force: true});
    }
  });

  it('retains a spill when append throws after durably committing its reference', async () => {
    const spillRoot = await mkdtemp(join(tmpdir(), 'sift-chat-spill-append-failure-'));
    try {
      const inner = new InMemorySessionEventStore();
      let failResultOnce = true;
      const store: SessionEventStore = {
        read: (sessionId) => inner.read(sessionId),
        append(event) {
          inner.append(event);
          if (failResultOnce && event.type === 'tool/result') {
            failResultOnce = false;
            throw new Error('tool result append outcome is ambiguous');
          }
        },
      };
      const big = defineTool({
        name: 'spill_append_failure',
        description: 'Creates a spill before the injected journal failure',
        inputSchema: {type: 'object', properties: {}},
        handler: async () => ok({blob: 'x'.repeat(100_000)}),
      });
      const agent = await createChatAgent({
        adapter: {
          name: 'spill-append-failure',
          model: 'spill-append-failure-model',
          async chat() {
            return {toolCall: {id: 'spill-failed-call', name: big.name, args: {}}};
          },
        },
        memory: false,
        tools: [big],
        session: {id: 'spill-append-failure', store},
        toolOutput: {maxBytes: 2048, spillDir: spillRoot},
      });

      await expect(agent.chat('run it')).rejects.toThrow('tool result append outcome is ambiguous');
      const committed = inner.read('spill-append-failure')
        .find((event) => event.type === 'tool/result');
      const fullOutputRef = (committed?.data as {output?: {fullOutputRef?: string}}).output?.fullOutputRef;
      expect(fullOutputRef).toBeDefined();
      expect(await readFile(fullOutputRef!, 'utf8')).toContain('x'.repeat(1000));
    } finally {
      await rm(spillRoot, {recursive: true, force: true});
    }
  });

  it('removes the session spill directory when the agent is destroyed', async () => {
    const spillRoot = await mkdtemp(join(tmpdir(), 'sift-chat-spill-destroy-'));
    const big = defineTool({
      name: 'spill_destroy_cleanup',
      description: 'Creates a spill owned by the destroyed session',
      inputSchema: {type: 'object', properties: {}},
      handler: async () => ok({blob: 'x'.repeat(100_000)}),
    });
    let round = 0;
    const agent = await createChatAgent({
      adapter: {
        name: 'spill-destroy-cleanup',
        model: 'spill-destroy-cleanup-model',
        async chat() {
          round += 1;
          return round === 1
            ? {toolCall: {id: 'spill-destroy-call', name: big.name, args: {}}}
            : {text: 'done'};
        },
      },
      memory: false,
      tools: [big],
      toolOutput: {maxBytes: 2048, spillDir: spillRoot},
    });

    await agent.chat('create retained output');
    expect(await readdir(spillRoot)).toHaveLength(1);
    await agent.destroy();
    expect(await readdir(spillRoot)).toEqual([]);
  });

  it('surfaces a spill cleanup refusal without deleting foreign data', async () => {
    const spillRoot = await mkdtemp(join(tmpdir(), 'sift-chat-spill-destroy-refusal-'));
    try {
      const big = defineTool({
        name: 'spill_destroy_refusal',
        description: 'Creates a spill beside a foreign file',
        inputSchema: {type: 'object', properties: {}},
        handler: async () => ok({blob: 'x'.repeat(100_000)}),
      });
      let round = 0;
      const agent = await createChatAgent({
        adapter: {
          name: 'spill-destroy-refusal',
          model: 'spill-destroy-refusal-model',
          async chat() {
            round += 1;
            return round === 1
              ? {toolCall: {id: 'spill-destroy-refusal-call', name: big.name, args: {}}}
              : {text: 'done'};
          },
        },
        memory: false,
        tools: [big],
        toolOutput: {maxBytes: 2048, spillDir: spillRoot},
      });

      await agent.chat('create retained output');
      const ownedDir = join(spillRoot, '.sift-tool-output-v1');
      const foreign = join(ownedDir, 'foreign.txt');
      await writeFile(foreign, 'keep me', {mode: 0o600});

      await expect(agent.destroy()).rejects.toThrow('Failed to remove');
      expect(await readFile(foreign, 'utf8')).toBe('keep me');
      expect((await readdir(ownedDir)).some((name) => name.endsWith('.json'))).toBe(true);
    } finally {
      await rm(spillRoot, {recursive: true, force: true});
    }
  });

  it('rejects non-integer or out-of-range parallelism and output caps at construction', async () => {
    const adapter: AIAdapter = {
      name: 'bounds-mock',
      model: 'bounds-model',
      async chat() {
        return {text: 'unused'};
      },
    };
    for (const maxParallelTools of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, 0]) {
      await expect(createChatAgent({adapter, memory: false, maxParallelTools}))
        .rejects.toThrow(/maxParallelTools must be an integer/);
    }
    await expect(createChatAgent({adapter, memory: false, toolOutput: {maxBytes: 64}}))
      .rejects.toThrow(/toolOutput\.maxBytes must be an integer >= 1024/);
    await expect(createChatAgent({adapter, memory: false, toolOutput: {maxLines: Number.NaN}}))
      .rejects.toThrow(/toolOutput\.maxLines must be an integer/);
  });

  it('serializes reset, deleteThread, and destroy behind active turns', async () => {
    for (const operation of ['reset', 'delete', 'destroy'] as const) {
      const started = deferred<void>();
      const response = deferred<AdapterResponse>();
      const adapter: AIAdapter = {
        name: `${operation}-queue-mock`,
        model: `${operation}-queue-model`,
        async chat() {
          started.resolve();
          return response.promise;
        },
      };
      const agent = await createChatAgent({adapter, memory: false, tools: []});
      const turn = agent.chat(`finish before ${operation}`);
      await started.promise;

      let lifecycleSettled = false;
      const lifecycle = (
        operation === 'reset'
          ? agent.resetAsync()
          : operation === 'delete'
            ? agent.deleteThreadAsync('missing')
            : agent.destroy()
      ).then((result) => {
        lifecycleSettled = true;
        return result;
      });
      await nextEventLoopTurn();
      expect(lifecycleSettled).toBe(false);

      response.resolve({text: 'finished'});
      await turn;
      const lifecycleResult = await lifecycle;
      if (operation === 'delete') expect(lifecycleResult).toBe(false);

      const types = agent.getSessionEvents().map((event) => event.type);
      if (operation === 'reset') {
        expect(types.indexOf('turn/completed')).toBeLessThan(types.indexOf('session/reset'));
        expect(agent.getHistory()).toEqual([]);
      }
      if (operation === 'destroy') {
        expect(types.indexOf('turn/completed')).toBeLessThan(types.indexOf('session/destroyed'));
        expect(types.at(-1)).toBe('session/destroyed');
      }
    }
  });

  it('recovers an uncertain tool outcome without retrying the tool', () => {
    const store = new InMemorySessionEventStore();
    const crashed = new SessionKernel({sessionId: 'recovery-session', store});
    const turnContext = {turnId: 'turn-1', correlationId: 'correlation-1'};
    const context = {...turnContext, stepId: 'step-1'};
    const call = {id: 'call-1', name: 'write_file', args: {path: 'result.txt'}};
    crashed.append({type: 'turn/started', data: {}, ...turnContext});
    crashed.appendMessage({role: 'user', content: 'write it'}, turnContext);
    crashed.append({type: 'step/started', data: {index: 0}, ...context});
    crashed.append({
      type: 'model/request-prepared',
      data: {
        history: {
          throughSeq: crashed.getEventCount(),
          messageCount: 1,
          sha256: digestJson([{role: 'user', content: 'write it'}]),
        },
        systemPromptSha256: digestJson('test'),
        tools: {names: ['write_file'], sha256: digestJson(['write_file'])},
      },
      ...context,
    });
    crashed.append({
      type: 'model/response-received',
      data: {toolCall: call},
      ...context,
    });
    crashed.appendMessage({
      role: 'assistant',
      content: JSON.stringify(call.args),
      toolCallId: call.id,
      toolName: call.name,
    }, context);
    crashed.append({type: 'tool/call', data: {call}, ...context});
    crashed.append({type: 'tool/execution-started', data: {call}, ...context});

    const recovered = new SessionKernel({sessionId: 'recovery-session', store});
    const recoveryEvents = recovered.recoverInterrupted('test process crashed');

    expect(recoveryEvents.map((event) => event.type)).toEqual([
      'tool/result',
      'message/appended',
      'step/completed',
      'turn/interrupted',
    ]);
    expect(recovered.getHistory().at(-1)).toMatchObject({
      role: 'tool',
      toolCallId: 'call-1',
      toolName: 'write_file',
    });
    expect(recovered.recoverInterrupted()).toHaveLength(0);
  });

  it('streams a final answer after tool-round exhaustion instead of the sentinel', async () => {
    const calls: Array<{
      messages: ChatMessage[];
      tools: string[];
      systemPrompt?: string;
      sessionState?: unknown;
    }> = [];
    const adapter: AIAdapter = {
      name: 'mock',
      model: 'mock-model',
      async chat(messages, registry: ToolRegistry, options) {
        calls.push({
          messages: [...messages],
          tools: registry.listNames(),
          systemPrompt: options?.systemPrompt,
          sessionState: options?.sessionState,
        });

        if (calls.length === 1) {
          return {
            toolCall: {
              id: 'tool-1',
              name: 'lookup_project',
              args: {query: 'missionaries in china'},
            },
            sessionState: {
              key: 'finalizer.responses',
              continuationId: 'tool-state',
              fingerprint: 'finalizer-fingerprint',
            },
            providerReplay: {
              key: 'finalizer.responses',
              outputItems: [{type: 'function_call', call_id: 'tool-1'}],
            },
          };
        }

        return {
          text: 'I checked the local project and found partial evidence about missionaries in China.',
          providerReplay: {
            key: 'finalizer.responses',
            outputItems: [{type: 'message', id: 'finalizer-message'}],
          },
        };
      },
      sessionStateKey: 'finalizer.responses',
    };

    const lookupProject = defineTool({
      name: 'lookup_project',
      description: 'Look up a local project',
      inputSchema: {
        type: 'object',
        properties: {
          query: {type: 'string'},
        },
        required: ['query'],
      },
      handler: async ({query}: {query: string}) => ok({query, files: ['README.md']}),
    });

    const agent = await createChatAgent({
      adapter,
      tools: [lookupProject],
      memory: false,
      maxToolRounds: 1,
      prompt: 'You are a test assistant.',
    });

    const chunks = [];
    for await (const chunk of agent.chat('scour the missionaries in china project', {stream: true})) {
      chunks.push(chunk);
    }

    const text = chunks.map((chunk) => chunk.text ?? '').join('');
    expect(text).toContain('partial evidence');
    expect(text).not.toContain('exceeded max tool calling rounds');
    expect(calls).toHaveLength(2);
    expect(calls[0].tools).toContain('lookup_project');
    expect(calls[1].tools).toEqual([]);
    expect(calls[1].systemPrompt).toContain('Do not call more tools');
    expect(calls[1].sessionState).toEqual({
      key: 'finalizer.responses',
      continuationId: 'tool-state',
      fingerprint: 'finalizer-fingerprint',
    });
    expect(agent.getHistory()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        providerReplay: {
          key: 'finalizer.responses',
          outputItems: [{type: 'function_call', call_id: 'tool-1'}],
        },
      }),
      expect.objectContaining({
        role: 'assistant',
        content: 'I checked the local project and found partial evidence about missionaries in China.',
        providerReplay: {
          key: 'finalizer.responses',
          outputItems: [{type: 'message', id: 'finalizer-message'}],
        },
      }),
    ]));
  });

  it('retains tool receipts and the aligned continuation when the finalizer is empty', async () => {
    let effectCount = 0;
    const calls: Array<{
      messages: ChatMessage[];
      tools: string[];
      sessionState?: unknown;
    }> = [];
    const toolState = {
      key: 'empty-finalizer.responses',
      continuationId: 'tool-state',
      fingerprint: digestJson('tool-state'),
    };
    const adapter: AIAdapter = {
      name: 'empty-finalizer-mock',
      model: 'empty-finalizer-model',
      sessionStateKey: toolState.key,
      async chat(messages, registry: ToolRegistry, options) {
        calls.push({
          messages: structuredClone(messages),
          tools: registry.listNames(),
          sessionState: structuredClone(options?.sessionState),
        });
        if (calls.length === 1) {
          return {
            toolCall: {id: 'effect-1', name: 'perform_effect', args: {}},
            sessionState: toolState,
            providerReplay: {
              key: toolState.key,
              outputItems: [{type: 'function_call', call_id: 'effect-1'}],
            },
          };
        }
        if (calls.length === 2) {
          return {
            sessionState: {
              ...toolState,
              continuationId: 'empty-finalizer-state',
            },
          };
        }
        return {text: 'The prior effect is still recorded.'};
      },
    };
    const performEffect = defineTool({
      name: 'perform_effect',
      description: 'Perform one observable test effect',
      inputSchema: {type: 'object', properties: {}},
      handler: async () => {
        effectCount += 1;
        return ok({effectCount});
      },
    });
    const agent = await createChatAgent({
      adapter,
      tools: [performEffect],
      memory: false,
      maxToolRounds: 1,
    });

    const limited = await agent.chat('perform it');
    expect(limited.text).toBe('(tool round limit reached before the model produced a final answer)');
    expect(limited.run.status).toBe('limit_reached');
    expect(limited.outcome).toBeUndefined();
    expect(limited.run.toolEffects).toMatchObject({
      state: 'partial',
      certainty: 'known',
      receipts: [{
        name: 'perform_effect',
        result: {success: true, executionOutcome: 'succeeded'},
      }],
    });
    expect(effectCount).toBe(1);
    expect(agent.getHistory().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);

    await agent.chat('what happened?');
    expect(calls[2].messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    expect(calls[2].sessionState).toEqual(toolState);
  });

  it('rejects malformed adapter tool calls before executing any handler and recovers next turn', async () => {
    let adapterCalls = 0;
    let handlerCalls = 0;
    const tool = defineTool({
      name: 'validated_boundary',
      description: 'Confirms adapter calls are validated before execution',
      inputSchema: {type: 'object', properties: {}},
      handler: async () => {
        handlerCalls += 1;
        return ok({handlerCalls});
      },
    });
    const agent = await createChatAgent({
      adapter: {
        name: 'malformed-adapter',
        model: 'malformed-model',
        async chat() {
          adapterCalls += 1;
          if (adapterCalls === 1) {
            return {
              toolCalls: [
                {id: 'duplicate', name: tool.name, args: {}},
                {id: 'duplicate', name: tool.name, args: {}},
              ],
            };
          }
          return {text: 'recovered'};
        },
      },
      tools: [tool],
      memory: false,
    });

    await expect(agent.chat('invalid turn')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(RunExecutionError);
      expect((error as RunExecutionError).run.status).toBe('failed');
      expect((error as Error).message).toMatch(/duplicate tool call id/i);
      return true;
    });
    expect(handlerCalls).toBe(0);
    expect(agent.getHistory()).toEqual([]);
    await expect(agent.chat('next turn')).resolves.toMatchObject({text: 'recovered'});
  });

  it('normalizes a tool result once across receipts, journal, and model history', async () => {
    const deceptiveResult = {
      success: true,
      executionOutcome: 'succeeded' as const,
      toJSON() {
        return {
          success: false,
          error: 'serialized result requires verification',
          executionOutcome: 'unknown' as const,
          data: {source: 'serialized'},
        };
      },
    };
    expect(normalizeToolResult('deceptive_result', deceptiveResult)).toEqual({
      result: {
        success: false,
        error: 'serialized result requires verification',
        executionOutcome: 'unknown',
        data: {source: 'serialized'},
      },
      modelContent: JSON.stringify({
        success: false,
        error: 'serialized result requires verification',
        executionOutcome: 'unknown',
        data: {source: 'serialized'},
      }),
      outcome: 'unknown',
    });
    const tool = defineTool({
      name: 'deceptive_result',
      description: 'Returns a result transformed by the JSON boundary',
      inputSchema: {type: 'object', properties: {}},
      handler: async () => deceptiveResult,
    });
    const agent = await createChatAgent({
      adapter: {
        name: 'normalization-adapter',
        model: 'normalization-model',
        async chat() {
          return {toolCall: {id: 'deceptive-call', name: tool.name, args: {}}};
        },
      },
      tools: [tool],
      memory: false,
    });

    await expect(agent.chat('run it')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(RunExecutionError);
      expect((error as RunExecutionError).toolEffects).toMatchObject({
        certainty: 'unknown',
        receipts: [{
          name: tool.name,
          result: {
            success: false,
            data: {source: 'serialized'},
            error: 'serialized result requires verification',
            executionOutcome: 'unknown',
          },
        }],
      });
      return true;
    });
    const event = agent.getSessionEvents().find(
      (candidate) => candidate.type === 'tool/result' && candidate.data.toolCallId === 'deceptive-call',
    );
    expect(event?.type).toBe('tool/result');
    if (event?.type !== 'tool/result') return;
    expect(event.data.outcome).toBe('unknown');
    expect(JSON.parse(event.data.modelContent ?? '')).toEqual(event.data.result);
    expect(agent.getHistory().find(
      (message) => message.role === 'tool' && message.toolCallId === 'deceptive-call',
    )?.content).toBe(event.data.modelContent);
  });

  it('returns 409 with safe receipt metadata when an HTTP chat fails after a committed effect', async () => {
    let adapterCalls = 0;
    let effectCount = 0;
    const inputSecret = 'http-input-secret-7be2ac';
    const resultSecret = 'http-result-secret-3fd184';
    const errorSecret = 'http-error-secret-8a71c9';
    const effect = defineTool({
      name: 'http_known_partial_effect',
      description: 'Performs one known effect before an adapter failure',
      inputSchema: {
        type: 'object',
        properties: {payload: {type: 'string'}},
        required: ['payload'],
      },
      handler: async () => {
        effectCount += 1;
        return ok({effectCount, confirmation: resultSecret});
      },
    });
    const agent = await createChatAgent({
      adapter: {
        name: 'http-known-partial',
        model: 'test-model',
        async chat() {
          adapterCalls += 1;
          if (adapterCalls === 1) {
            return {toolCall: {id: 'http-effect', name: effect.name, args: {payload: inputSecret}}};
          }
          throw new Error(`adapter failed authorization=${errorSecret}`);
        },
      },
      tools: [effect],
      memory: false,
    });
    const server = createChatAgentHttpServer(agent);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server did not bind');
      const response = await fetch(`http://127.0.0.1:${address.port}/chat`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({message: 'perform effect'}),
      });
      const serialized = await response.text();
      const body = JSON.parse(serialized) as {
        retryable?: boolean;
        toolEffects?: {state: string; certainty: string; receipts: unknown[]};
        run?: {toolEffects?: {state: string; certainty: string; receipts: unknown[]}};
      };
      expect(response.status).toBe(409);
      expect(body.retryable).toBe(false);
      expect(serialized).not.toContain(inputSecret);
      expect(serialized).not.toContain(resultSecret);
      expect(serialized).not.toContain(errorSecret);
      expect(body.toolEffects).toEqual({
        state: 'partial',
        certainty: 'known',
        receipts: [{
          callId: 'http-effect',
          name: effect.name,
          executionMode: 'exclusive',
          result: {
            success: true,
            executionOutcome: 'succeeded',
          },
        }],
      });
      expect(body.run?.toolEffects).toEqual(body.toolEffects);
      expect(effectCount).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  });

  it('emits only safe receipt metadata when an SSE chat fails after a committed effect', async () => {
    let adapterCalls = 0;
    const inputSecret = 'sse-input-secret-45f0e1';
    const resultSecret = 'sse-result-secret-9c86a4';
    const errorSecret = 'sse-error-secret-c1ad73';
    const effect = defineTool({
      name: 'sse_known_partial_effect',
      description: 'Performs one known effect before a streaming adapter failure',
      inputSchema: {
        type: 'object',
        properties: {payload: {type: 'string'}},
        required: ['payload'],
      },
      handler: async () => ok({confirmation: resultSecret}),
    });
    const agent = await createChatAgent({
      adapter: {
        name: 'sse-known-partial',
        model: 'test-model',
        async chat() {
          adapterCalls += 1;
          if (adapterCalls === 1) {
            return {toolCall: {id: 'sse-effect', name: effect.name, args: {payload: inputSecret}}};
          }
          throw new Error(`streaming adapter failed authorization=${errorSecret}`);
        },
      },
      tools: [effect],
      memory: false,
    });
    const server = createChatAgentHttpServer(agent);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server did not bind');
      const response = await fetch(`http://127.0.0.1:${address.port}/chat/stream`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({message: 'perform streaming effect'}),
      });
      const serialized = await response.text();
      expect(response.status).toBe(200);
      expect(serialized).toContain('event: error');
      const errorFrame = serialized.split('\n\n').find((frame) => frame.startsWith('event: error'));
      expect(errorFrame).toBeDefined();
      expect(errorFrame).not.toContain(inputSecret);
      expect(errorFrame).not.toContain(resultSecret);
      expect(errorFrame).not.toContain(errorSecret);
      const dataLine = errorFrame!.split('\n').find((line) => line.startsWith('data: '));
      expect(dataLine).toBeDefined();
      const body = JSON.parse(dataLine!.slice('data: '.length));
      expect(body.toolEffects).toEqual({
        state: 'partial',
        certainty: 'known',
        receipts: [{
          callId: 'sse-effect',
          name: effect.name,
          executionMode: 'exclusive',
          result: {success: true, executionOutcome: 'succeeded'},
        }],
      });
      expect(body.run.toolEffects).toEqual(body.toolEffects);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  });

  it('retains known partial effects when turn completion journaling fails', async () => {
    const inner = new InMemorySessionEventStore();
    let failCompletionOnce = true;
    const store: SessionEventStore = {
      read: (sessionId) => inner.read(sessionId),
      append(event) {
        if (failCompletionOnce && event.type === 'turn/completed') {
          failCompletionOnce = false;
          throw new Error('turn completion journal failed once');
        }
        inner.append(event);
      },
    };
    let effectCount = 0;
    let adapterCalls = 0;
    const effect = defineTool({
      name: 'completion_commit_effect',
      description: 'Performs an effect before the completion commit',
      inputSchema: {type: 'object', properties: {}},
      handler: async () => {
        effectCount += 1;
        return ok({effectCount});
      },
    });
    const agent = await createChatAgent({
      adapter: {
        name: 'completion-commit',
        model: 'completion-model',
        async chat() {
          adapterCalls += 1;
          return adapterCalls === 1
            ? {toolCall: {id: 'completion-call', name: effect.name, args: {}}}
            : {text: 'not durably completed'};
        },
      },
      tools: [effect],
      memory: false,
      session: {id: 'completion-commit-regression', store},
    });

    await expect(agent.chat('perform then answer')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(RunExecutionError);
      const structured = error as RunExecutionError;
      expect(structured.message).toMatch(/turn completion journal failed once/);
      expect(structured.run.status).toBe('failed');
      expect(structured.toolEffects).toMatchObject({
        state: 'partial',
        certainty: 'known',
        receipts: [{name: effect.name, result: {success: true, executionOutcome: 'succeeded'}}],
      });
      return true;
    });
    expect(effectCount).toBe(1);
    expect(agent.getSessionEvents().some((event) => event.type === 'turn/completed')).toBe(false);
    expect(agent.getSessionEvents().at(-1)?.type).toBe('turn/failed');
  });

  it('does not poison the next turn when step admission journaling fails', async () => {
    const inner = new InMemorySessionEventStore();
    let failStepOnce = true;
    const store: SessionEventStore = {
      read: (sessionId) => inner.read(sessionId),
      append(event) {
        if (failStepOnce && event.type === 'step/started') {
          failStepOnce = false;
          throw new Error('step admission journal failed once');
        }
        inner.append(event);
      },
    };
    let adapterCalls = 0;
    const agent = await createChatAgent({
      adapter: {
        name: 'step-admission',
        model: 'step-model',
        async chat() {
          adapterCalls += 1;
          return {text: 'second turn succeeded'};
        },
      },
      tools: [],
      memory: false,
      session: {id: 'step-admission-regression', store},
    });

    await expect(agent.chat('first')).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(RunExecutionError);
      expect((error as Error).message).toMatch(/step admission journal failed once/);
      return true;
    });
    expect(adapterCalls).toBe(0);
    expect(agent.getSessionEvents().at(-1)?.type).toBe('turn/failed');
    await expect(agent.chat('second')).resolves.toMatchObject({text: 'second turn succeeded'});
    expect(adapterCalls).toBe(1);
  });

  it('redacts tool input values from executor error logs', async () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'redacted_failure',
      description: 'Fails without logging caller input values',
      inputSchema: {
        type: 'object',
        properties: {token: {type: 'string'}},
        required: ['token'],
      },
      handler: async () => {
        throw new Error('simulated failure');
      },
    }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await registry.execute('redacted_failure', {token: 'super-secret-value'});
      expect(result).toMatchObject({
        success: false,
        error: 'simulated failure',
        executionOutcome: 'unknown',
      });
      expect(JSON.stringify(result)).not.toContain('super-secret-value');
      const output = error.mock.calls.flat().join('\n');
      expect(output).toContain('Input keys: token');
      expect(output).not.toContain('super-secret-value');
      expect(output).toContain('outcome is unknown');
    } finally {
      error.mockRestore();
    }
  });
});

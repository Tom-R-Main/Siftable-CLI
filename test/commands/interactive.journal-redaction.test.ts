import type {AIAdapter, ChatMessage} from '../../interactive-tui/agent-harness/framework/adapters/types';
import {createChatAgent} from '../../interactive-tui/agent-harness/framework/chat-agent';
import {
  redactSensitiveText,
  sanitizeSensitiveValue,
} from '../../interactive-tui/agent-harness/framework/redaction';
import {ToolRegistry} from '../../interactive-tui/agent-harness/framework/registry';
import {
  InMemorySessionEventStore,
  SessionKernel,
} from '../../interactive-tui/agent-harness/framework/session';
import {defineTool, ok} from '../../interactive-tui/agent-harness/framework/tool';

describe('agent-harness durable privacy boundaries', () => {
  it('preserves ordinary lookalike fields and serializes known non-plain values', () => {
    class OpaqueResult {}
    const secret = 'map-secret-must-not-persist';
    const sanitized = sanitizeSensitiveValue({
      tokens: ['input', 'output'],
      tokenCount: 2,
      keys: ['alpha'],
      keyword: 'tokenization',
      circleCiToken: secret,
      authorizationHeader: secret,
      cookieHeader: secret,
      apiKeyValue: secret,
      clientSecretValue: secret,
      recordedAt: new Date('2026-08-25T12:00:00.000Z'),
      metadata: new Map([
        ['visible', 'retained'],
        ['apiKey', secret],
      ]),
      labels: new Set(['one', 'two']),
      matcher: /retained/giu,
      opaque: new OpaqueResult(),
    });

    expect(sanitized).toEqual({
      tokens: ['input', 'output'],
      tokenCount: 2,
      keys: ['alpha'],
      keyword: 'tokenization',
      circleCiToken: '[REDACTED]',
      authorizationHeader: '[REDACTED]',
      cookieHeader: '[REDACTED]',
      apiKeyValue: '[REDACTED]',
      clientSecretValue: '[REDACTED]',
      recordedAt: '2026-08-25T12:00:00.000Z',
      metadata: [
        ['visible', 'retained'],
        ['apiKey', '[REDACTED]'],
      ],
      labels: ['one', 'two'],
      matcher: '/retained/giu',
      opaque: '[OpaqueResult]',
    });
    expect(redactSensitiveText(
      'tokens: 2 tokenCount: 2 keys: alpha keyword: tokenization circle_ci_token: hidden',
    )).toBe(
      'tokens: 2 tokenCount: 2 keys: alpha keyword: tokenization circle_ci_token: [REDACTED]',
    );
    expect(redactSensitiveText(
      'authorizationHeader: Basic-Zm9v cookieHeader="part\\\"tail" apiKeyValue=visible-secret clientSecretValue=other-secret',
    )).toBe(
      'authorizationHeader: [REDACTED] cookieHeader="[REDACTED]" apiKeyValue=[REDACTED] clientSecretValue=[REDACTED]',
    );
  });

  it('redacts credential-shaped tool results before model, receipt, and journal boundaries', async () => {
    const secrets = {
      field: 'field-secret-must-not-persist',
      bearer: 'bearer-secret-must-not-persist',
      env: 'sk-proj-1234567890abcdefghijklmnop',
      query: 'query-secret-must-not-persist',
      objectKey: 'github_pat_1234567890abcdefghijklmnop',
      semicolonHeader: 'semicolon-header-secret-must-not-persist',
      semicolonToken: 'semicolon-token-secret-must-not-persist',
    };
    const observedRequests: ChatMessage[][] = [];
    let adapterCalls = 0;
    const adapter: AIAdapter = {
      name: 'journal-redaction-adapter',
      model: 'journal-redaction-model',
      async chat(messages) {
        observedRequests.push(structuredClone(messages));
        adapterCalls += 1;
        if (adapterCalls === 1) {
          return {toolCall: {id: 'sensitive-result-call', name: 'sensitive_result', args: {}}};
        }
        return {text: 'finished safely'};
      },
    };
    const tool = defineTool({
      name: 'sensitive_result',
      description: 'Returns representative credential-shaped output',
      inputSchema: {type: 'object', properties: {}},
      handler: async () => ok({
        token: secrets.field,
        credentialMap: {[secrets.objectKey]: 'secret appeared as an object key'},
        stdout: [
          `Authorization: Bearer ${secrets.bearer}`,
          `OPENAI_API_KEY=${secrets.env}`,
          `https://example.test/result?token=${secrets.query}`,
          `visible=ok;authorizationHeader=${secrets.semicolonHeader};circleCiToken=${secrets.semicolonToken}`,
          'ordinary output remains visible',
        ].join('\n'),
      }),
    });
    const store = new InMemorySessionEventStore();
    const agent = await createChatAgent({
      adapter,
      tools: [tool],
      memory: false,
      session: {id: 'journal-redaction-session', store},
    });

    const result = await agent.chat('run the sensitive tool');
    const serializedBoundaries = JSON.stringify({
      events: store.read('journal-redaction-session'),
      history: agent.getHistory(),
      observedRequests,
      result,
    });

    for (const secret of Object.values(secrets)) {
      expect(serializedBoundaries).not.toContain(secret);
    }
    expect(serializedBoundaries).toContain('[REDACTED]');
    expect(serializedBoundaries).toContain('visible=ok');
    expect(serializedBoundaries).toContain('ordinary output remains visible');
  });

  it('redacts credential-shaped executor errors before logging or returning them', async () => {
    const secret = 'executor-secret-must-not-escape';
    const stackSecret = 'executor-stack-secret-must-not-escape';
    const registry = new ToolRegistry();
    registry.register(defineTool({
      name: 'sensitive_failure',
      description: 'Throws a representative sensitive error',
      inputSchema: {type: 'object', properties: {}},
      handler: async () => {
        const error = new Error(`authorization=${secret}`);
        error.stack = `${error.name}: ${error.message}\n    at https://example.test/tool?token=${stackSecret}`;
        throw error;
      },
    }));
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const result = await registry.execute('sensitive_failure', {});
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).toContain('[REDACTED]');
      expect(logged.flat().join('\n')).not.toContain(secret);
      expect(logged.flat().join('\n')).not.toContain(stackSecret);
    } finally {
      console.error = originalError;
    }
  });

  it('redacts adapter failures before durable run and terminal records', async () => {
    const secret = 'adapter-error-secret-must-not-persist';
    const store = new InMemorySessionEventStore();
    const agent = await createChatAgent({
      adapter: {
        name: 'sensitive-adapter-error',
        model: 'sensitive-adapter-error-model',
        async chat() {
          throw new Error(`authorization=${secret}`);
        },
      },
      tools: [],
      memory: false,
      session: {id: 'adapter-error-redaction-session', store},
    });

    let failure: unknown;
    try {
      await agent.chat('trigger the adapter failure');
    } catch (error) {
      failure = error;
    }

    const serialized = JSON.stringify({
      events: store.read('adapter-error-redaction-session'),
      failure: failure instanceof Error
        ? {message: failure.message, run: (failure as Error & {run?: unknown}).run}
        : failure,
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
  });

  it('seeds legacy history before the first external mailbox event', async () => {
    const agent = await createChatAgent({
      adapter: {
        name: 'legacy-order-adapter',
        model: 'legacy-order-model',
        async chat() {
          return {text: 'unused'};
        },
      },
      tools: [],
      memory: false,
      session: {
        id: 'legacy-before-mailbox-session',
        store: new InMemorySessionEventStore(),
      },
    });
    const internals = agent as unknown as {
      ensureSeeded(): void;
      session: SessionKernel;
    };
    let eventCountAtSeed = -1;
    internals.ensureSeeded = () => {
      eventCountAtSeed = internals.session.getEventCount();
      if (eventCountAtSeed === 1) {
        internals.session.replaceHistory([
          {role: 'user', content: 'legacy question'},
          {role: 'assistant', content: 'legacy answer'},
        ], 'legacy_rollout_imported');
      }
    };

    await expect(agent.ingestExternalMessage(
      'mailbox instruction',
      {id: 'mailbox-after-upgrade'},
    )).resolves.toBe(true);

    expect(eventCountAtSeed).toBe(1);
    expect(agent.getHistory()).toEqual([
      {role: 'user', content: 'legacy question'},
      {role: 'assistant', content: 'legacy answer'},
      {role: 'user', content: 'mailbox instruction'},
    ]);
  });
});

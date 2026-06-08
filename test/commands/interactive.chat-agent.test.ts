// Vitest-native: this is the suite's only module-mock test, and it relied on
// CommonJS require() of TS modules + a synchronous jest.mock factory — both
// ts-jest idioms vite's ESM pipeline doesn't transform. Rather than contort it
// into a dual-runner shape (sync require vs async importActual have no shared
// form), it's authored against vitest and excluded from jest (see jest.config.js
// testPathIgnorePatterns). vi.mock is hoisted above the imports below.
import {describe, it, expect, vi} from 'vitest';
import type {AIAdapter, ChatMessage} from '../../interactive-tui/openfunction/framework/adapters/types';
import type {ToolRegistry} from '../../interactive-tui/openfunction/framework/registry';
import {createChatAgent} from '../../interactive-tui/openfunction/framework/chat-agent';
import {defineTool, ok} from '../../interactive-tui/openfunction/framework/tool';

vi.mock('../../interactive-tui/openfunction/framework/memory', () => ({
  createConversationMemory: vi.fn(),
  createFactMemory: vi.fn(),
  createMemoryTools: vi.fn(() => []),
}));

vi.mock('../../interactive-tui/openfunction/framework/chat-agent-resolve', async () => {
  // The real ToolRegistry class is needed inside buildAgentRegistry; under vitest
  // that must come from importActual (async), not a sync require.
  const {ToolRegistry} = await vi.importActual<
    typeof import('../../interactive-tui/openfunction/framework/registry')
  >('../../interactive-tui/openfunction/framework/registry');
  return {
    resolveAdapter: vi.fn(),
    resolveContextProviders: vi.fn(async () => []),
    resolveSystemPrompt: vi.fn((config: {prompt?: string}) => config.prompt ?? 'You are a test assistant.'),
    buildAgentRegistry: vi.fn((config: {tools?: unknown[] | InstanceType<typeof ToolRegistry>}) => {
      if (config.tools instanceof ToolRegistry) return config.tools;
      const registry = new ToolRegistry();
      if (Array.isArray(config.tools)) registry.registerAll(config.tools);
      return registry;
    }),
  };
});

describe('OpenFunction chat agent loop', () => {
  it('streams a final answer after tool-round exhaustion instead of the sentinel', async () => {
    const calls: Array<{messages: ChatMessage[]; tools: string[]; systemPrompt?: string}> = [];
    const adapter: AIAdapter = {
      name: 'mock',
      model: 'mock-model',
      async chat(messages, registry: ToolRegistry, options) {
        calls.push({
          messages: [...messages],
          tools: registry.listNames(),
          systemPrompt: options?.systemPrompt,
        });

        if (calls.length === 1) {
          return {
            toolCall: {
              id: 'tool-1',
              name: 'lookup_project',
              args: {query: 'missionaries in china'},
            },
          };
        }

        return {
          text: 'I checked the local project and found partial evidence about missionaries in China.',
        };
      },
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
  });
});

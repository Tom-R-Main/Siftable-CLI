import type {AIAdapter, ChatMessage} from '../../interactive-tui/openfunction/framework/adapters/types';
import type {ToolRegistry} from '../../interactive-tui/openfunction/framework/registry';

jest.mock('../../interactive-tui/openfunction/framework/memory', () => ({
  createConversationMemory: jest.fn(),
  createFactMemory: jest.fn(),
  createMemoryTools: jest.fn(() => []),
}));

jest.mock('../../interactive-tui/openfunction/framework/chat-agent-resolve', () => {
  const {ToolRegistry} = require('../../interactive-tui/openfunction/framework/registry');
  return {
    resolveAdapter: jest.fn(),
    resolveContextProviders: jest.fn(async () => []),
    resolveSystemPrompt: jest.fn((config: {prompt?: string}) => config.prompt ?? 'You are a test assistant.'),
    buildAgentRegistry: jest.fn((config: {tools?: unknown[] | typeof ToolRegistry}) => {
      if (config.tools instanceof ToolRegistry) return config.tools;
      const registry = new ToolRegistry();
      if (Array.isArray(config.tools)) registry.registerAll(config.tools);
      return registry;
    }),
  };
});

const {createChatAgent} = require('../../interactive-tui/openfunction/framework/chat-agent');
const {defineTool, ok} = require('../../interactive-tui/openfunction/framework/tool');

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

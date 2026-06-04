/**
 * Trimmed OpenFunction runtime entry for Siftable CLI.
 *
 * This intentionally exports only the runtime surface used by `sift interactive`.
 * The full OpenFunction repo has examples, server mode, RAG, PG stores, and
 * plugin bridges; those stay out of the public CLI package until the CLI uses
 * them directly.
 */

export {defineTool, ok, err} from "./tool.js";
export {ToolRegistry, registry} from "./registry.js";
export {composePrompt, autoToolGuide, loadPromptPreset, resolvePrompt, listPresets} from "./prompts.js";
export {createConversationMemory, createFactMemory, createMemoryTools} from "./memory.js";
export {connectProvider, contextPrompt, checkProviderHealth} from "./context.js";
export {createChatAgent} from "./chat-agent.js";

export type {Store} from "./store.js";
export type {PromptOptions} from "./prompts.js";
export type {Thread, Fact, ConversationMemory, FactMemory} from "./memory.js";
export type {
  ContextProvider,
  ConnectedProvider,
  ContextProviderMetadata,
  ContextCapability,
} from "./context.js";
export type {
  ChatAgent,
  ChatAgentConfig,
  ChatResult,
  ChatStreamChunk,
  ChatAgentChatOptions,
  ServeOptions,
  MemoryConfig,
  PeerConfig,
} from "./chat-agent-types.js";
export type {ChatContent, ContentPart, TextContentPart, ImageContentPart} from "./adapters/types.js";
export type {
  ToolDefinition,
  ToolResult,
  ToolExample,
  ToolTest,
  InputSchema,
  JsonSchemaProperty,
  GeminiFunctionDeclaration,
  AnthropicTool,
  OpenAIFunction,
} from "./types.js";

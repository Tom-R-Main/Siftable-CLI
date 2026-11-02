/**
 * Siftable Agent Harness — Tool Registry
 *
 * Manages all registered tools and provides format adapters for
 * different AI providers. Derived from ExecuFunction's ToolRegistry,
 * stripped down for simplicity.
 *
 * Key concept: you define your tools ONCE, and the registry makes them
 * available to any AI (Claude via MCP, Gemini via function calling,
 * OpenAI via tools API) without rewriting anything.
 */

import type {
  ToolDefinition,
  ToolResult,
  GeminiFunctionDeclaration,
  AnthropicTool,
  OpenAIFunction,
} from "./types.js";
import { validateParams, formatValidationErrors } from "./validate.js";
import { redactSensitiveText } from "./redaction.js";
import { assertExecutionActive, currentExecutionContext, withExecutionContext, type ToolExecutionContext } from './execution-context.js';
import { snapshotJson } from './session.js';

/**
 * What an owned registration does when one of its names is already taken.
 * - "keep-existing": skip that tool; the existing definition stays.
 * - "replace": install this tool; the displaced registration loses the name.
 * - "reject": install nothing from this registration and throw.
 */
export type ToolCollisionPolicy = "keep-existing" | "replace" | "reject";

/**
 * A set of tools one owner contributed. `names` lists only the tools this
 * registration actually installed. dispose() removes exactly those entries
 * that are still this registration's, so a late dispose cannot remove a
 * definition another owner installed under the same name.
 */
export interface ToolRegistration {
  readonly owner: string;
  readonly names: readonly string[];
  /** True until dispose() runs. A replaced name does not clear it. */
  readonly active: boolean;
  dispose(): void;
}

/** Reports whether a definition captured earlier is still the live one. */
export type ToolLiveness = () => boolean;

interface RegistryEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: ToolDefinition<any, any>;
  /** Present on snapshot entries: dispatch is refused once it reports false. */
  live?: ToolLiveness;
}

export class ToolRegistry {
  private tools: Map<string, RegistryEntry> = new Map();

  // ── Registration ─────────────────────────────────────────────────────────

  /**
   * Register a single tool.
   *
   * @param opts.overwrite When false, an existing tool with the same name
   *   wins — the new tool is skipped and a warning is logged. Used by the
   *   framework to register memory + context-provider tools without silently
   *   shadowing user tools of the same name. Default: true (back-compat).
   */
  register(
    tool: ToolDefinition<any, any>,
    opts: { overwrite?: boolean; live?: ToolLiveness } = {},
  ): void {
    if (this.tools.has(tool.name)) {
      if (opts.overwrite === false) {
        console.warn(
          `⚠️  Tool "${tool.name}" is already registered — keeping existing definition (skipping new one).`,
        );
        return;
      }
      console.warn(
        `⚠️  Tool "${tool.name}" is already registered — overwriting.`,
      );
    }
    this.tools.set(tool.name, { tool, ...(opts.live ? { live: opts.live } : {}) });
  }

  /**
   * Register tools on behalf of one owner and return a handle that removes
   * them. Under "reject", a collision installs nothing: a failed activation
   * leaves no partial contribution behind. Duplicate names inside one call
   * are always rejected.
   */
  registerOwned(
    owner: string,
    tools: ToolDefinition<any, any>[],
    opts: { onCollision?: ToolCollisionPolicy } = {},
  ): ToolRegistration {
    const policy = opts.onCollision ?? "reject";
    const seen = new Set<string>();
    for (const tool of tools) {
      if (seen.has(tool.name)) {
        throw new Error(`${owner} contributes tool "${tool.name}" more than once`);
      }
      seen.add(tool.name);
    }
    if (policy === "reject") {
      const taken = tools.filter((tool) => this.tools.has(tool.name)).map((tool) => tool.name);
      if (taken.length > 0) {
        throw new Error(`${owner} cannot register already-registered tool(s): ${taken.join(", ")}`);
      }
    }

    const installed = new Map<string, RegistryEntry>();
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        if (policy === "keep-existing") {
          console.warn(
            `⚠️  Tool "${tool.name}" is already registered — keeping existing definition (skipping ${owner}'s).`,
          );
          continue;
        }
        console.warn(`⚠️  Tool "${tool.name}" is already registered — ${owner} replaces it.`);
      }
      const entry: RegistryEntry = { tool };
      this.tools.set(tool.name, entry);
      installed.set(tool.name, entry);
    }

    let active = true;
    const registered = this.tools;
    return {
      owner,
      names: Object.freeze([...installed.keys()]),
      get active() {
        return active;
      },
      dispose() {
        if (!active) return;
        active = false;
        for (const [name, entry] of installed) {
          if (registered.get(name) === entry) registered.delete(name);
        }
      },
    };
  }

  /**
   * A probe that stays true while `name` still resolves to the definition
   * registered right now. Replacing or removing the tool turns it false.
   */
  liveness(name: string): ToolLiveness {
    const entry = this.tools.get(name);
    if (!entry) return () => false;
    const upstream = entry.live;
    return () => this.tools.get(name) === entry && (upstream?.() ?? true);
  }

  /** Register multiple tools at once. See register() for opts. */
  registerAll(
    tools: ToolDefinition<any, any>[],
    opts: { overwrite?: boolean } = {},
  ): void {
    for (const tool of tools) {
      this.register(tool, opts);
    }
  }

  /**
   * Remove a tool by name. Returns true if the tool existed and was
   * removed, false otherwise. Used by ChatAgent.destroy() to clean up
   * provider/memory tools so long-lived processes that create and
   * destroy agents don't accumulate ghost tools in shared registries.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  // ── Lookup ───────────────────────────────────────────────────────────────

  /** Get a tool by name */
  get(name: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(name)?.tool;
  }

  /** Get all registered tools */
  getAll(): ToolDefinition<any, any>[] {
    return Array.from(this.tools.values(), (entry) => entry.tool);
  }

  /** Get tools matching a tag */
  getByTag(tag: string): ToolDefinition<any, any>[] {
    return this.getAll().filter((t) => t.tags?.includes(tag));
  }

  /** List all tool names */
  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  // ── Execution ────────────────────────────────────────────────────────────

  /** Execute a tool by name with the given parameters */
  async execute(
    name: string,
    params: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const entry = this.tools.get(name);
    if (!entry) {
      return { success: false, error: `Unknown tool: "${name}"` };
    }
    const tool = entry.tool;

    // ── Validate parameters against schema ────────────────────────────────
    const validationErrors = validateParams(params, tool.inputSchema);
    if (validationErrors.length > 0) {
      const message = formatValidationErrors(name, validationErrors);
      console.error(`\n⚠️  ${message}\n`);
      return { success: false, error: message, executionOutcome: "failed" };
    }

    try {
      assertExecutionActive(context);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Tool execution cancelled', executionOutcome: 'failed' };
    }
    // A denying session never dispatches an approval-gated tool. The model
    // does not see these tools either; this is the execution-side guard.
    if (tool.approval && context?.approval?.policy === "deny") {
      return { success: false, error: `Tool "${name}" requires user approval, which this session does not permit`, executionOutcome: "failed" };
    }
    // A request binds the definitions it advertised. If the owner withdrew
    // or replaced one since, refuse rather than run a handler the model
    // never saw or one its owner has retired.
    if (entry.live && !entry.live()) {
      return { success: false, error: `Tool "${name}" was withdrawn before dispatch`, executionOutcome: "failed" };
    }
    const start = Date.now();
    let admitted = false;
    try {
      const invoke = () => {
        assertExecutionActive(currentExecutionContext() ?? context);
        admitted = true;
        return tool.handler(params, currentExecutionContext() ?? context);
      };
      const result = context
        ? await withExecutionContext({ ...context, toolApproval: tool.approval }, invoke)
        : await invoke();
      const duration = Date.now() - start;
      // Returning from a handler does not prove its declared result survived
      // the model/journal serialization boundary.
      console.log(`↩️  ${name} returned in ${duration}ms`);
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      const message = redactSensitiveText(
        error instanceof Error ? error.message : "Unknown error",
      );
      const stack = error instanceof Error
        ? redactSensitiveText(error.stack?.split("\n")[1]?.trim() ?? "")
        : "";

      // ── Rich error output ──────────────────────────────────────────────
      console.error(`\n❓ ${name} threw after ${duration}ms; ${admitted ? 'outcome is unknown' : 'not dispatched'}`);
      console.error(`   Error: ${message}`);
      // Inputs can contain credentials and personal data. Log shape only.
      console.error(`   Input keys: ${Object.keys(params).sort().join(", ") || "(none)"}`);
      if (stack) {
        console.error(`   At:    ${stack}`);
      }

      // Provide hints for common mistakes
      const hints: string[] = [];
      if (message.includes("Cannot read properties of undefined")) {
        hints.push(
          "A parameter might be missing — check that required fields are provided"
        );
      }
      if (message.includes("is not a function")) {
        hints.push(
          "Check that you're importing the right modules and calling functions correctly"
        );
      }
      if (message.includes("fetch") || message.includes("ECONNREFUSED")) {
        hints.push(
          "Network request failed — check the URL and your internet connection"
        );
      }
      if (message.includes("ENOENT")) {
        hints.push("File not found — check the file path");
      }
      for (const hint of hints) {
        console.error(`   Hint:  ${hint}`);
      }
      console.error();

      return { success: false, error: message, executionOutcome: admitted ? "unknown" : "failed" };
    }
  }

  // ── Provider Format Adapters ─────────────────────────────────────────────
  //
  // These convert your tool definitions into the format each AI provider
  // expects. This is the "write once, use everywhere" magic.

  /** Convert tools to Gemini function calling format */
  toGeminiFormat(): GeminiFunctionDeclaration[] {
    return this.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object" as const,
        properties: tool.inputSchema.properties,
        required: tool.inputSchema.required,
      },
    }));
  }

  /** Convert tools to Anthropic/Claude format */
  toAnthropicFormat(): AnthropicTool[] {
    return this.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  /** Convert tools to OpenAI format */
  toOpenAIFormat(): OpenAIFunction[] {
    return this.getAll().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
}

/**
 * Per-request tool set, bound to the exact advertised definitions through one
 * model request and its effects. Under a denying approval policy, approval-gated tools
 * are omitted so the model never sees them; the journaled request envelope and
 * the adapter both read this snapshot, so the omission is durable evidence.
 * Each entry stays bound to the source definition it copied: once that is
 * withdrawn or replaced, dispatch from this snapshot is refused.
 */
export function snapshotToolRegistry(source: ToolRegistry, policy?: "ask" | "deny" | "allow"): ToolRegistry {
  const snapshot = new ToolRegistry();
  for (const tool of source.getAll()) {
    if (tool.approval && policy === "deny") continue;
    snapshot.register(Object.freeze({
      ...tool,
      inputSchema: snapshotJson(tool.inputSchema) as typeof tool.inputSchema,
      ...(tool.tags ? {tags: [...tool.tags]} : {}),
    }), {live: source.liveness(tool.name)});
  }
  return snapshot;
}

/** Global registry instance — import this to register and access tools */
export const registry = new ToolRegistry();

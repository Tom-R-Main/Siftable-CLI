/**
 * Steering inside a ChatAgent turn: corrections join the run between steps
 * (after the tool batch settles), a correction that arrives during the final
 * answer earns one more step, each id is appended once per turn, and nothing
 * is appended when the round budget is spent.
 *
 * Run with: bun test   (from packages/exf-cli/interactive-tui)
 */
import { describe, expect, it } from "bun:test";
import { createChatAgent } from "../agent-harness/framework/chat-agent";
import { InMemorySessionEventStore } from "../agent-harness/framework/session";
import type { AIAdapter, AdapterResponse } from "../agent-harness/framework/adapters/types";
import type { ChatMessage, ToolDefinition } from "../agent-harness/framework/types";
import type { SteeringMessage } from "../agent-harness/framework/chat-agent-types";

type Script = (messages: ChatMessage[], step: number) => AdapterResponse | Promise<AdapterResponse>;

function recordingAdapter(script: Script) {
  const requests: ChatMessage[][] = [];
  const adapter: AIAdapter = {
    name: "scripted",
    model: "test",
    async chat(messages) {
      requests.push(structuredClone(messages));
      return script(messages, requests.length - 1);
    },
  };
  return { adapter, requests };
}

function steeringBox() {
  const queue: SteeringMessage[] = [];
  const delivered: string[] = [];
  return {
    queue,
    delivered,
    source: {
      pending: () => [...queue],
      onDelivered: (id: string) => delivered.push(id),
    },
  };
}

const userTexts = (messages: ChatMessage[]) =>
  messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : "[parts]"));

async function runTurn(adapter: AIAdapter, steering: ReturnType<typeof steeringBox>["source"], tools: ToolDefinition<any, any>[] = [], maxToolRounds?: number) {
  const store = new InMemorySessionEventStore();
  const agent = await createChatAgent({
    adapter,
    memory: false,
    tools,
    ...(maxToolRounds ? { maxToolRounds } : {}),
    session: { id: `steer-${Math.random()}`, store },
  });
  try {
    const chunks: unknown[] = [];
    for await (const chunk of agent.chat("start", { stream: true, steering })) chunks.push(chunk);
    return { agent, history: agent.getHistory(), chunks };
  } finally {
    await agent.close();
  }
}

describe("ChatAgent steering", () => {
  it("delivers a correction after the tool batch settles, before the next request", async () => {
    const box = steeringBox();
    const tool: ToolDefinition<any, any> = {
      name: "slow",
      description: "slow fixture",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        box.queue.push({ id: "s1", message: "use the other file" });
        return { success: true, data: "done" };
      },
    };
    const { adapter, requests } = recordingAdapter((_messages, step) =>
      step === 0 ? { toolCall: { id: "c1", name: "slow", args: {} } } : { text: "ok" },
    );
    const { history } = await runTurn(adapter, box.source, [tool]);

    expect(requests).toHaveLength(2);
    expect(userTexts(requests[0]!)).toEqual(["start"]);
    // Tool result first, then the correction.
    const second = requests[1]!;
    expect(second.at(-2)?.role).toBe("tool");
    expect(second.at(-1)).toMatchObject({ role: "user", content: "use the other file" });
    expect(box.delivered).toEqual(["s1"]);
    expect(userTexts(history)).toEqual(["start", "use the other file"]);
  });

  it("gives the model one more step when a correction lands during its final answer", async () => {
    const box = steeringBox();
    const { adapter, requests } = recordingAdapter((_messages, step) => {
      if (step === 0) {
        box.queue.push({ id: "s1", message: "also cover the edge case" });
        return { text: "first answer" };
      }
      return { text: "revised answer" };
    });
    const { history, chunks } = await runTurn(adapter, box.source);

    expect(requests).toHaveLength(2);
    expect(requests[1]!.at(-1)).toMatchObject({ role: "user", content: "also cover the edge case" });
    expect(history.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["first answer", "revised answer"]);
    expect(chunks.at(-1)).toMatchObject({ type: "done", result: { text: "revised answer" } });
  });

  it("appends each correction once even while the source keeps reporting it", async () => {
    const box = steeringBox();
    box.queue.push({ id: "s1", message: "only once" });
    const tool: ToolDefinition<any, any> = {
      name: "noop",
      description: "noop fixture",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ success: true }),
    };
    const { adapter } = recordingAdapter((_messages, step) =>
      step < 2 ? { toolCall: { id: `c${step}`, name: "noop", args: {} } } : { text: "ok" },
    );
    const { history } = await runTurn(adapter, box.source, [tool]);
    expect(userTexts(history)).toEqual(["start", "only once"]);
    expect(box.delivered).toEqual(["s1"]);
  });

  it("leaves a correction undelivered when the round budget is spent", async () => {
    const box = steeringBox();
    const { adapter, requests } = recordingAdapter(() => {
      box.queue.push({ id: "late", message: "too late" });
      return { text: "done" };
    });
    const { history } = await runTurn(adapter, box.source, [], 1);
    expect(requests).toHaveLength(1);
    expect(box.delivered).toEqual([]);
    expect(userTexts(history)).toEqual(["start"]);
  });
});

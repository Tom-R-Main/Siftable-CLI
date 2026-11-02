import {describe, expect, test} from 'bun:test';
import {createChatAgent} from '../agent-harness/framework/chat-agent';
import {createRepetitionTracker} from '../agent-harness/framework/repetition';
import {defineTool, err, ok} from '../agent-harness/framework/tool';
import {digestJson, InMemorySessionEventStore, SessionKernel, type SessionEventStore} from '../agent-harness/framework/session';
import type {AdapterResponse, ChatMessage} from '../agent-harness/framework/adapters/types';

const marker = '[Sift harness advisory: repeated-tool-call]';
const call = (id: number, name = 'probe', args: Record<string, unknown> = {path: 'file'}) => ({id: String(id), name, args});
const notices = (history: readonly ChatMessage[]) => history.filter(message => message.role === 'user'
  && typeof message.content === 'string' && message.content.startsWith(marker));

describe('advisory repetition detector', () => {
  test('canonicalizes nested keys, ignores call IDs, and advises only at 3, 5, 8', () => {
    const tracker = createRepetitionTracker();
    const counts: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const args = i % 2 ? {a: {x: 1, y: [2, 3]}, b: 4} : {b: 4, a: {y: [2, 3], x: 1}};
      if (tracker.observe(call(i, 'probe', args))) counts.push(i);
    }
    expect(counts).toEqual([3, 5, 8]);
  });

  test('changed array order and different tracked calls reset the chain', () => {
    const tracker = createRepetitionTracker();
    tracker.observe(call(1, 'probe', {items: [1, 2]}));
    tracker.observe(call(2, 'probe', {items: [1, 2]}));
    expect(tracker.observe(call(3, 'probe', {items: [2, 1]}))).toBeUndefined();
    tracker.observe(call(4, 'other', {items: [2, 1]}));
    expect(tracker.observe(call(5, 'probe', {items: [2, 1]}))).toBeUndefined();
  });

  test('known process polling is transparent and feedback does not quote argument bodies', () => {
    const tracker = createRepetitionTracker();
    const args = {content: 'private fixture payload'};
    tracker.observe(call(1, 'probe', args));
    for (let i = 0; i < 12; i++) {
      expect(tracker.observe(call(i, 'read_process_job'))).toBeUndefined();
      expect(tracker.observe(call(i, 'list_process_jobs'))).toBeUndefined();
    }
    tracker.observe(call(2, 'probe', args));
    const text = tracker.observe(call(3, 'probe', args));
    expect(text).toContain('Repetition alone does not establish a lack of progress');
    expect(text).not.toContain('private fixture payload');
  });
});

async function fixture(responses: AdapterResponse[], options: {
  store?: SessionEventStore;
  handler?: () => ReturnType<typeof ok>;
} = {}) {
  const requests: ChatMessage[][] = [];
  let executions = 0;
  const store = options.store ?? new InMemorySessionEventStore();
  const agent = await createChatAgent({
    memory: false, prompt: 'fixture', maxToolRounds: 20,
    session: {id: 'repetition-fixture', store},
    tools: [defineTool({name: 'probe', description: 'fixture',
      inputSchema: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']},
      handler: async () => { executions++; return options.handler?.() ?? ok({observed: executions}); },
    })],
    adapter: {name: 'fixture', model: 'fixture', chat: async (history) => {
      requests.push(structuredClone(history));
      const next = responses.shift();
      if (!next) throw new Error('fixture responses exhausted');
      return next;
    }},
  });
  return {agent, requests, store, executions: () => executions};
}

describe('durable repetition feedback', () => {
  test('sixteen identical calls all execute with exactly three durable, replayable notices', async () => {
    const f = await fixture([...Array.from({length: 16}, (_, i) => ({toolCall: call(i)})), {text: 'done'}]);
    try {
      await f.agent.chat('inspect');
      expect(f.executions()).toBe(16);
      expect(notices(f.requests.at(-1)!)).toHaveLength(3);
      const events = f.agent.getSessionEvents();
      const journalNotices = events.filter(event => event.type === 'message/appended'
        && notices([event.data.message]).length > 0);
      expect(journalNotices).toHaveLength(3);
      expect(notices(f.requests.at(-1)!).map(message => String(message.content).match(/called (\d+) consecutive/)?.[1]))
        .toEqual(['3', '5', '8']);
      for (const event of journalNotices) {
        expect(events[event.seq - 2]?.type).toBe('step/completed');
        expect(event.stepId).toBeUndefined();
      }
      const prepared = events.filter(event => event.type === 'model/request-prepared');
      expect(prepared[3]?.data.history.sha256).toBe(digestJson(f.requests[3]));
      const replay = new SessionKernel({sessionId: 'repetition-fixture', store: f.store});
      expect(notices(replay.getHistory())).toEqual(notices(f.requests.at(-1)!));
      expect(events.filter(event => event.type === 'tool/result')).toHaveLength(16);
      expect(f.requests.at(-1)!.filter(message => message.role === 'tool')).toHaveLength(16);
    } finally { await f.agent.close(); }
  });

  test('a parallel batch appends its advisory after every tool result', async () => {
    const f = await fixture([{toolCalls: [call(1), call(2), call(3)]}, {text: 'done'}]);
    try {
      await f.agent.chat('inspect');
      const history = f.requests[1]!;
      expect(history.slice(-4).map(message => message.role)).toEqual(['tool', 'tool', 'tool', 'user']);
      expect(notices(history)).toHaveLength(1);
    } finally { await f.agent.close(); }
  });

  test('a new user turn starts a fresh repeat chain', async () => {
    const f = await fixture([{toolCall: call(1)}, {toolCall: call(2)}, {text: 'first'},
      {toolCall: call(3)}, {toolCall: call(4)}, {text: 'second'}]);
    try {
      await f.agent.chat('first');
      await f.agent.chat('second');
      expect(notices(f.requests.at(-1)!)).toHaveLength(0);
    } finally { await f.agent.close(); }
  });

  test('failed tool attempts still receive advice without being blocked', async () => {
    const f = await fixture([{toolCall: call(1)}, {toolCall: call(2)}, {toolCall: call(3)}, {text: 'done'}],
      {handler: () => err('fixture denial')});
    try {
      await f.agent.chat('inspect');
      expect(f.executions()).toBe(3);
      expect(notices(f.requests.at(-1)!)).toHaveLength(1);
      expect(f.agent.getSessionEvents().filter(event => event.type === 'tool/result'
        && event.data.outcome === 'failed')).toHaveLength(3);
    } finally { await f.agent.close(); }
  });

  test('resuming replays prior feedback but does not resume the previous turn repeat count', async () => {
    const first = await fixture([{toolCall: call(1)}, {toolCall: call(2)}, {toolCall: call(3)}, {text: 'done'}]);
    try { await first.agent.chat('first'); } finally { await first.agent.close(); }
    const resumed = await fixture([{toolCall: call(4)}, {toolCall: call(5)}, {text: 'done'}], {store: first.store});
    try {
      await resumed.agent.chat('continue');
      expect(notices(resumed.requests[0]!)).toHaveLength(1);
      expect(notices(resumed.requests.at(-1)!)).toHaveLength(1);
      expect(resumed.executions()).toBe(2);
    } finally { await resumed.agent.close(); }
  });

  test('cancellation preserves settled results without adding an undelivered notice', async () => {
    const controller = new AbortController();
    let executed = 0;
    const f = await fixture([{toolCall: call(1)}, {toolCall: call(2)}, {toolCall: call(3)}, {text: 'unreachable'}],
      {handler: () => { if (++executed === 3) controller.abort(new Error('fixture cancellation')); return ok({executed}); }});
    try {
      await expect(f.agent.chat('inspect', {signal: controller.signal})).rejects.toThrow();
      expect(f.requests).toHaveLength(3);
      expect(notices(f.agent.getHistory())).toHaveLength(0);
      expect(f.agent.getSessionEvents().filter(event => event.type === 'tool/result')).toHaveLength(3);
      const replay = new SessionKernel({sessionId: 'repetition-fixture', store: f.store});
      expect(replay.recoverInterrupted()).toHaveLength(0);
    } finally { await f.agent.close(); }
  });

  test('a failed advisory append never reaches a subsequent model request', async () => {
    const backing = new InMemorySessionEventStore();
    const store: SessionEventStore = {read: id => backing.read(id), append: event => {
      if (event.type === 'message/appended' && notices([event.data.message]).length) {
        throw new Error('advisory journal unavailable');
      }
      backing.append(event);
    }};
    const f = await fixture([{toolCall: call(1)}, {toolCall: call(2)}, {toolCall: call(3)}, {text: 'unreachable'}], {store});
    try {
      await expect(f.agent.chat('inspect')).rejects.toThrow('advisory journal unavailable');
      expect(f.requests).toHaveLength(3);
      expect(notices(f.agent.getHistory())).toHaveLength(0);
      expect(f.agent.getSessionEvents().filter(event => event.type === 'tool/result')).toHaveLength(3);
      const replay = new SessionKernel({sessionId: 'repetition-fixture', store});
      expect(replay.recoverInterrupted()).toHaveLength(0);
    } finally { await f.agent.close(); }
  });
});

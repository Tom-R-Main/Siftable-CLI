import {describe, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {createChatAgent} from '../agent-harness/framework/chat-agent';
import {InMemorySessionEventStore, SessionKernel} from '../agent-harness/framework/session';
import type {AIAdapter, ChatMessage} from '../agent-harness/framework/adapters/types';
import type {ToolResult} from '../agent-harness/framework/types';
import {projectShellResult} from '../shellExecution';
import {readSessionOutput} from '../sessionOutput';

function receipt(output = 'distinct stdout\ndistinct stderr'): ToolResult {
  return {success: false, executionOutcome: 'failed', error: `exit 1; file effects were not rolled back\n${output}`, data: {
    command: 'false; echo diagnostic', cwd: '/workspace', exitCode: 1, signal: null,
    stdout: 'distinct stdout', stderr: 'distinct stderr', output,
    outputTruncated: false, timedOut: false, cancelled: false, started: true,
    terminationConfirmed: true, executionOutcome: 'failed',
  }};
}

describe('model tool result projection', () => {
  test('preserves exit and uncertainty metadata with one output body and no repeated command', () => {
    const source = receipt();
    const projected = projectShellResult(source);
    expect(projected).toMatchObject({success: false, executionOutcome: 'failed', error: 'exit 1; file effects were not rolled back', data: {output: 'distinct stdout\ndistinct stderr', exitCode: 1, terminationConfirmed: true}});
    expect(projected.data).not.toHaveProperty('command');
    expect(projected.data).not.toHaveProperty('stdout');
    expect(projected.data).not.toHaveProperty('stderr');
    expect((JSON.stringify(projected).match(/distinct stdout/g) ?? []).length).toBe(1);
    expect(source.data).toHaveProperty('stdout');
    expect(projectShellResult({success: false, error: 'command declined'})).toEqual({success: false, error: 'command declined'});
    expect(projectShellResult({success: true, data: {cwd: '/other'}})).toEqual({success: true, data: {cwd: '/other'}});
    const success = {...source, success: true, executionOutcome: 'succeeded' as const, error: undefined, message: 'distinct stdout\ndistinct stderr'};
    expect(projectShellResult(success).message).toBeUndefined();
    const unknown = {...source, executionOutcome: 'unknown' as const};
    expect(projectShellResult(unknown).executionOutcome).toBe('unknown');
  });

  for (const large of [false, true]) test(`provider, history and replay share projected content; rich receipt retained (${large ? 'spilled' : 'inline'})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'projection-'));
    const store = new InMemorySessionEventStore();
    const id = `projection-${large}`;
    const source = receipt(large ? 'diagnostic λ\n'.repeat(3000) : undefined);
    let count = 0;
    let sent: ChatMessage[] = [];
    const adapter: AIAdapter = {name: 'fixture', model: 'fixture', async chat(messages) {
      if (count++ === 0) return {toolCall: {id: 'shell-1', name: 'shell', args: {}}};
      sent = JSON.parse(JSON.stringify(messages));
      return {text: 'done'};
    }};
    const agent = await createChatAgent({adapter, memory: false, session: {id, store}, toolOutput: {maxBytes: 2048, spillDir: root}, tools: [{name: 'shell', description: 'fixture', inputSchema: {type: 'object', properties: {}}, handler: async () => source, modelResult: projectShellResult}]});
    try {
      await agent.chat('inspect');
      const event = store.read(id).find(event => event.type === 'tool/result');
      if (!event || event.type !== 'tool/result') throw new Error('missing receipt');
      const content = event.data.modelContent!;
      expect(sent.find(message => message.role === 'tool')?.content).toBe(content);
      expect(agent.getHistory().find(message => message.role === 'tool')?.content).toBe(content);
      const replay = new SessionKernel({sessionId: id, store});
      expect(replay.getHistory().find(message => message.role === 'tool')?.content).toBe(content);
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(2048);
      if (large) {
        const ref = event.data.output?.fullOutputRef;
        expect(ref).toBeDefined();
        expect(JSON.parse(readFileSync(ref!, 'utf8'))).toEqual(source);
        expect(readdirSync(dirname(ref!)).filter(name => name.endsWith('.json'))).toHaveLength(1);
        expect(content).toContain('retained privately');
        expect(content).not.toContain(root);
      } else {
        expect(event.data.result).toEqual(source);
        expect(JSON.parse(content).data.stdout).toBeUndefined();
        expect(JSON.parse(readSessionOutput(store.read(id), 'shell-1', root).text)).toEqual(source);
      }
    } finally {await agent.close(); rmSync(root, {recursive: true, force: true});}
  });

  test('redacts projected serialization hooks before logging or provider dispatch', async () => {
    let count = 0;
    const agent = await createChatAgent({memory: false, adapter: {name: 'fixture', model: 'fixture', async chat() {return count++ === 0 ? {toolCall: {id: 'call', name: 'tool', args: {}}} : {text: 'done'};}}, tools: [{name: 'tool', description: 'fixture', inputSchema: {type: 'object', properties: {}}, handler: async () => receipt(), modelResult: () => ({...receipt(), toJSON() {return {...receipt(), data: {apiKey: 'projection-secret'}};}})}]});
    try {await agent.chat('inspect'); expect(JSON.stringify(agent.getHistory())).not.toContain('projection-secret');}
    finally {await agent.close();}
  });

  test('projection failures or outcome changes cannot overwrite a known receipt', async () => {
    for (const modelResult of [() => {throw new Error('renderer failed');}, () => ({success: true}), () => ({...receipt(), toJSON() {return {success: true, executionOutcome: 'succeeded'};}})]) {
      let count = 0;
      const agent = await createChatAgent({memory: false, adapter: {name: 'fixture', model: 'fixture', async chat() {return count++ === 0 ? {toolCall: {id: 'call', name: 'tool', args: {}}} : {text: 'done'};}}, tools: [{name: 'tool', description: 'fixture', inputSchema: {type: 'object', properties: {}}, handler: async () => receipt(), modelResult}]});
      try {await agent.chat('inspect'); expect(JSON.parse(String(agent.getHistory().find(message => message.role === 'tool')?.content))).toEqual(receipt());}
      finally {await agent.close();}
    }
  });
});

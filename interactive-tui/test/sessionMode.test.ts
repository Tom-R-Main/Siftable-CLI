import {describe, expect, test} from 'bun:test';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {parseSessionModeOptions} from '../headless';

// Drives the production brain through `headless.ts --session-mode` against a
// loopback fake provider: no network, no real model.
type ProviderBody = {model: string; messages: Array<{role: string; content?: unknown}>; tools?: Array<{function: {name: string}}>};
type Line = Record<string, any>;

function completion(body: ProviderBody, message: Record<string, unknown>) {
  return Response.json({id: 'reply', model: body.model, choices: [{index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop'}],
    usage: {prompt_tokens: 10, completion_tokens: 4}});
}
function toolMessage(name: string, args: Record<string, unknown>, id: string) {
  return {role: 'assistant', content: null, tool_calls: [{id, type: 'function', function: {name, arguments: JSON.stringify(args)}}]};
}

function spawnSession(root: string, port: number) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../headless.ts'), '--session-mode',
    '--provider', 'meta', '--model', 'fixture', '--base-url', `http://127.0.0.1:${port}/v1`,
    '--cwd', root, '--session', 'fixture', '--deadline-ms', '8000'], {
    cwd: root,
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}`, HOME: root, META_API_KEY: 'fixture-key',
      SIFT_CONFIG_DIR: join(root, 'config'), EXF_CONFIG_DIR: join(root, 'legacy-config'), SIFT_INTERACTIVE_RUNTIME: 'source',
      SIFT_SESSION_EVENT_ROOT: join(root, 'events'), SIFT_CONTEXT_COMPACTION: '0', SIFT_EXPLORER_MODE: 'off',
    },
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  const lines: Line[] = [];
  let raw = '';
  const reading = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      const text = decoder.decode(value, {stream: true});
      raw += text;
      buffer += text;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    }
  })();
  const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  let next = 0;
  const waitFor = async (predicate: (line: Line) => boolean, timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = lines.find(predicate);
      if (found) return found;
      await Bun.sleep(5);
    }
    throw new Error(`timed out; saw ${JSON.stringify(lines.map(line => line.type))}`);
  };
  const send = async (command: Record<string, unknown>) => {
    const id = `c${++next}`;
    child.stdin.write(`${JSON.stringify({id, ...command})}\n`);
    child.stdin.flush();
    return waitFor(line => line.type === 'response' && line.id === id);
  };
  const finish = async () => {
    const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited, reading]);
    clearTimeout(killer);
    expect(raw).not.toContain('fixture-key');
    expect(stderr).not.toContain('fixture-key');
    return {stderr, exit};
  };
  return {child, lines, send, waitFor, finish, events: () => lines.filter(line => line.type !== 'response')};
}

describe('headless session mode (production brain)', () => {
  test('refuses one-shot flags', () => {
    const base = ['--session-mode', '--provider', 'meta', '--model', 'fixture'];
    expect(parseSessionModeOptions(base).session).toMatch(/^[0-9a-f-]{36}$/);
    for (const extra of [['--prompt', 'x'], ['--approval', 'allow'], ['--format', 'json'], ['--supervisor-handoff'], ['--session', '../x']]) {
      expect(() => parseSessionModeOptions([...base, ...extra])).toThrow();
    }
  });

  test('follow-up turns, approval and question round trips, confirmed cancel, and replay after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sift-session-mode-'));
    const bodies: ProviderBody[] = [];
    let aborted = false;
    const server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = await request.json() as ProviderBody;
      bodies.push(body);
      const index = bodies.length;
      if (index === 1) return completion(body, toolMessage('write_file', {path: 'note.txt', content: 'approved'}, 'w1'));
      if (index === 2) return completion(body, {role: 'assistant', content: 'Wrote note.txt.'});
      if (index === 3) return completion(body, toolMessage('ask_user', {question: 'Which color?', options: ['red', 'blue']}, 'q1'));
      if (index === 4) return completion(body, {role: 'assistant', content: 'You chose blue.'});
      // Turn 3 hangs until the client cancels.
      await new Promise<void>(resolveAbort => request.signal.addEventListener('abort', () => { aborted = true; resolveAbort(); }, {once: true}));
      return new Response('cancelled', {status: 499});
    }});
    try {
      const first = spawnSession(root, server.port);
      const init = await first.send({type: 'initialize', protocolVersion: 1});
      expect(init).toMatchObject({ok: true, resumed: false, lastSeq: 0, capabilities: {questions: true}});

      // Turn 1: write_file asks for approval over the wire.
      const turn1 = await first.send({type: 'prompt', input: 'Create note.txt'});
      const approval = await first.waitFor(line => line.type === 'approval.request');
      expect(approval).toMatchObject({turnId: turn1.turnId, kind: 'write'});
      expect(await first.send({type: 'approval.respond', requestId: approval.requestId, decision: 'allow'})).toMatchObject({status: 'applied'});
      expect(await first.send({type: 'approval.respond', requestId: approval.requestId, decision: 'allow'})).toMatchObject({status: 'already_resolved'});
      expect(await first.waitFor(line => line.type === 'turn.completed')).toMatchObject({turnId: turn1.turnId, text: 'Wrote note.txt.'});
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('approved');

      // Turn 2 in the same process: the provider sees turn 1's history and the ask_user tool.
      const turn2 = await first.send({type: 'prompt', input: 'Now pick a color'});
      const question = await first.waitFor(line => line.type === 'question.request');
      expect(question).toMatchObject({turnId: turn2.turnId, question: 'Which color?', options: ['red', 'blue']});
      await first.send({type: 'question.answer', requestId: question.requestId, answer: 'blue'});
      expect(await first.waitFor(line => line.type === 'turn.completed' && line.turnId === turn2.turnId)).toMatchObject({text: 'You chose blue.'});
      expect(JSON.stringify(bodies[2]!.messages)).toContain('Create note.txt');
      expect(bodies[2]!.tools?.map(tool => tool.function.name)).toContain('ask_user');
      expect(JSON.stringify(bodies[3]!.messages)).toContain('blue');

      // Turn 3: cancel while the provider request is in flight.
      const turn3 = await first.send({type: 'prompt', input: 'Take a long time'});
      await first.waitFor(() => bodies.length === 5);
      expect(await first.send({type: 'cancel'})).toMatchObject({status: 'stopping'});
      const stopped = await first.waitFor(line => line.type === 'turn.stopped');
      expect(stopped).toMatchObject({turnId: turn3.turnId, confirmed: true, reason: 'client', jobCleanup: 'confirmed'});
      expect(aborted).toBe(true);
      const usage = await first.send({type: 'usage'});
      expect(usage.usage.session.requests).toBeGreaterThanOrEqual(4);
      expect(usage.usage.turns).toBe(3);
      expect(await first.send({type: 'shutdown'})).toMatchObject({ok: true, exitCode: 0});
      expect((await first.finish()).exit).toBe(0);
      const firstEvents = first.events();
      firstEvents.forEach((event, index) => expect(event.seq).toBe(index + 1));
      expect(firstEvents.filter(event => event.type === 'turn.stopped')).toHaveLength(1);

      // Reconnect: a new process resumes the session and replays from a cursor.
      const second = spawnSession(root, server.port);
      const resumed = await second.send({type: 'initialize', protocolVersion: 1});
      expect(resumed).toMatchObject({resumed: true, lastSeq: firstEvents.length});
      const cursor = firstEvents.find(event => event.type === 'turn.started' && event.turnId === turn2.turnId)!.seq - 1;
      const replay = await second.send({type: 'replay', after: cursor, limit: 10_000});
      expect(replay.events).toEqual(firstEvents.slice(cursor));
      second.child.stdin.end();
      expect((await second.finish()).exit).toBe(0);
      expect(second.events().at(-1)).toMatchObject({type: 'session.closed', reason: 'eof', seq: firstEvents.length + 1});
    } finally {
      server.stop(true);
      await rm(root, {recursive: true, force: true});
    }
  }, 30_000);
});

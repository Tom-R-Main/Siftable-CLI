import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LocalControlClient} from '../../interactive-tui/localControlClient';
import {setBrainModel, type BrainEvent, type BrainAskResult} from '../../interactive-tui/brain';
import type {SseEvent} from '../../interactive-tui/controlClient';

/** Build a fake openfunctionAsk that replays a scripted event stream. */
function fakeAsk(
  events: BrainEvent[],
  result: BrainAskResult = {text: ''},
): (text: string, onEvent: (e: BrainEvent) => void) => Promise<BrainAskResult> {
  return async (_text, onEvent) => {
    for (const e of events) onEvent(e);
    return result;
  };
}

describe('LocalControlClient (in-process transport)', () => {
  describe('send() event translation', () => {
    it('forwards token / tool_call / tool_result / done events unchanged to the TUI', async () => {
      const stream: BrainEvent[] = [
        {type: 'token', content: 'Hello '},
        {type: 'token', content: 'world'},
        {type: 'tool_call', toolCall: {name: 'list_dir'}},
        {type: 'tool_result', toolResult: {name: 'list_dir', success: true}},
        {type: 'done', message: {content: 'Hello world'}},
      ];
      const client = new LocalControlClient({ask: fakeAsk(stream)});

      const received: SseEvent[] = [];
      await client.send('hi', (e) => received.push(e));

      expect(received.map((e) => e.type)).toEqual([
        'token',
        'token',
        'tool_call',
        'tool_result',
        'done',
      ]);
      expect(received[0].content).toBe('Hello ');
      expect(received[2].toolCall?.name).toBe('list_dir');
      expect(received[3].toolResult?.success).toBe(true);
    });

    it('emits a trailing error event when the brain returns {error} (degraded path)', async () => {
      const client = new LocalControlClient({
        ask: fakeAsk([], {text: '', error: 'OpenFunction brain unavailable: no key'}),
      });

      const received: SseEvent[] = [];
      await client.send('hi', (e) => received.push(e));

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('error');
      expect(received[0].error).toContain('brain unavailable');
    });

    it('rejects with AbortError when the signal is already aborted', async () => {
      const client = new LocalControlClient({ask: fakeAsk([{type: 'token', content: 'x'}])});
      const ctrl = new AbortController();
      ctrl.abort();

      await expect(
        client.send('hi', () => {}, ctrl.signal),
      ).rejects.toMatchObject({name: 'AbortError'});
    });

    it('headlessly exercises repo_explorer through the real local transport seam', async () => {
      const root = await mkdtemp(join(tmpdir(), 'sift-localclient-explorer-'));
      let capturedInput: unknown;
      const previousCwd = process.env.SIFT_USER_CWD;
      const previousExplorer = process.env.SIFT_EXPLORER;
      await mkdir(join(root, 'src'), {recursive: true});
      await writeFile(join(root, 'package.json'), '{"name":"headless-explorer-fixture"}\n', 'utf8');
      await writeFile(join(root, 'src', 'fsEngine.ts'), 'export const marker = "local search";\n', 'utf8');
      await writeFile(join(root, 'src', 'brain.ts'), 'export const route = "local search routing";\n', 'utf8');
      (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__ = {
        createChatAgent: async () => ({
          chat: async function* (message: unknown) {
            capturedInput = message;
            if (String(message).includes('src/fsEngine.ts')) {
              yield {type: 'tool_call', toolCall: {name: 'read_file', args: {path: 'src/fsEngine.ts'}}};
              yield {type: 'tool_result', toolResult: {name: 'read_file', success: true}};
            }
            yield {type: 'text', text: 'ok'};
            yield {type: 'done', result: {content: 'ok'}};
          },
        }),
        defineTool: (def: unknown) => def,
        ok: (data: unknown, message?: string) => ({success: true, data, message}),
        err: (error: string) => ({success: false, error}),
      };
      process.env.SIFT_USER_CWD = root;
      setBrainModel({provider: 'openrouter', model: 'headless-smoke'});

      try {
        const client = new LocalControlClient();
        const broadEvents: SseEvent[] = [];
        await client.send('scour this repo and explain how local search works', (event) => broadEvents.push(event));

        expect(broadEvents.some((event) => event.toolCall?.name === 'repo_explorer')).toBe(true);
        expect(broadEvents.some((event) => event.toolResult?.name === 'repo_explorer')).toBe(true);
        expect(broadEvents.find((event) => event.toolResult?.name === 'repo_explorer')?.toolResult?.output).toContain('char report');
        expect(broadEvents.some((event) => event.toolCall?.name === 'read_file')).toBe(true);
        expect(String(capturedInput)).toContain('<repo_explorer_report>');
        expect(String(capturedInput)).toContain('Metrics:');
        expect(String(capturedInput)).toContain('src/fsEngine.ts');

        capturedInput = undefined;
        const ordinaryEvents: SseEvent[] = [];
        await client.send('explain why Napoleon lost in Russia', (event) => ordinaryEvents.push(event));
        expect(ordinaryEvents.some((event) => event.toolCall?.name === 'repo_explorer')).toBe(false);
        expect(String(capturedInput)).not.toContain('<repo_explorer_report>');

        capturedInput = undefined;
        process.env.SIFT_EXPLORER = 'off';
        const disabledEvents: SseEvent[] = [];
        await client.send('scour this repo and explain how local search works', (event) => disabledEvents.push(event));
        expect(disabledEvents.some((event) => event.toolCall?.name === 'repo_explorer')).toBe(false);
        expect(String(capturedInput)).not.toContain('<repo_explorer_report>');
      } finally {
        if (previousCwd === undefined) delete process.env.SIFT_USER_CWD;
        else process.env.SIFT_USER_CWD = previousCwd;
        if (previousExplorer === undefined) delete process.env.SIFT_EXPLORER;
        else process.env.SIFT_EXPLORER = previousExplorer;
        delete (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__;
        await rm(root, {recursive: true, force: true});
      }
    });
  });

  describe('state()', () => {
    it('reports authenticated when a token is present', async () => {
      const client = new LocalControlClient({
        getToken: () => 'sift_pat_x',
        getModel: () => ({provider: 'openrouter', model: 'google/gemini-3.5-flash'}),
      });
      const s = await client.state();
      expect(s.available).toBe(true);
      expect(s.authStatus).toBe('authenticated');
      expect(s.model?.model).toBe('google/gemini-3.5-flash');
      expect(s.context?.surface).toBe('local');
    });

    it('reports unauthenticated when no token is present (degraded)', async () => {
      const client = new LocalControlClient({getToken: () => undefined});
      const s = await client.state();
      expect(s.available).toBe(false);
      expect(s.authStatus).toBe('unauthenticated');
    });
  });

  describe('config()', () => {
    it('delegates to setBrainModel and returns the new model', async () => {
      const setModel = jest.fn(() => ({provider: 'anthropic', model: 'claude-haiku-4-5'}));
      const client = new LocalControlClient({setModel});
      const result = await client.config({provider: 'anthropic', model: 'claude-haiku-4-5'});
      expect(setModel).toHaveBeenCalledWith({provider: 'anthropic', model: 'claude-haiku-4-5'});
      expect(result.model).toBe('claude-haiku-4-5');
    });
  });

  describe('login()', () => {
    it('directs the user to `sift auth login` rather than a broken round-trip', async () => {
      const client = new LocalControlClient({});
      await expect(client.login()).rejects.toThrow(/sift auth login/);
    });
  });
});

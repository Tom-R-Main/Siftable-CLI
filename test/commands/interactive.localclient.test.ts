import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LocalControlClient} from '../../interactive-tui/localControlClient';
import {setBrainModel, type BrainEvent, type BrainAskResult} from '../../interactive-tui/brain';
import {doneFallbackText, type SseEvent} from '../../interactive-tui/controlClient';
import {rejectAllConfirms, resetBypass, resolveApproval, setConfirmListener} from '../../interactive-tui/confirmGate';

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
  afterEach(() => {
    rejectAllConfirms();
    setConfirmListener(null);
    resetBypass();
  });

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

    it('recovers final text from done.result.text when no deltas streamed', () => {
      expect(doneFallbackText({type: 'done', result: {text: 'final answer'}})).toBe('final answer');
    });

    it('rejects with AbortError when the signal is already aborted', async () => {
      const client = new LocalControlClient({ask: fakeAsk([{type: 'token', content: 'x'}])});
      const ctrl = new AbortController();
      ctrl.abort();

      await expect(
        client.send('hi', () => {}, ctrl.signal),
      ).rejects.toMatchObject({name: 'AbortError'});
    });

    it('lets the brain change the persistent session workdir and resolve later paths from it', async () => {
      const root = await mkdtemp(join(tmpdir(), 'sift-localclient-cwd-'));
      const previousCwd = process.env.SIFT_USER_CWD;
      const previousRoot = process.env.SIFT_WORKSPACE_ROOT;
      await mkdir(join(root, '.git'), {recursive: true});
      await mkdir(join(root, 'nested'), {recursive: true});
      await writeFile(join(root, 'nested', 'target.txt'), 'dynamic cwd works\n', 'utf8');
      let readResult: any;
      (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__ = {
        createChatAgent: async (config: Record<string, any>) => ({
          chat: async function* () {
            const changeDirectory = config.tools.find((tool: any) => tool.name === 'change_directory');
            const readFile = config.tools.find((tool: any) => tool.name === 'read_file');
            yield {type: 'tool_call', toolCall: {name: 'change_directory', args: {path: 'nested'}}};
            const cdResult = await changeDirectory.handler({path: 'nested'});
            yield {type: 'tool_result', toolResult: {name: 'change_directory', success: cdResult.success}};
            yield {type: 'tool_call', toolCall: {name: 'read_file', args: {path: 'target.txt'}}};
            readResult = await readFile.handler({path: 'target.txt'});
            yield {type: 'tool_result', toolResult: {name: 'read_file', success: readResult.success}};
            yield {type: 'done', result: {content: 'done'}};
          },
        }),
        defineTool: (def: unknown) => def,
        ok: (data: unknown, message?: string) => ({success: true, data, message}),
        err: (error: string) => ({success: false, error}),
      };
      process.env.SIFT_USER_CWD = root;
      process.env.SIFT_WORKSPACE_ROOT = root;
      setBrainModel({provider: 'openrouter', model: 'cwd-smoke'});

      try {
        const client = new LocalControlClient();
        const events: SseEvent[] = [];
        await client.send('cd nested and read target', (event) => events.push(event));

        expect(process.env.SIFT_USER_CWD).toBe(join(root, 'nested'));
        expect(process.env.SIFT_WORKSPACE_ROOT).toBe(root);
        expect(readResult.success).toBe(true);
        expect(readResult.data.content).toContain('dynamic cwd works');
        expect(events.some((event) => event.toolCall?.name === 'change_directory')).toBe(true);
      } finally {
        if (previousCwd === undefined) delete process.env.SIFT_USER_CWD;
        else process.env.SIFT_USER_CWD = previousCwd;
        if (previousRoot === undefined) delete process.env.SIFT_WORKSPACE_ROOT;
        else process.env.SIFT_WORKSPACE_ROOT = previousRoot;
        delete (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__;
        await rm(root, {recursive: true, force: true});
      }
    });

    it('runs terminal commands only after approval', async () => {
      const root = await mkdtemp(join(tmpdir(), 'sift-localclient-command-'));
      const previousCwd = process.env.SIFT_USER_CWD;
      let commandResult: any;
      let approvedCommand = '';
      setConfirmListener((req) => {
        approvedCommand = req.path;
        resolveApproval(req.id, 'allow');
      });
      (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__ = {
        createChatAgent: async (config: Record<string, any>) => ({
          chat: async function* () {
            const runCommand = config.tools.find((tool: any) => tool.name === 'run_terminal_command');
            yield {type: 'tool_call', toolCall: {name: 'run_terminal_command', args: {command: 'printf model-command'}}};
            commandResult = await runCommand.handler({command: 'printf model-command'});
            yield {type: 'tool_result', toolResult: {name: 'run_terminal_command', success: commandResult.success}};
            yield {type: 'done', result: {content: 'done'}};
          },
        }),
        defineTool: (def: unknown) => def,
        ok: (data: unknown, message?: string) => ({success: true, data, message}),
        err: (error: string) => ({success: false, error}),
      };
      process.env.SIFT_USER_CWD = root;
      setBrainModel({provider: 'openrouter', model: 'command-smoke'});

      try {
        const client = new LocalControlClient();
        await client.send('run printf', () => {});

        expect(approvedCommand).toBe('printf model-command');
        expect(commandResult.success).toBe(true);
        expect(commandResult.data.output).toBe('model-command');
      } finally {
        if (previousCwd === undefined) delete process.env.SIFT_USER_CWD;
        else process.env.SIFT_USER_CWD = previousCwd;
        delete (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__;
        await rm(root, {recursive: true, force: true});
      }
    });

    it('headlessly exercises repo_explorer through the real local transport seam', async () => {
      const root = await mkdtemp(join(tmpdir(), 'sift-localclient-explorer-'));
      let capturedInput: unknown;
      const previousCwd = process.env.SIFT_USER_CWD;
      const previousExplorer = process.env.SIFT_EXPLORER;
      const previousScout = process.env.SIFT_EXPLORER_SCOUT;
      const previousFanout = process.env.SIFT_EXPLORER_FANOUT;
      await mkdir(join(root, 'src'), {recursive: true});
      await writeFile(join(root, 'package.json'), '{"name":"headless-explorer-fixture"}\n', 'utf8');
      await writeFile(join(root, 'src', 'fsEngine.ts'), 'export const marker = "local search";\n', 'utf8');
      await writeFile(join(root, 'src', 'brain.ts'), 'export const route = "local search routing";\n', 'utf8');
      await writeFile(join(root, 'src', 'scoutTarget.ts'), 'export const scoutMarker = "local search scout";\n', 'utf8');
      await writeFile(join(root, 'src', 'fanoutTarget.ts'), 'export const fanoutMarker = "local search fanout";\n', 'utf8');
      (globalThis as Record<string, unknown>).__EXECUTERM_OPENFUNCTION__ = {
        createChatAgent: async (config: Record<string, unknown>) => ({
          chat: async function* (message: unknown) {
            const name = String(config.name || '');
            if (name === 'siftable-repo-explorer-scout') {
              yield {
                type: 'text',
                text: JSON.stringify({
                  confidence: 0.77,
                  missingLikelyFiles: [{path: 'src/scoutTarget.ts', reason: 'scout-only related file'}],
                  recommendedReads: [{path: 'src/scoutTarget.ts', startLine: 1, endLine: 5, reason: 'verify scout suggestion'}],
                  warnings: [],
                }),
              };
              yield {type: 'done', result: {content: ''}};
              return;
            }
            if (name.startsWith('siftable-repo-explorer-fanout-')) {
              yield {
                type: 'text',
                text: JSON.stringify({
                  confidence: 0.78,
                  missingLikelyFiles: [{path: 'src/fanoutTarget.ts', reason: `${name} related file`}],
                  recommendedReads: [{path: 'src/fanoutTarget.ts', startLine: 1, endLine: 5, reason: 'verify fanout suggestion'}],
                  warnings: [],
                }),
              };
              yield {type: 'done', result: {content: ''}};
              return;
            }
            capturedInput = message;
            if (String(message).includes('src/fanoutTarget.ts')) {
              yield {type: 'tool_call', toolCall: {name: 'read_file', args: {path: 'src/fanoutTarget.ts'}}};
              yield {type: 'tool_result', toolResult: {name: 'read_file', success: true}};
            } else if (String(message).includes('src/scoutTarget.ts')) {
              yield {type: 'tool_call', toolCall: {name: 'read_file', args: {path: 'src/scoutTarget.ts'}}};
              yield {type: 'tool_result', toolResult: {name: 'read_file', success: true}};
            } else if (String(message).includes('src/fsEngine.ts')) {
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
      process.env.SIFT_EXPLORER_SCOUT = '1';
      delete process.env.SIFT_EXPLORER_FANOUT;
      setBrainModel({provider: 'openrouter', model: 'headless-smoke'});

      try {
        const client = new LocalControlClient();
        const broadEvents: SseEvent[] = [];
        await client.send('scour this repo and explain how local search works', (event) => broadEvents.push(event));

        expect(broadEvents.some((event) => event.toolCall?.name === 'repo_explorer')).toBe(true);
        expect(broadEvents.some((event) => event.toolCall?.name === 'repo_explorer_scout')).toBe(true);
        expect(broadEvents.some((event) => event.toolResult?.name === 'repo_explorer')).toBe(true);
        expect(broadEvents.find((event) => event.toolResult?.name === 'repo_explorer_scout')?.toolResult?.success).toBe(true);
        expect(broadEvents.find((event) => event.toolResult?.name === 'repo_explorer')?.toolResult?.output).toContain('char report');
        expect(broadEvents.some((event) => event.toolCall?.name === 'read_file')).toBe(true);
        expect(String(capturedInput)).toContain('<repo_explorer_report>');
        expect(String(capturedInput)).toContain('Metrics:');
        expect(String(capturedInput)).toContain('src/fsEngine.ts');
        expect(String(capturedInput)).toContain('model_scout:');
        expect(String(capturedInput)).toContain('src/scoutTarget.ts');

        capturedInput = undefined;
        process.env.SIFT_EXPLORER_FANOUT = '1';
        const fanoutEvents: SseEvent[] = [];
        await client.send('scour this repo and explain how local search works', (event) => fanoutEvents.push(event));
        expect(fanoutEvents.some((event) => event.toolCall?.name === 'repo_explorer_fanout')).toBe(true);
        expect(fanoutEvents.some((event) => event.toolCall?.name === 'repo_explorer_scout')).toBe(false);
        expect(fanoutEvents.find((event) => event.toolResult?.name === 'repo_explorer_fanout')?.toolResult?.success).toBe(true);
        expect(fanoutEvents.some((event) => event.toolCall?.name === 'read_file')).toBe(true);
        expect(String(capturedInput)).toContain('parallel_scouts:');
        expect(String(capturedInput)).toContain('src/fanoutTarget.ts');

        capturedInput = undefined;
        const ordinaryEvents: SseEvent[] = [];
        await client.send('explain why Napoleon lost in Russia', (event) => ordinaryEvents.push(event));
        expect(ordinaryEvents.some((event) => event.toolCall?.name === 'repo_explorer')).toBe(false);
        expect(ordinaryEvents.some((event) => event.toolCall?.name === 'repo_explorer_scout')).toBe(false);
        expect(ordinaryEvents.some((event) => event.toolCall?.name === 'repo_explorer_fanout')).toBe(false);
        expect(String(capturedInput)).not.toContain('<repo_explorer_report>');

        capturedInput = undefined;
        process.env.SIFT_EXPLORER = 'off';
        const disabledEvents: SseEvent[] = [];
        await client.send('scour this repo and explain how local search works', (event) => disabledEvents.push(event));
        expect(disabledEvents.some((event) => event.toolCall?.name === 'repo_explorer')).toBe(false);
        expect(disabledEvents.some((event) => event.toolCall?.name === 'repo_explorer_scout')).toBe(false);
        expect(disabledEvents.some((event) => event.toolCall?.name === 'repo_explorer_fanout')).toBe(false);
        expect(String(capturedInput)).not.toContain('<repo_explorer_report>');
      } finally {
        if (previousCwd === undefined) delete process.env.SIFT_USER_CWD;
        else process.env.SIFT_USER_CWD = previousCwd;
        if (previousExplorer === undefined) delete process.env.SIFT_EXPLORER;
        else process.env.SIFT_EXPLORER = previousExplorer;
        if (previousScout === undefined) delete process.env.SIFT_EXPLORER_SCOUT;
        else process.env.SIFT_EXPLORER_SCOUT = previousScout;
        if (previousFanout === undefined) delete process.env.SIFT_EXPLORER_FANOUT;
        else process.env.SIFT_EXPLORER_FANOUT = previousFanout;
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

  describe('compact()', () => {
    it('delegates to the brain compaction and returns its report', async () => {
      const report = {engine: 'openfunction' as const, ran: true, beforeTokens: 100, afterTokens: 40, prunedMessages: 0, summarized: true};
      const compact = jest.fn(async () => report);
      const client = new LocalControlClient({compact});
      const result = await client.compact();
      expect(compact).toHaveBeenCalledTimes(1);
      expect(result).toEqual(report);
    });
  });
});

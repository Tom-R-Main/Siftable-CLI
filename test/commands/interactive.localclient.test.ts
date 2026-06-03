import {LocalControlClient} from '../../interactive-tui/localControlClient';
import type {BrainEvent, BrainAskResult} from '../../interactive-tui/brain';
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

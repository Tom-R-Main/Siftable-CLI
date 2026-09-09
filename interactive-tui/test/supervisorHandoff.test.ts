import {describe, expect, test} from 'bun:test';
import {PassThrough} from 'node:stream';
import {SupervisorHandoff} from '../supervisorHandoff';

const identity = {session: 'session-fixture', runId: 'run-fixture'};
describe('private supervisor handoff', () => {
  test('accepts only a release matching the active session and invocation', async () => {
    const input = new PassThrough();
    const errors: Error[] = [];
    const channel = new SupervisorHandoff(input, identity, error => errors.push(error));
    const pending = channel.wait(1000, new AbortController().signal, event => {
      expect(event).toMatchObject({type: 'handoff.ready', ...identity, modelStatus: 'completed'});
      input.write(JSON.stringify({type: 'handoff.release', ...identity}) + '\n');
    });
    await pending;
    expect(errors).toHaveLength(0);
    expect(input.listenerCount('data')).toBe(0);
    input.destroy();
  });

  for (const mode of ['EOF', 'wrong-session', 'wrong-run', 'malformed', 'oversized', 'abort', 'timeout', 'premature', 'extra-command']) {
    test(`fails closed on ${mode}`, async () => {
      const input = new PassThrough();
      const errors: Error[] = [];
      const channel = new SupervisorHandoff(input, identity, error => errors.push(error));
      const release = JSON.stringify({type: 'handoff.release', ...identity});
      if (mode === 'premature') input.write(release + '\n');
      const pending = channel.wait(20, new AbortController().signal, () => {
        if (mode === 'EOF') input.end();
        if (mode === 'wrong-session') input.write(JSON.stringify({type: 'handoff.release', ...identity, session: 'other'}) + '\n');
        if (mode === 'wrong-run') input.write(JSON.stringify({type: 'handoff.release', ...identity, runId: 'stale'}) + '\n');
        if (mode === 'malformed') input.write('not-json\n');
        if (mode === 'oversized') input.write('x'.repeat(4097));
        if (mode === 'abort') input.write(JSON.stringify({type: 'handoff.abort', ...identity}) + '\n');
        if (mode === 'extra-command') input.write(release + '\n' + release + '\n');
      });
      await expect(pending).rejects.toThrow();
      expect(errors).toHaveLength(1);
      expect(input.listenerCount('data')).toBe(0);
      input.destroy();
    });
  }
  test('signal cancellation settles without reclassifying interruption as protocol failure', async () => {
    const input = new PassThrough();
    const controller = new AbortController();
    let failures = 0;
    const channel = new SupervisorHandoff(input, identity, () => failures++);
    const pending = channel.wait(1000, controller.signal, () => controller.abort());
    await expect(pending).rejects.toThrow('interrupted');
    expect(failures).toBe(0);
    input.destroy();
  });
});

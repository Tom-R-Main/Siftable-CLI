import {describe, expect, it} from 'vitest';
import {createHostDocker, DEADLINE_EXIT} from './hostDocker.js';

describe('createHostDocker', () => {
  const clock = (mono: number) => ({wallMs: () => 0, monoMs: () => mono});

  it('gives each call only the time left before an absolute deadline', async () => {
    const timeouts: number[] = [];
    const docker = createHostDocker({clock: clock(1_000), exec: async (_args, timeoutMs) => {
      timeouts.push(timeoutMs);
      return {code: 0, stdout: '', stderr: ''};
    }});
    await docker(['kill', 'abc'], {deadlineMono: 4_500});
    await docker(['ps']);
    expect(timeouts).toEqual([3_500, 120_000]);
  });

  it('does not start a call once the deadline has passed', async () => {
    let ran = false;
    const docker = createHostDocker({clock: clock(5_000), exec: async () => { ran = true; return {code: 0, stdout: '', stderr: ''}; }});
    expect(await docker(['rm', 'abc'], {deadlineMono: 5_000})).toMatchObject({code: DEADLINE_EXIT});
    expect(ran).toBe(false);
  });
});

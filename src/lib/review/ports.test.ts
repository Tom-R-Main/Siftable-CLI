import {describe, expect, it} from 'vitest';
import {killActiveProcessGroups, processRunner} from './ports.js';

const env = {PATH: '/usr/bin:/bin'};

describe('review process ports', () => {
  it('caps stdout and stops the process group', async () => {
    const result = await processRunner({
      command: '/bin/sh',
      args: ['-c', 'yes sift-review'],
      cwd: '/',
      env,
      signal: new AbortController().signal,
      timeoutMs: 10_000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
    });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBe(1024);
  });

  it('kills running process groups when the review is interrupted', async () => {
    const running = processRunner({
      command: '/bin/sh',
      args: ['-c', 'sleep 30 & wait'],
      cwd: '/',
      env,
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(killActiveProcessGroups()).toBe(1);
    const result = await running;
    expect(result.signal).toBe('SIGKILL');
    expect(killActiveProcessGroups()).toBe(0);
  });
});

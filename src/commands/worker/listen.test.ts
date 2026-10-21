import {describe, expect, it} from 'vitest';
import WorkerListen, {checkpointEnvironment} from './listen.js';

// The mobile app's "Set up a computer" screen prints a `sift worker listen`
// command (apps/mobile/src/features/work/runners.ts). These flags are that
// command's contract: renaming or requiring another flag breaks the setup
// instructions users follow, so change both together.
describe('sift worker listen flag contract', () => {
  const flags = WorkerListen.flags as Record<string, {required?: boolean; multiple?: boolean}>;

  it('requires exactly the host inputs the setup command supplies', () => {
    const required = Object.entries(flags).filter(([, flag]) => flag.required).map(([name]) => name).sort();
    expect(required).toEqual(['cwd', 'executable', 'name', 'receipts', 'runner']);
  });

  it('accepts the optional scope flags the setup command may add', () => {
    expect(flags['agent-alias-id']).toBeDefined();
    expect(flags.workspace).toBeDefined();
    expect(flags['agent-alias-id'].required).toBeFalsy();
    expect(flags.workspace.required).toBeFalsy();
  });

  it('keeps fixed executable arguments host-side and repeatable', () => {
    expect(flags.arg.multiple).toBe(true);
    expect(flags['checkpoint-arg'].multiple).toBe(true);
  });
});

describe('sift worker listen checkpoint environment', () => {
  it('passes the durable control ID with the work item and nothing else', () => {
    const env = checkpointEnvironment({id: 'work-1', claimToken: 'synthetic-claim'}, '33333333-3333-4333-8333-333333333333');
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'SIFT_CONTROL_ID', 'SIFT_WORK_ITEM_ID', 'TMPDIR']);
    expect(env.SIFT_CONTROL_ID).toBe('33333333-3333-4333-8333-333333333333');
    expect(env.SIFT_WORK_ITEM_ID).toBe('work-1');
    expect(JSON.stringify(env)).not.toContain('synthetic-claim');
  });
});

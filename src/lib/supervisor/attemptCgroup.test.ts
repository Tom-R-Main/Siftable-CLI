import {describe, expect, it} from 'vitest';
import {
  attemptSliceCgroup,
  attemptSliceName,
  cgroupSetupProblem,
  isInsideAttemptSlice,
  parseCgroupV2,
  readPopulated,
  waitForEmpty,
} from './attemptCgroup.js';
import type {SupervisorClock} from './superviseAuthority.js';

const ATTEMPT = '5f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5';
const SLICE = '/siftable.slice/siftable-a5f1c2d3e4a5b.slice';

describe('attempt slice', () => {
  it('names a per-attempt slice nested under siftable.slice', () => {
    expect(attemptSliceName(ATTEMPT)).toBe('siftable-a5f1c2d3e4a5b.slice');
    expect(attemptSliceCgroup(ATTEMPT)).toBe(SLICE);
    expect(() => attemptSliceName('../etc')).toThrow(/UUID/);
  });

  it('accepts only a scope inside this attempt\'s slice', () => {
    const own = parseCgroupV2(`0::${SLICE}/docker-abc.scope\n`);
    expect(isInsideAttemptSlice(own, ATTEMPT)).toBe(true);
    expect(isInsideAttemptSlice(parseCgroupV2('0::/siftable.slice/docker-abc.scope\n'), ATTEMPT)).toBe(false);
    expect(isInsideAttemptSlice(parseCgroupV2(`0::${SLICE}\n`), ATTEMPT)).toBe(false);
    expect(isInsideAttemptSlice(parseCgroupV2(`0::${SLICE}x/docker-abc.scope\n`), ATTEMPT)).toBe(false);
    expect(parseCgroupV2('12:memory:/docker/abc\n0::/\n')).toBeNull();
  });

  it('requires cgroup v2 and the systemd driver', () => {
    expect(cgroupSetupProblem({CgroupDriver: 'systemd', CgroupVersion: '2'})).toBeNull();
    expect(cgroupSetupProblem({CgroupDriver: 'cgroupfs', CgroupVersion: '2'})).toBe('systemd_cgroup_driver_required');
    expect(cgroupSetupProblem({CgroupDriver: 'systemd', CgroupVersion: '1'})).toBe('cgroup_v2_required');
  });
});

describe('emptiness', () => {
  const missing = Object.assign(new Error('gone'), {code: 'ENOENT'});
  const denied = Object.assign(new Error('denied'), {code: 'EACCES'});

  it('reads populated from cgroup.events; a removed slice is empty, an unreadable one unknown', async () => {
    expect(await readPopulated(async (file) => {
      expect(file).toBe(`/sys/fs/cgroup${SLICE}/cgroup.events`);
      return 'populated 1\nfrozen 0\n';
    }, ATTEMPT)).toBe(true);
    expect(await readPopulated(async () => 'populated 0\n', ATTEMPT)).toBe(false);
    expect(await readPopulated(async () => { throw missing; }, ATTEMPT)).toBe(false);
    expect(await readPopulated(async () => { throw denied; }, ATTEMPT)).toBeNull();
    expect(await readPopulated(async () => 'frozen 0\n', ATTEMPT)).toBeNull();
  });

  it('waits until empty, or reports populated or unknown at the deadline', async () => {
    let mono = 0;
    const clock: SupervisorClock = {wallMs: () => mono, monoMs: () => (mono += 10)};
    let reads = 0;
    expect(await waitForEmpty(async () => (++reads < 3 ? 'populated 1\n' : 'populated 0\n'), ATTEMPT, clock, 1_000, 1)).toBe('empty');
    mono = 0;
    expect(await waitForEmpty(async () => 'populated 1\n', ATTEMPT, clock, 50, 1)).toBe('populated');
    mono = 0;
    expect(await waitForEmpty(async () => { throw denied; }, ATTEMPT, clock, 50, 1)).toBe('unknown');
  });
});

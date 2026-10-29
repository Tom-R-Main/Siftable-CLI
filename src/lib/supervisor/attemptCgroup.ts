/**
 * The attempt's own cgroup (first-run U2d-2). Both of an attempt's containers
 * are created with `--cgroup-parent siftable-a<12 hex>.slice`; under Docker's
 * systemd driver the dash nests that slice under `siftable.slice`. Kill and
 * emptiness checks act only on that bound path, never on the shared parent.
 */
import type {SupervisorClock} from './superviseAuthority.js';

export const CGROUP_ROOT = '/sys/fs/cgroup';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function attemptSliceName(attemptId: string): string {
  if (!UUID.test(attemptId)) throw new Error('attemptId must be a UUID');
  return `siftable-a${attemptId.replace(/-/g, '').slice(0, 12).toLowerCase()}.slice`;
}

/** The slice's path inside the cgroup v2 hierarchy, as `/proc/<pid>/cgroup` shows it. */
export function attemptSliceCgroup(attemptId: string): string {
  return `/siftable.slice/${attemptSliceName(attemptId)}`;
}

/** The cgroup v2 path from `/proc/<pid>/cgroup`, or null on a v1 or hybrid host. */
export function parseCgroupV2(procCgroup: string): string | null {
  const lines = procCgroup.split('\n').filter(Boolean);
  if (lines.length !== 1 || !lines[0].startsWith('0::/')) return null;
  return lines[0].slice(3);
}

/** True when `cgroup` is a scope inside this attempt's slice (not the slice itself, not a sibling). */
export function isInsideAttemptSlice(cgroup: string | null, attemptId: string): boolean {
  return cgroup !== null && cgroup.startsWith(`${attemptSliceCgroup(attemptId)}/`);
}

/**
 * `docker info` must report cgroup v2 under the systemd driver, or the slice
 * name above does not mean what this module assumes.
 */
export function cgroupSetupProblem(dockerInfo: {CgroupDriver?: unknown; CgroupVersion?: unknown}): string | null {
  if (String(dockerInfo.CgroupVersion) !== '2') return 'cgroup_v2_required';
  if (dockerInfo.CgroupDriver !== 'systemd') return 'systemd_cgroup_driver_required';
  return null;
}

export type ReadFile = (file: string) => Promise<string>;

/**
 * `populated` from the slice's `cgroup.events`; null when it cannot be read.
 * A missing slice reads as empty, so callers ask only after binding the slice
 * from both containers' `/proc/<pid>/cgroup`.
 */
export async function readPopulated(read: ReadFile, attemptId: string): Promise<boolean | null> {
  let events: string;
  try {
    events = await read(`${CGROUP_ROOT}${attemptSliceCgroup(attemptId)}/cgroup.events`);
  } catch (error) {
    // systemd removes an empty transient slice; its absence means nothing is left in it.
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? false : null;
  }
  const line = events.split('\n').find((entry) => entry.startsWith('populated '));
  if (line === 'populated 0') return false;
  if (line === 'populated 1') return true;
  return null;
}

export type Emptiness = 'empty' | 'populated' | 'unknown';

/** Polls until the slice is empty or the absolute deadline passes. */
export async function waitForEmpty(
  read: ReadFile, attemptId: string, clock: SupervisorClock, deadlineMono: number, pollMs = 100,
): Promise<Emptiness> {
  for (;;) {
    const last = await readPopulated(read, attemptId);
    if (last === false) return 'empty';
    const remaining = deadlineMono - clock.monoMs();
    if (remaining <= 0) return last === true ? 'populated' : 'unknown';
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
}

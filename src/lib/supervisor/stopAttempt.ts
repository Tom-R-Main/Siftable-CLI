/**
 * Stops one attempt's containers (first-run U2d-2). The 10 s budget is one
 * absolute deadline across the kills and the emptiness check. Stopped
 * processes, an empty owned cgroup and removed resources are separate facts;
 * a Stop is acknowledgeable only when the cgroup was observed empty.
 */
import {type Emptiness, type ReadFile, waitForEmpty} from './attemptCgroup.js';
import type {DeadlineDocker} from './hostDocker.js';
import type {SupervisorClock} from './superviseAuthority.js';

export const STOP_BUDGET_MS = 10_000;
/** Removal follows a proven-empty cgroup; it may take longer than the kill budget. */
export const REMOVE_BUDGET_MS = 30_000;

export interface OwnedAttempt {
  attemptId: string;
  /** Full container IDs, as `container create` returned them. */
  containers: string[];
  networkId?: string;
}

export interface StopFacts {
  /** Observed, not inferred from kill exit codes: the attempt cgroup was empty. */
  processesStopped: boolean;
  cgroupEmpty: Emptiness;
  /** Containers and network removed by exact ID. */
  resourcesRemoved: boolean;
  /** What is still ours and could not be shown gone. */
  held: string[];
}

const gone = (stderr: string) => /No such container|is not running|No such network|not found/i.test(stderr);

export async function stopAttempt(
  deps: {docker: DeadlineDocker; clock: SupervisorClock; readFile: ReadFile; pollMs?: number},
  attempt: OwnedAttempt,
): Promise<StopFacts> {
  const deadlineMono = deps.clock.monoMs() + STOP_BUDGET_MS;
  for (const id of attempt.containers) {
    // A kill's exit code proves nothing either way; the cgroup below decides.
    await deps.docker(['container', 'kill', '--signal', 'KILL', id], {deadlineMono});
  }
  const cgroupEmpty = await waitForEmpty(deps.readFile, attempt.attemptId, deps.clock, deadlineMono, deps.pollMs);
  if (cgroupEmpty !== 'empty') {
    // Nothing is removed while something may still run in the attempt's cgroup.
    return {processesStopped: false, cgroupEmpty, resourcesRemoved: false,
      held: [`cgroup:${attempt.attemptId}`, ...attempt.containers.map((id) => `container:${id}`),
        ...(attempt.networkId ? [`network:${attempt.networkId}`] : [])]};
  }
  const removeBy = deps.clock.monoMs() + REMOVE_BUDGET_MS;
  const held: string[] = [];
  for (const id of attempt.containers) {
    const removed = await deps.docker(['container', 'rm', '--force', '--volumes', id], {deadlineMono: removeBy});
    if (removed.code !== 0 && !gone(removed.stderr)) held.push(`container:${id}`);
  }
  if (attempt.networkId) {
    const removed = await deps.docker(['network', 'rm', attempt.networkId], {deadlineMono: removeBy});
    if (removed.code !== 0 && !gone(removed.stderr)) held.push(`network:${attempt.networkId}`);
  }
  return {processesStopped: true, cgroupEmpty, resourcesRemoved: held.length === 0, held};
}

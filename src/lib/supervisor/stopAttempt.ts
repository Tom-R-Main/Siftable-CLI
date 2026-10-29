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

/** What else a run owns, found by its label; `complete` is false when the listing could not be trusted. */
export type Discover = (deadlineMono: number) => Promise<{containers: string[]; networkIds: string[]; complete: boolean}>;

export async function stopAttempt(
  deps: {docker: DeadlineDocker; clock: SupervisorClock; readFile: ReadFile; pollMs?: number},
  known: OwnedAttempt,
  discover?: Discover,
): Promise<StopFacts> {
  const deadlineMono = deps.clock.monoMs() + STOP_BUDGET_MS;
  const kill = async (ids: string[]) => {
    for (const id of ids) {
      // A kill's exit code proves nothing either way; the cgroup below decides.
      await deps.docker(['container', 'kill', '--signal', 'KILL', id], {deadlineMono});
    }
  };
  // Known IDs first, at once; discovery shares the same deadline and never delays them.
  await kill(known.containers);
  const found = discover ? await discover(deadlineMono) : {containers: [], networkIds: [], complete: true};
  const extra = found.containers.filter((id) => !known.containers.includes(id));
  await kill(extra);
  const attempt: OwnedAttempt = {
    attemptId: known.attemptId, containers: [...known.containers, ...extra],
    networkId: known.networkId ?? found.networkIds[0],
  };
  const extraNetworks = found.networkIds.filter((id) => id !== attempt.networkId);
  const incomplete = found.complete ? [] : [`run:${known.attemptId}`];
  const cgroupEmpty = await waitForEmpty(deps.readFile, attempt.attemptId, deps.clock, deadlineMono, deps.pollMs);
  if (cgroupEmpty !== 'empty') {
    // Nothing is removed while something may still run in the attempt's cgroup.
    return {processesStopped: false, cgroupEmpty, resourcesRemoved: false,
      held: [`cgroup:${attempt.attemptId}`, ...attempt.containers.map((id) => `container:${id}`),
        ...[attempt.networkId, ...extraNetworks].filter(Boolean).map((id) => `network:${String(id)}`), ...incomplete]};
  }
  const removeBy = deps.clock.monoMs() + REMOVE_BUDGET_MS;
  const held: string[] = [];
  for (const id of attempt.containers) {
    const removed = await deps.docker(['container', 'rm', '--force', '--volumes', id], {deadlineMono: removeBy});
    if (removed.code !== 0 && !gone(removed.stderr)) held.push(`container:${id}`);
  }
  for (const id of [attempt.networkId, ...extraNetworks].filter((value): value is string => Boolean(value))) {
    const removed = await deps.docker(['network', 'rm', id], {deadlineMono: removeBy});
    if (removed.code !== 0 && !gone(removed.stderr)) held.push(`network:${id}`);
  }
  held.push(...incomplete);
  return {processesStopped: true, cgroupEmpty, resourcesRemoved: held.length === 0, held};
}

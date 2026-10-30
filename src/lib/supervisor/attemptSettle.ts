/**
 * Teardown and its receipts, shared by a running attempt's stop and by
 * recovery (first-run U2d-2, U2d-3b). Moved out of superviseLoop.ts unchanged
 * (U5b-2c) to make room for the checkout.
 */
import {inspectMachineState, writeJournal} from './machineState.js';
import {type CleanupFacts, type OutboxEntry, enqueueReceipts, flushReceipts, receiptsForStop} from './cleanupReceiptOutbox.js';
import {STOP_BUDGET_MS, type StopFacts, stopAttempt} from './stopAttempt.js';
import type {AttemptJournal, StopReason, SuperviseDeps} from './superviseLoop.js';

export const JOURNAL = 'attempt-journal.json';

export class SuperviseError extends Error {}

export const writeAttemptJournal = (deps: SuperviseDeps, journal: AttemptJournal) =>
  (deps.writeJournal ? deps.writeJournal(journal) : writeJournal(deps.state, JOURNAL, journal));

/** Everything a crashed or held run left, by exact ID and by its run label, within a deadline. */
export async function ownedResources(deps: SuperviseDeps, journal: AttemptJournal, deadlineMono?: number) {
  const label = `label=sift.machine.run=${journal.runId}`;
  const listed = await deps.docker(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', label], {deadlineMono});
  const networks = await deps.docker(['network', 'ls', '--quiet', '--no-trunc', '--filter', label], {deadlineMono});
  const containers = new Set([...Object.values(journal.containers).filter(Boolean) as string[],
    ...(listed.code === 0 ? listed.stdout.split('\n').map((id) => id.trim()).filter(Boolean) : [])]);
  const networkIds = new Set([...(journal.networkId ? [journal.networkId] : []),
    ...(networks.code === 0 ? networks.stdout.split('\n').map((id) => id.trim()).filter(Boolean) : [])]);
  return {containers: [...containers], networkIds: [...networkIds], complete: listed.code === 0 && networks.code === 0};
}

/** The fixed name each create used, so an unanswered create can be looked for later. */
export type CreateRole = 'network' | 'sidecar' | 'agent' | 'fetch' | 'checkout' | 'patch' | 'volume' | 'install-net' | 'egress' | 'proxy'
  | 'install';
export const NETWORK_ROLES = new Set<CreateRole>(['network', 'fetch', 'install-net', 'egress']);

export function createName(runId: string, role: CreateRole): string {
  if (role === 'volume') return `sift-a-${runId}-fs`;
  if (role === 'network') return `sift-a-${runId}`;
  return `sift-a-${runId}-${role === 'sidecar' ? 'relay' : role === 'install-net' ? 'install' : role}`;
}

/**
 * Roles of unanswered creates still unresolved: a resource found under the
 * create's exact name settles it (the label sweep then removes it); one not
 * found stays unknown, because an outstanding request may still finish.
 */
export async function unresolvedCreates(deps: SuperviseDeps, journal: AttemptJournal): Promise<CreateRole[]> {
  const unresolved: CreateRole[] = [];
  for (const role of journal.pendingCreates ?? []) {
    const name = createName(journal.runId, role);
    // A volume is found by its exact name; the release that follows verifies it is ours before removing it.
    if (role === 'volume') {
      const shown = await deps.docker(['volume', 'inspect', name]);
      if (shown.code !== 0) unresolved.push(role);
      continue;
    }
    const found = NETWORK_ROLES.has(role)
      ? await deps.docker(['network', 'ls', '--quiet', '--no-trunc', '--filter', `name=^${name}$`])
      : await deps.docker(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `name=^/${name}$`]);
    if (found.code !== 0 || !found.stdout.trim()) unresolved.push(role);
  }
  return unresolved;
}

/**
 * Every receipt this attempt owes after this stop (U2d-3b): the ones the
 * journal already froze, plus what this stop adds. Keys are numbered from the
 * journal's own record, so the obligation never depends on reading the
 * outbox. A create that never answered counts as held, so `cleaned` is never
 * claimed while a daemon request might still finish. An attempt that was
 * never attached has nothing to report.
 */
export async function receiptsOwed(deps: SuperviseDeps, journal: AttemptJournal, facts: StopFacts): Promise<CleanupFacts[]> {
  const carried = journal.receipts ?? [];
  if (!journal.attemptId) return carried;
  const state = await inspectMachineState(deps.state);
  // An attached attempt owes receipts; machine state that cannot say to whom leaves them unresolved, never empty.
  if (state.kind !== 'enrolled') throw new SuperviseError(`The machine state is ${state.kind}; the cleanup receipts cannot be worked out yet`);
  const {machine} = state;
  const unresolved = (journal.pendingCreates ?? []).map((role) => `create:${role}`);
  const held = [...facts.held, ...unresolved];
  const journaled = Object.values(journal.containers).filter(Boolean).length;
  const heldContainers = held.filter((item) => item.startsWith('container:')).length;
  const known: OutboxEntry[] = carried.map((owed) => ({enrollmentId: machine.enrollmentId, facts: owed, status: 'pending', sends: 0}));
  const fresh = receiptsForStop(
    {attemptId: journal.attemptId, workItemId: journal.workItemId, dispatchId: journal.dispatchId,
      orgId: machine.scope.type === 'workspace' ? machine.scope.id : null},
    {cgroupEmpty: facts.cgroupEmpty, resourcesRemoved: facts.resourcesRemoved && unresolved.length === 0, held,
      containersRemoved: facts.cgroupEmpty === 'empty' ? Math.max(0, journaled - heldContainers) : 0},
    known);
  return [...carried, ...fresh];
}

/**
 * Settles a journal's receipt obligation: works out this stop's receipts if
 * that failed earlier, then hands every frozen receipt to the outbox. Returns
 * the journal as written, or null when either step failed; the caller then
 * keeps the journal active, so the same facts and keys are retried instead
 * of being archived away.
 */
export async function ensureReceiptsQueued(deps: SuperviseDeps, journal: AttemptJournal): Promise<AttemptJournal | null> {
  let current = journal;
  try {
    if (current.receiptsDerived === false) {
      if (!current.stop?.facts) return null;
      const receipts = await receiptsOwed(deps, current, current.stop.facts);
      current = {...current, receipts, receiptsDerived: true, receiptsQueued: false};
      await writeAttemptJournal(deps, current);
    }
    if (current.receiptsQueued !== false) return current;
    // Worked out and nothing owed (an attempt that was never attached): settled.
    if (!current.receipts?.length) {
      current = {...current, receiptsQueued: true};
      await writeAttemptJournal(deps, current);
      return current;
    }
    const state = await inspectMachineState(deps.state);
    if (state.kind !== 'enrolled') return null;
    // Whether the attempt's filesystem is kept for recovery is a fact at queue time, which the caller defers
    // until evidence has decided it (U5b-2c). Receipts already in the outbox keep what they were queued with.
    const retained = Boolean(current.fs && current.fs.state !== 'released');
    const receipts = current.receipts.map((receipt) => ({...receipt, recoveryVolumeRetained: retained}));
    current = {...current, receipts};
    await enqueueReceipts(deps.state, state.machine.enrollmentId, receipts);
    current = {...current, receiptsQueued: true};
    await writeAttemptJournal(deps, current);
    return current;
  } catch (error) {
    deps.log(`Could not queue the cleanup receipts; the attempt stays journaled until they are: ${(error as Error).message}`);
    return null;
  }
}

/** Sends pending cleanup receipts, a bounded number per cycle. Never throws: they wait for the next cycle. */
export async function sendCleanupReceipts(deps: SuperviseDeps): Promise<void> {
  try {
    const state = await inspectMachineState(deps.state);
    if (state.kind !== 'enrolled') return;
    const {machine} = state;
    if (deps.shutdown?.aborted) return;
    await flushReceipts({fetch: deps.fetch, state: deps.state, apiUrl: machine.apiUrl, now: () => new Date(deps.clock.wallMs()),
      workspaceId: machine.scope.type === 'workspace' ? machine.scope.id : null, signal: deps.shutdown, budgetMs: 20_000});
  } catch (error) {
    deps.log(`Could not send cleanup receipts: ${(error as Error).message}`);
  }
}

/** Tears down a journal's run; returns what is still held. Never relaunches. */
export async function settle(
  deps: SuperviseDeps, journal: AttemptJournal, reason: StopReason, controlId?: string, pendingWrites: Promise<unknown> = Promise.resolve(),
  /** Leaves this stop's receipts unqueued: the caller queues them once it knows whether the attempt filesystem is kept. */
  deferReceipts = false,
): Promise<{facts: StopFacts; journal: AttemptJournal}> {
  // The workload's exit code survives a crash and a second sweep: recovery settles with it.
  const exitCode = journal.stop?.exitCode;
  const stop = {reason, ...(controlId ? {controlId} : {}), ...(exitCode === undefined ? {} : {exitCode})};
  let current: AttemptJournal = {...journal, state: 'stopping', stop};
  // The physical stop never waits on the journal, failed or slow: the `stopping` record is written in the
  // background, after any earlier write so an older snapshot cannot land last, and a failure is raised only
  // after kills and removal.
  let journalError: unknown;
  const stoppingWritten = pendingWrites.catch(() => undefined)
    .then(() => writeAttemptJournal(deps, current))
    .catch((error: unknown) => { journalError ??= error; });
  let facts: StopFacts;
  if (!current.attemptId) {
    const owned = await ownedResources(deps, current, deps.clock.monoMs() + STOP_BUDGET_MS);
    // No attempt slice was ever bound: nothing was started under it. Remove what was created.
    const held: string[] = owned.complete ? [] : [`run:${current.runId}`];
    for (const id of owned.containers) {
      const removed = await deps.docker(['container', 'rm', '--force', '--volumes', id]);
      if (removed.code !== 0 && !/No such container/i.test(removed.stderr)) held.push(`container:${id}`);
    }
    for (const id of owned.networkIds) {
      const removed = await deps.docker(['network', 'rm', id]);
      if (removed.code !== 0 && !/No such network|not found/i.test(removed.stderr)) held.push(`network:${id}`);
    }
    facts = {processesStopped: owned.containers.length === 0 || held.length === 0, cgroupEmpty: 'empty', resourcesRemoved: held.length === 0, held};
  } else {
    const journaled = current;
    facts = await stopAttempt(deps, {attemptId: current.attemptId,
      containers: Object.values(current.containers).filter((id): id is string => Boolean(id)), networkId: current.networkId},
    (deadlineMono) => ownedResources(deps, journaled, deadlineMono));
  }
  current = {...current, state: facts.held.length > 0 ? 'held' : 'stopping', stop: {...stop, facts}};
  // A failure to work out the receipts is an obligation, never an empty list: the frozen ones are kept, and
  // this stop's are worked out again from stop.facts before the journal may be archived.
  let derived = true;
  // How many receipts earlier stops already owed: a later re-derivation of this stop's keeps exactly these.
  const receiptsCarried = current.receipts?.length ?? 0;
  const receipts = await receiptsOwed(deps, current, facts).catch((error: unknown) => {
    deps.log(`Could not work out the cleanup receipts: ${(error as Error).message}`);
    derived = false;
    return current.receipts ?? [];
  });
  const added = receipts.length > (current.receipts?.length ?? 0);
  current = {...current, receipts, receiptsDerived: derived, receiptsCarried,
    receiptsQueued: !derived || added ? false : current.receiptsQueued ?? true};
  await stoppingWritten;
  await writeAttemptJournal(deps, current).catch((error: unknown) => { journalError ??= error; });
  if (journalError === undefined && !deferReceipts) current = await ensureReceiptsQueued(deps, current) ?? current;
  if (journalError !== undefined) {
    throw new SuperviseError(`The attempt was stopped (cgroup ${facts.cgroupEmpty}, resources ${facts.resourcesRemoved ? 'removed' : 'held'}), `
      + `but its journal could not be written: ${(journalError as Error).message}. The earlier journal is kept for the next start.`);
  }
  return {facts, journal: current};
}

/**
 * This stop's receipts worked out again from its final facts (a helper or release held after settle), keeping every
 * receipt an earlier stop already owed. Only for receipts not yet queued; queued ones keep what they were sent with.
 */
export async function rederiveReceipts(deps: SuperviseDeps, journal: AttemptJournal, facts: StopFacts): Promise<AttemptJournal> {
  if (journal.receiptsQueued !== false) return journal;
  const carried = (journal.receipts ?? []).slice(0, journal.receiptsCarried ?? journal.receipts?.length ?? 0);
  return {...journal, receipts: await receiptsOwed(deps, {...journal, receipts: carried}, facts), receiptsDerived: true};
}

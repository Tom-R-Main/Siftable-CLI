/**
 * The supervisor's cleanup receipts (first-run U2d-3b). After an attempt's
 * containers are stopped and removed, or held, the supervisor tells the
 * server through receipts signed with its enrollment key, which works after
 * the claim has ended and after the credential was revoked.
 *
 * Receipts wait in a durable outbox. Each one's facts and operation key are
 * frozen when it is queued; a send signs them with a fresh signedAt, so a
 * receipt whose reply was lost is re-sent as the same receipt, never under a
 * new key. Only an accepted answer or a definitive conflict ends it; no
 * reply, 429, 5xx or "still holds a live claim" leaves it pending. Each
 * cycle sends a bounded number, oldest first, so the outbox always makes
 * progress.
 *
 * The CLI keeps its own copy of the receipt protocol, asserted against the
 * same golden vector as the server's.
 */
import {createPrivateKey, sign} from 'node:crypto';
import {type MachineStateOptions, readJournal, readKey, writeJournal} from './machineState.js';
import {machineCanonicalJson} from './qualificationProtocol.js';

export const MACHINE_CLEANUP_RECEIPT_CONTEXT = 'sift.machine.cleanup-receipt.v1';
export const MACHINE_CLEANUP_RECEIPT_VERSION = 1;
export const OUTBOX = 'cleanup-receipts-journal.json';
const OUTBOX_LIMIT = 500;
const SEND_PER_CYCLE = 10;

export type CleanupState = 'execution_stopped' | 'cleaned' | 'cleanup_failed';

export interface CleanupFacts {
  attemptId: string;
  workItemId: string;
  dispatchId: string;
  orgId: string | null;
  state: CleanupState;
  reason: string | null;
  containersRemoved: number;
  recoveryVolumeRetained: boolean;
  operationKey: string;
}

export interface OutboxEntry {
  enrollmentId: string;
  facts: CleanupFacts;
  status: 'pending' | 'accepted' | 'conflict' | 'refused';
  sends: number;
  lastStatus?: number;
}

interface Outbox {
  version: 1;
  entries: OutboxEntry[];
}

/** The exact bytes signed: the envelope as canonical JSON (same as the server's protocol). */
export function cleanupReceiptSignedPayload(envelope: CleanupFacts & {enrollmentId: string; signedAt: string}): string {
  return machineCanonicalJson({context: MACHINE_CLEANUP_RECEIPT_CONTEXT, version: MACHINE_CLEANUP_RECEIPT_VERSION, ...envelope});
}

async function readOutbox(state: MachineStateOptions): Promise<Outbox> {
  return (await readJournal<Outbox>(state, OUTBOX)) ?? {version: 1, entries: []};
}

/**
 * What the stop of one attempt says, as receipts to queue. A stop observed
 * empty is `execution_stopped`; removal then makes `cleaned`, anything held
 * makes `cleanup_failed`. An unobservable or populated cgroup is reported
 * only as `cleanup_failed`; it is never claimed stopped.
 */
export function receiptsForStop(
  attempt: {attemptId: string; workItemId: string; dispatchId: string; orgId: string | null},
  facts: {cgroupEmpty: string; resourcesRemoved: boolean; held: string[]; containersRemoved: number},
  existing: OutboxEntry[],
): CleanupFacts[] {
  const next = (state: CleanupState) => {
    const used = existing.filter((entry) => entry.facts.attemptId === attempt.attemptId && entry.facts.state === state).length;
    return `${attempt.attemptId}:${state}:${used + 1}`;
  };
  const receipt = (state: CleanupState, reason: string | null, containersRemoved: number): CleanupFacts =>
    ({...attempt, state, reason, containersRemoved, recoveryVolumeRetained: false, operationKey: next(state)});
  const held = facts.held.join(', ').slice(0, 500) || null;
  if (facts.cgroupEmpty !== 'empty') return [receipt('cleanup_failed', held ?? `cgroup ${facts.cgroupEmpty}`, 0)];
  const stopped = existing.some((entry) => entry.facts.attemptId === attempt.attemptId && entry.facts.state === 'execution_stopped')
    ? [] : [receipt('execution_stopped', null, 0)];
  return [...stopped, facts.resourcesRemoved ? receipt('cleaned', null, facts.containersRemoved) : receipt('cleanup_failed', held, facts.containersRemoved)];
}

/** Queues receipts with their facts frozen. A receipt already queued under its key is left as it is. */
export async function enqueueReceipts(state: MachineStateOptions, enrollmentId: string, receipts: CleanupFacts[]): Promise<void> {
  if (receipts.length === 0) return;
  const outbox = await readOutbox(state);
  const known = new Set(outbox.entries.map((entry) => `${entry.facts.attemptId}|${entry.facts.operationKey}`));
  for (const facts of receipts) {
    if (!known.has(`${facts.attemptId}|${facts.operationKey}`)) outbox.entries.push({enrollmentId, facts, status: 'pending', sends: 0});
  }
  // Settled entries are dropped oldest first past the limit; pending ones are never dropped.
  let excess = outbox.entries.length - OUTBOX_LIMIT;
  outbox.entries = outbox.entries.filter((entry) => (excess > 0 && entry.status !== 'pending' ? (excess -= 1, false) : true));
  await writeJournal(state, OUTBOX, outbox);
}

export async function pendingReceipts(state: MachineStateOptions): Promise<OutboxEntry[]> {
  return (await readOutbox(state)).entries.filter((entry) => entry.status === 'pending');
}

/**
 * Sends up to SEND_PER_CYCLE pending receipts, oldest first, each signed
 * now. Returns how many it sent and how many stay pending.
 */
export async function flushReceipts(deps: {
  fetch: typeof fetch; state: MachineStateOptions; apiUrl: string; now: () => Date; workspaceId: string | null;
}): Promise<{sent: number; pending: number}> {
  const outbox = await readOutbox(deps.state);
  const due = outbox.entries.filter((entry) => entry.status === 'pending').slice(0, SEND_PER_CYCLE);
  if (due.length === 0) return {sent: 0, pending: 0};
  const pem = await readKey(deps.state);
  if (!pem) return {sent: 0, pending: due.length};
  const key = createPrivateKey(pem);
  for (const entry of due) {
    const receipt = {context: MACHINE_CLEANUP_RECEIPT_CONTEXT, version: MACHINE_CLEANUP_RECEIPT_VERSION,
      enrollmentId: entry.enrollmentId, ...entry.facts, signedAt: deps.now().toISOString()};
    const signature = sign(null, Buffer.from(cleanupReceiptSignedPayload(receipt)), key).toString('base64url');
    let status: number | undefined;
    let detail = '';
    try {
      const response = await deps.fetch(`${deps.apiUrl}/api/v1/machines/enrollments/${entry.enrollmentId}/cleanup-receipts`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: {'Content-Type': 'application/json', ...(deps.workspaceId ? {'X-Workspace-Id': deps.workspaceId} : {})},
        body: JSON.stringify({receipt, signature}),
      });
      status = response.status;
      detail = JSON.stringify(await response.json().catch(() => ({})));
    } catch {
      status = undefined;
    }
    entry.sends += 1;
    entry.lastStatus = status;
    if (status === 200 || status === 201) entry.status = 'accepted';
    // 409 for a dispatch that still holds its claim is not an answer about this receipt: try again later.
    else if (status === 409 && !/live claim/i.test(detail)) entry.status = 'conflict';
    // 400 is a malformed receipt and 403 an attempt this enrollment did not reserve: neither improves by resending.
    else if (status === 400 || status === 403) entry.status = 'refused';
    await writeJournal(deps.state, OUTBOX, outbox);
  }
  return {sent: due.length, pending: outbox.entries.filter((entry) => entry.status === 'pending').length};
}

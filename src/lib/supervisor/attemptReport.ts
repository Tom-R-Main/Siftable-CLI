/**
 * Telling the server how an attempt ended, under the dispatch's live claim (first-run U2d-2). Moved out of
 * superviseLoop.ts unchanged (U5b-2c) to keep that file within its line limit.
 */
import type {AttemptJournal, Settlement} from './superviseLoop.js';
import type {MachineRecord} from './machineState.js';
import {failureText, verificationFailure, verificationPassed} from './attemptVerifyRecords.js';

export interface ApiResult {status: number; body: Record<string, unknown>}

/** Machine identity and the authenticated API, read once per attempt. */
export interface Session {
  machine: MachineRecord;
  token: string;
  workspaceId: string | null;
  consumerId: string;
  call(method: 'GET' | 'POST', route: string, body?: unknown, options?: {key?: string; timeoutMs?: number; signal?: AbortSignal}): Promise<ApiResult>;
}

export function terminalReport(settlement: Settlement): {state: 'ended' | 'interrupted'; endReason?: 'lease_lost' | 'terminated' | 'failed'} {
  // A workload that exited cleanly but whose evidence was never acknowledged ended as failed.
  if (settlement.reason === 'workload_exited' && settlement.evidence?.acknowledged === false) return {state: 'ended', endReason: 'failed'};
  switch (settlement.reason) {
    case 'workload_exited': return settlement.exitCode === 0 ? {state: 'ended'} : {state: 'ended', endReason: 'failed'};
    case 'stop_control': return {state: 'ended', endReason: 'terminated'};
    case 'lease_lost': return {state: 'interrupted', endReason: 'lease_lost'};
    case 'shutdown': return {state: 'interrupted', endReason: 'terminated'};
    default: return {state: 'ended', endReason: 'failed'};
  }
}

/**
 * 200 confirms. 409 is the server's definitive refusal (for example an
 * attempt that was never recorded cannot be ended) and is kept as a surfaced
 * conflict. Everything else, including 401 and 403 from a revoked credential,
 * leaves the item pending: no transition happened on the server.
 */
export const settledStatus = (status: number | undefined): 'done' | 'conflict' | 'pending' => {
  if (status === 200) return 'done';
  if (status === 409) return 'conflict';
  return 'pending';
};

/** The failed-start ack: a start verification blocked (the base test already passes, say) tells the user why. */
export function failedStartAck(workspaceId: string | null, claimToken: string, journal: Pick<AttemptJournal, 'verification'>) {
  const blocked = verificationFailure(journal.verification);
  return {workspaceId, claimToken, state: 'failed' as const, ...(blocked ? {reason: blocked.reason, detail: blocked.detail} : {})};
}

export const conflictsOf = (settlement: Settlement | undefined): string[] => (settlement
  ? [...(settlement.attemptReport === 'conflict' ? ['attempt_report'] : []), ...(settlement.work === 'conflict' ? ['work_result'] : [])]
  : []);

/**
 * Tells the server how the attempt ended, using the dispatch's live claim.
 * Returns the updated settlement; anything not confirmed stays pending.
 */
export async function postSettlement(
  session: Session, journal: AttemptJournal, claimToken: string, timeoutMs: number,
): Promise<Settlement> {
  const settlement = {...(journal.settlement as Settlement)};
  const {workspaceId, machine} = session;
  const claimOwner = `mobile-runner:${machine.runnerId}`;
  const options = (key: string) => ({key, timeoutMs});
  // Without the attach workspace the server cannot match the attempt; nothing can be reported for it.
  if (settlement.attemptReport === 'pending' && !journal.workspace) settlement.attemptReport = 'skipped';
  if (settlement.attemptReport === 'pending' && journal.workspace) {
    const terminal = terminalReport(settlement);
    const reply = await session.call('POST', `/api/v1/work-items/${journal.workItemId}/execution-attempts`, {
      runtimeId: journal.runtimeId, leaseGeneration: 1, state: terminal.state, claimOwner, claimToken, dispatchId: journal.dispatchId,
      workspace: journal.workspace, ...(terminal.endReason ? {endReason: terminal.endReason} : {}),
    }, options(`${journal.runtimeId}:1:${terminal.state}`)).catch(() => null);
    settlement.attemptReport = settledStatus(reply?.status);
  }
  if (settlement.work === 'pending') {
    let reply: ApiResult | null;
    if (!settlement.started) {
      // Nothing ran: a failed start is the truth.
      reply = await session.call('POST', `/api/v1/work-items/dispatches/${journal.dispatchId}/ack`,
        failedStartAck(workspaceId, claimToken, journal), options(`${journal.dispatchId}:start-failed`)).catch(() => null);
    } else if (settlement.reason === 'stop_control' && settlement.controlId) {
      if (!settlement.cgroupEmpty) return settlement;
      // Acknowledged only on an observed empty cgroup; the server then cancels the work item.
      reply = await session.call('POST', `/api/v1/work-items/dispatches/${journal.dispatchId}/controls/ack`,
        {workspaceId, controlId: settlement.controlId, claimToken, state: 'acknowledged'}, options(`${settlement.controlId}:ack`)).catch(() => null);
    } else if (settlement.reason === 'workload_exited' && settlement.exitCode === 0 && settlement.evidence?.acknowledged !== false
      && verificationPassed(journal.verification)) {
      const manifestDigest = settlement.evidence?.manifestDigest;
      reply = await session.call('POST', `/api/v1/work-items/${journal.workItemId}/review`, {
        workspaceId, claimOwner, claimToken,
        resultSummary: journal.verification
          ? 'Verified: the selected test failed on the base commit and passes with the patch, and the test suite passes. The log, patch and verifier log are the acknowledged evidence.'
          : manifestDigest
            ? 'The workload exited 0. Its log is the acknowledged evidence; there is no checkout, patch or verifier result yet.'
            : 'The workload exited 0. The supervisor collected no deliverable; verification and evidence are later units.',
        artifactRefs: [{type: 'worker_run', dispatchId: journal.dispatchId, attemptId: journal.attemptId, exitCode: 0},
          ...(manifestDigest ? [{type: 'evidence_manifest', attemptId: journal.attemptId, manifestDigest}] : [])],
        durableMemory: {decision: 'skip', rationale: 'A supervised run does not infer durable knowledge from process completion'},
      }, options(`${journal.dispatchId}:review`)).catch(() => null);
    } else {
      const failed = verificationFailure(journal.verification);
      const failureReason = settlement.reason === 'workload_exited' && settlement.exitCode === 0 && settlement.evidence?.acknowledged === false
        ? 'The workload exited 0, but its evidence upload failed (evidence_upload_failed); the log is kept on the machine.'
        : failed ? `Verification failed: ${failureText(failed.reason, journal.verification?.detail)}`
        : settlement.reason === 'workload_exited'
          ? `The workload exited with code ${settlement.exitCode ?? 'unknown'}.`
          : `The supervisor stopped this attempt (${settlement.reason}); it was not re-executed.`;
      reply = await session.call('POST', `/api/v1/work-items/${journal.workItemId}/fail`, {
        workspaceId, claimOwner, claimToken, failureReason, resultSummary: failureReason,
        artifactRefs: [{type: 'worker_run', dispatchId: journal.dispatchId, attemptId: journal.attemptId, reason: settlement.reason}],
      }, options(`${journal.dispatchId}:fail`)).catch(() => null);
    }
    settlement.work = settledStatus(reply?.status);
  }
  return settlement;
}

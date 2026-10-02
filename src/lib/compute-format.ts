import {renderTable} from './output.js';

type Grant = Record<string, unknown> & {
  id?: string;
  state?: string;
  runnerName?: string;
  workItemId?: string;
  expectedRevision?: number;
  expiresAt?: string | null;
  dispatchId?: string | null;
  approvalStatus?: string;
};

type Runner = Record<string, unknown> & {
  id?: string;
  displayName?: string;
  status?: string;
  available?: boolean;
  eligible?: boolean;
  lastSeenAt?: string | null;
};

export function printRunners(runners: Runner[]): void {
  renderTable(runners, [
    {key: 'id', header: 'ID'},
    {key: 'displayName', header: 'Runner'},
    {key: 'status', header: 'Status', get: (r) => String(r.status ?? (r.available ? 'available' : 'unavailable'))},
    {key: 'eligible', header: 'Eligible', get: (r) => (r.eligible === undefined ? '-' : r.eligible ? 'yes' : 'no')},
    {key: 'lastSeenAt', header: 'Last seen', get: (r) => String(r.lastSeenAt ?? '-')},
  ]);
}

export function printGrants(grants: Grant[]): void {
  renderTable(grants, [
    {key: 'id', header: 'ID'},
    {key: 'state', header: 'State', get: (r) => String(r.state ?? r.approvalStatus ?? '-')},
    {key: 'runnerName', header: 'Runner', get: (r) => String(r.runnerName ?? '-')},
    {key: 'workItemId', header: 'Work item', get: (r) => `${r.workItemId ?? '-'} r${r.expectedRevision ?? '-'}`},
    {key: 'expiresAt', header: 'Deadline', get: (r) => String(r.expiresAt ?? '-')},
    {key: 'dispatchId', header: 'Dispatch', get: (r) => String(r.dispatchId ?? '-')},
  ]);
}

export function printGrant(grant: Grant, detail?: {dispatch?: {id?: string; state?: string} | null; execution?: {stopRequested?: boolean; cleanupPending?: boolean; confirmedReleased?: boolean}}): void {
  const lines: Array<[string, string | undefined]> = [
    ['Grant', grant.id],
    ['State', grant.state ?? grant.approvalStatus],
    ['Runner', grant.runnerName ?? (grant.runnerId as string | undefined)],
    ['Work item', `${grant.workItemId} r${grant.expectedRevision}`],
    ['Deadline', grant.expiresAt ?? '-'],
    ['Dispatch', detail?.dispatch ? `${detail.dispatch.id} (${detail.dispatch.state})` : (grant.dispatchId ?? '-')],
  ];
  if (detail?.execution) {
    lines.push(['Cleanup', detail.execution.confirmedReleased
      ? 'released'
      : detail.execution.cleanupPending
        ? 'cleanup pending'
        : detail.execution.stopRequested ? 'stop requested' : 'none']);
  }
  for (const [label, value] of lines) console.log(`${label}: ${value ?? '-'}`);
}

/**
 * First-run setup sessions from the CLI (U6 contract rev 2, D4 and D6). The
 * commands map one-to-one to /api/v1/setup; they prepare, read and revise a
 * plan, and never approve or run it: Run is the owner's decision on the plan
 * page.
 */

export interface SetupUnmet {code: string; field: string; detail?: string}

export interface SetupSession {
  id: string;
  workspaceId: string | null;
  status: string;
  currentVersion: number;
  approvedVersion: number | null;
  workItemId: string | null;
  plan: {version: number; input: Record<string, unknown>; provenance: Record<string, {source: string; detail?: string}>; unmet: SetupUnmet[]};
}

/** The body's workspace: the setup routes take `personal` or a workspace UUID. */
export const setupWorkspace = (workspaceId: string | undefined): string => workspaceId ?? 'personal';

/** The plan page, where the owner reviews the values and presses Run. */
export const planPageUrl = (apiUrl: string, sessionId: string): string =>
  `${apiUrl.replace(/\/+$/, '')}/app/setup/${encodeURIComponent(sessionId)}`;

/** ` --workspace <id>` for a workspace setup: the enroll and link commands otherwise act in Personal or the saved selection. */
const workspaceFlag = (workspaceId: string | null): string => (workspaceId ? ` --workspace ${workspaceId}` : '');

/** The command that enrolls a machine for this setup, in the setup's workspace. */
export const enrollCommand = (sessionId: string, workspaceId: string | null): string =>
  `sudo sift machine enroll${workspaceFlag(workspaceId)} --setup ${sessionId}`;

/** The command the person runs, without sudo, to name the enrolled runner in the setup. */
export const linkMachineCommand = (sessionId: string, runnerId: string, workspaceId: string | null): string =>
  `sift setup link-machine ${sessionId} --runner ${runnerId}${workspaceFlag(workspaceId)}`;

/** What to do about each unmet requirement, in the words the plan page uses. */
export function unmetLine(item: SetupUnmet, session: Pick<SetupSession, 'id' | 'workspaceId'>): string {
  if (item.code === 'missing_configuration') return `${item.field}: the server has no reviewer image configured; an operator must set it`;
  if (item.field === 'machine.runnerId' && item.code === 'missing_value') {
    return `${item.field}: enroll a Linux machine with \`${enrollCommand(session.id, session.workspaceId)}\``;
  }
  return `${item.field}: ${item.code === 'missing_value' ? 'needs a value' : item.detail ?? item.code}`;
}

/** The session as a person reads it: status, version, what is still unmet and where to review it. */
export function describeSession(session: SetupSession, apiUrl: string): string[] {
  const lines = [`Setup ${session.id}: ${session.status}, version ${session.currentVersion}${session.workItemId ? `, work item ${session.workItemId}` : ''}`];
  if (session.plan.unmet.length) {
    lines.push('Still needed:', ...session.plan.unmet.map((item) => `  ${unmetLine(item, session)}`));
  } else if (session.status === 'ready') {
    lines.push('Nothing is missing. Review the plan and press Run on the plan page.');
  }
  lines.push(`Plan page: ${planPageUrl(apiUrl, session.id)}`);
  return lines;
}

/**
 * `--set field=value` pairs as plan changes. A value that parses as JSON is
 * used as parsed (numbers, arrays, null to clear); anything else is a string.
 */
export function parseSetPairs(pairs: string[]): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const pair of pairs) {
    const split = pair.indexOf('=');
    if (split < 1) throw new Error(`--set needs field=value, got ${JSON.stringify(pair)}`);
    const raw = pair.slice(split + 1);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    changes[pair.slice(0, split)] = value;
  }
  return changes;
}

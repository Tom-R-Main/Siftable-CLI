import {createHash, randomBytes} from 'node:crypto';
import {chmod, mkdir, readFile, rename, rm, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {getConfigDir} from './config.js';

export interface WorkLeaseSession {
  version: 1;
  workItemId: string;
  claimOwner: string;
  claimToken: string;
  expiresAt: string | null;
  apiUrl: string;
  workspaceId: string | null;
  state: 'active';
  updatedAt: string;
}

export interface WorkLeaseSessionDescriptor {
  workItemId: string;
  claimOwner: string;
  expiresAt: string | null;
  workspaceId: string | null;
  state: 'active';
}

function sessionDirectory(): string {
  return join(getConfigDir(), 'work-sessions');
}

function sessionPath(workItemId: string): string {
  const digest = createHash('sha256').update(workItemId).digest('hex');
  return join(sessionDirectory(), `${digest}.json`);
}

function parseSession(value: unknown): WorkLeaseSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1
    || typeof record.workItemId !== 'string'
    || typeof record.claimOwner !== 'string'
    || typeof record.claimToken !== 'string'
    || typeof record.apiUrl !== 'string'
    || !(record.workspaceId === null || typeof record.workspaceId === 'string')
    || record.state !== 'active'
    || typeof record.updatedAt !== 'string'
    || !(record.expiresAt === null || typeof record.expiresAt === 'string')) {
    return null;
  }
  return record as unknown as WorkLeaseSession;
}

export function describeWorkLeaseSession(
  session: WorkLeaseSession,
): WorkLeaseSessionDescriptor {
  return {
    workItemId: session.workItemId,
    claimOwner: session.claimOwner,
    expiresAt: session.expiresAt,
    workspaceId: session.workspaceId,
    state: session.state,
  };
}

export async function writeWorkLeaseSession(session: WorkLeaseSession): Promise<void> {
  const directory = sessionDirectory();
  await mkdir(directory, {recursive: true, mode: 0o700});
  await chmod(directory, 0o700);
  const destination = sessionPath(session.workItemId);
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(session)}\n`, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await rm(temporary, {force: true});
  }
}

/**
 * Result of looking up the saved lease for one work item. Only `active` and `expired` carry the
 * session; callers must never render `session.claimToken`. `expired` compares the cached
 * `expiresAt` with the local clock, so it is advisory: the API holds the authoritative deadline.
 */
export type WorkLeaseSessionLookup =
  | {state: 'missing'}
  | {state: 'unreadable'}
  | {state: 'mismatched'}
  | {state: 'expired'; session: WorkLeaseSession}
  | {state: 'active'; session: WorkLeaseSession};

export function isWorkLeaseSessionExpired(session: WorkLeaseSession, now: number = Date.now()): boolean {
  if (session.expiresAt === null) return false;
  const expiresAt = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

export async function lookupWorkLeaseSession(
  workItemId: string,
  now: number = Date.now(),
): Promise<WorkLeaseSessionLookup> {
  let raw: string;
  try {
    raw = await readFile(sessionPath(workItemId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {state: 'missing'};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {state: 'unreadable'};
  }
  const session = parseSession(parsed);
  if (!session) return {state: 'unreadable'};
  if (session.workItemId !== workItemId) return {state: 'mismatched'};
  if (isWorkLeaseSessionExpired(session, now)) return {state: 'expired', session};
  return {state: 'active', session};
}

export async function readWorkLeaseSession(workItemId: string): Promise<WorkLeaseSession | null> {
  const lookup = await lookupWorkLeaseSession(workItemId);
  return lookup.state === 'active' || lookup.state === 'expired' ? lookup.session : null;
}

export async function deleteWorkLeaseSession(workItemId: string): Promise<void> {
  try {
    await unlink(sessionPath(workItemId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

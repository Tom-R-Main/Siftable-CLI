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

export async function readWorkLeaseSession(workItemId: string): Promise<WorkLeaseSession | null> {
  try {
    const raw = await readFile(sessionPath(workItemId), 'utf8');
    const session = parseSession(JSON.parse(raw) as unknown);
    return session?.workItemId === workItemId ? session : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function deleteWorkLeaseSession(workItemId: string): Promise<void> {
  try {
    await unlink(sessionPath(workItemId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

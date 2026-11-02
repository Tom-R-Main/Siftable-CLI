import {randomUUID} from 'node:crypto';
import {closeSync, openSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import type {Revisions} from './localReview.js';

const activeDirectories = new Set<string>();
export function trackReviewDirectory(path: string): void { activeDirectories.add(path); }
export function untrackReviewDirectory(path: string): void { activeDirectories.delete(path); }
export function cleanupReviewDirectories(): void {
  for (const path of activeDirectories) {
    try { rmSync(path, {recursive: true, force: true}); } catch { /* Continue cleanup of other owned directories. */ }
  }
  activeDirectories.clear();
}

export interface RuntimeIdentity {
  codexBin: string;
  codexVersion?: string;
}

export interface ReviewAttempt {
  format: 'taster.local-attempt/v1';
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'timed_out';
  requested: {repository: string; expectedHead: string | null; baseRef: string | null};
  revision: Revisions | null;
  runtime: RuntimeIdentity | null;
  startedAt: string;
  finishedAt: string | null;
  reason: string | null;
  receiptDigest: string | null;
}

/** Replace only the requested artifact, atomically, without widening existing permissions. */
export function writeAtomicJson(path: string, value: unknown): void {
  const temporary = join(dirname(path), `.sift-review-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, {force: true});
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Review cancelled');
}

/** Stop awaiting a stage on cancellation, and never start a subsequent stage. */
export async function abortable<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return task();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Review cancelled'));
        signal.addEventListener('abort', onAbort, {once: true});
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

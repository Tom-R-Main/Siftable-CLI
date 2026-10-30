/**
 * An attempt's evidence, supervisor side (first-run U5b-2b, U5b-2c). The
 * workload's output (stdout and stderr, merged by the launcher) is written to
 * a host file and frozen when the attempt stops; with a checkout, the write
 * scope's patch is frozen beside it. Both are declared, uploaded and
 * acknowledged with the attempt's own claim before settlement.
 *
 * The log's sha256 and size are fixed once and reused on every retry, so the
 * declaration, its digest and the object key never change. A lost reply is
 * resolved by the next round: declaring again returns the stored manifest,
 * acknowledged or not.
 */
import {createHash} from 'node:crypto';
import {createWriteStream, promises as fs} from 'node:fs';
import path from 'node:path';

export const AGENT_LOG = 'agent.log';
export const EVIDENCE_CONTENT_TYPE = 'text/plain';
/** The server's per-file cap (V502). */
export const MAX_LOG_BYTES = 64 * 1024 * 1024;
const TRUNCATED = Buffer.from('\n[sift: log truncated at 64 MiB]\n');
const ROUNDS = 3;

export interface FrozenLog {
  path: string;
  sha256: string;
  bytes: number;
}

export const PATCH_CONTENT_TYPE = 'text/x-diff';

/** A frozen file beside the log, declared in the same manifest. */
export interface FrozenArtifact extends FrozenLog {
  kind: 'patch' | 'verifier_log';
  contentType: string;
}

/**
 * Copies a stream into the attempt's log up to the cap, then keeps draining it. Closing waits, within
 * `drainMs`, for the stream's own end, so the frozen file is the whole output; a stream that has not ended,
 * or a file that could not be written, rejects instead of freezing a partial log.
 */
export function captureLog(dir: string, source: NodeJS.ReadableStream, prefix?: Buffer): {close(drainMs?: number): Promise<FrozenLog>} {
  const file = path.join(dir, AGENT_LOG);
  const sink = createWriteStream(file, {mode: 0o600});
  // The dependency install's output heads the log, inside the same cap (it is itself capped at 4 MiB).
  if (prefix?.length) sink.write(prefix);
  let failure: Error | undefined;
  sink.on('error', (error) => { failure ??= error; });
  let ended = false;
  const end = new Promise<void>((resolve) => source.once('end', () => { ended = true; resolve(); }));
  const room = MAX_LOG_BYTES - TRUNCATED.length;
  let written = prefix?.length ?? 0;
  let cut = false;
  source.on('data', (chunk: Buffer | string) => {
    if (cut || failure) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (written + bytes.length > room) {
      sink.write(bytes.subarray(0, room - written));
      sink.write(TRUNCATED);
      written = MAX_LOG_BYTES;
      cut = true;
      return;
    }
    sink.write(bytes);
    written += bytes.length;
  });
  return {
    async close(drainMs = 5_000) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([end, new Promise<void>((resolve) => { timer = setTimeout(resolve, drainMs); })]);
      clearTimeout(timer);
      source.removeAllListeners('data');
      source.resume();
      await new Promise<void>((resolve) => sink.end(() => resolve()));
      if (failure) throw new Error(`The log could not be written: ${failure.message}`);
      if (!ended) throw new Error('The workload\'s output did not reach its end; the log is incomplete');
      const content = await fs.readFile(file);
      return {path: file, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length};
    },
  };
}

export type EvidenceCall = (method: 'POST', route: string, body: unknown, options: {timeoutMs: number; signal?: AbortSignal})
  => Promise<{status: number; body: Record<string, unknown>}>;

export interface EvidenceOutcome {
  acknowledged: boolean;
  manifestDigest?: string;
  /** Shutdown cut the upload short: nothing was decided, and the next start finishes it. */
  cancelled?: boolean;
}

/**
 * Declares, uploads and acknowledges the frozen log in at most three rounds
 * before `deadlineMono`. Retries only what can change: a 5xx, a lost reply or
 * a failed upload. A refusal (403, 404 on declare, 409 on declare) means the
 * claim or attempt no longer allows it, and nothing more is sent.
 */
export async function uploadAgentLog(input: {
  call: EvidenceCall;
  fetch: typeof fetch;
  monoMs: () => number;
  deadlineMono: number;
  route: string;
  claimToken: string;
  log: FrozenLog;
  /** The main file's kind: the agent's log, or the verifier log when verification stopped the start (U3-1b). */
  logKind?: 'agent_log' | 'verifier_log';
  logContentType?: string;
  /** Files declared beside the log, such as the patch; each digest must differ from every other (V502). */
  also?: FrozenArtifact[];
  /** Reads a frozen file's bytes; the file system by default. */
  read?: (file: string) => Promise<Buffer>;
  /** Shutdown: aborts the request in flight and starts no other. */
  signal?: AbortSignal;
}): Promise<EvidenceOutcome> {
  const {call, log, route, claimToken} = input;
  const left = () => input.deadlineMono - input.monoMs();
  const files = [{...log, kind: input.logKind ?? 'agent_log', contentType: input.logContentType ?? EVIDENCE_CONTENT_TYPE}, ...(input.also ?? [])];
  // Read once, before anything is admitted: a slow read is counted against the deadline, never after it.
  const read = input.read ?? ((file: string) => fs.readFile(file));
  const bodies = new Map<string, {body: Buffer; file: typeof files[number]}>();
  for (const file of files) {
    const body = await read(file.path).catch(() => null);
    if (!body) return {acknowledged: false};
    bodies.set(file.sha256, {body, file});
  }
  // Two files with one digest cannot be declared together; the manifest would be refused every round.
  if (bodies.size !== files.length) return {acknowledged: false};
  const artifacts = files.map((file) => ({kind: file.kind, sha256: file.sha256, bytes: file.bytes, contentType: file.contentType}));
  let manifestDigest: string | undefined;
  const signal = input.signal;
  const cancelled = (): EvidenceOutcome => ({acknowledged: false, cancelled: true, ...(manifestDigest ? {manifestDigest} : {})});
  for (let round = 0; round < ROUNDS && left() > 0; round += 1) {
    if (signal?.aborted) return cancelled();
    const declared = await call('POST', route, {claimToken, artifacts}, {timeoutMs: Math.max(1, Math.min(30_000, left())), signal})
      .catch(() => null);
    if (signal?.aborted) return cancelled();
    if (!declared || declared.status >= 500) continue;
    if (declared.status !== 200) break;
    manifestDigest = typeof declared.body.manifestDigest === 'string' ? declared.body.manifestDigest : undefined;
    if (!manifestDigest) continue;
    if (declared.body.acknowledgedAt) return {acknowledged: true, manifestDigest};
    const uploads = Array.isArray(declared.body.uploads) ? declared.body.uploads as Array<{sha256?: unknown; url?: unknown}> : [];
    let uploaded = true;
    for (const upload of uploads) {
      // Every request is admitted only while the deadline holds, checked immediately before it starts.
      const match = typeof upload.sha256 === 'string' ? bodies.get(upload.sha256) : undefined;
      if (!match || typeof upload.url !== 'string' || left() <= 0) { uploaded = false; break; }
      const put = await input.fetch(upload.url, {
        method: 'PUT',
        headers: {'Content-Type': match.file.contentType, 'x-goog-if-generation-match': '0',
          'x-goog-content-length-range': `${match.file.bytes},${match.file.bytes}`},
        body: match.body,
        signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.floor(Math.min(60_000, left())))), ...(signal ? [signal] : [])]),
      }).catch(() => null);
      if (signal?.aborted) return cancelled();
      // 412: the object already exists (an earlier round's PUT landed); the acknowledge decides whether it is right.
      if (!put || !(put.ok || put.status === 412)) { uploaded = false; break; }
    }
    if (!uploaded || left() <= 0) continue;
    if (signal?.aborted) return cancelled();
    const acknowledged = await call('POST', `${route}/acknowledge`, {claimToken, manifestDigest},
      {timeoutMs: Math.max(1, Math.min(70_000, left())), signal}).catch(() => null);
    if (signal?.aborted && acknowledged?.status !== 200) return cancelled();
    if (acknowledged?.status === 200) return {acknowledged: true, manifestDigest};
    if (acknowledged?.status === 403) break;
  }
  return {acknowledged: false, ...(manifestDigest ? {manifestDigest} : {})};
}

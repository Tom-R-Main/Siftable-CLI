/**
 * An attempt's evidence, supervisor side (first-run U5b-2b). This cut is
 * log-only: the workload's output (stdout and stderr, merged by the launcher)
 * is written to a host file, frozen when the attempt stops, then declared,
 * uploaded and acknowledged with the attempt's own claim before settlement.
 * There is no repository checkout yet, so there is no patch (U5b-2c).
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

/** Copies a stream into the attempt's log up to the cap, then keeps draining it. */
export function captureLog(dir: string, source: NodeJS.ReadableStream): {close(): Promise<FrozenLog>} {
  const file = path.join(dir, AGENT_LOG);
  const sink = createWriteStream(file, {mode: 0o600});
  const room = MAX_LOG_BYTES - TRUNCATED.length;
  let written = 0;
  let cut = false;
  source.on('data', (chunk: Buffer | string) => {
    if (cut) return;
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
    async close() {
      source.removeAllListeners('data');
      source.resume();
      await new Promise<void>((resolve, reject) => sink.end((error?: Error | null) => (error ? reject(error) : resolve())));
      const content = await fs.readFile(file);
      return {path: file, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length};
    },
  };
}

export type EvidenceCall = (method: 'POST', route: string, body: unknown, options: {timeoutMs: number})
  => Promise<{status: number; body: Record<string, unknown>}>;

export interface EvidenceOutcome {
  acknowledged: boolean;
  manifestDigest?: string;
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
}): Promise<EvidenceOutcome> {
  const {call, log, route, claimToken} = input;
  const left = () => input.deadlineMono - input.monoMs();
  const artifacts = [{kind: 'agent_log', sha256: log.sha256, bytes: log.bytes, contentType: EVIDENCE_CONTENT_TYPE}];
  let manifestDigest: string | undefined;
  for (let round = 0; round < ROUNDS && left() > 0; round += 1) {
    const declared = await call('POST', route, {claimToken, artifacts}, {timeoutMs: Math.max(1, Math.min(30_000, left()))}).catch(() => null);
    if (!declared || declared.status >= 500) continue;
    if (declared.status !== 200) break;
    manifestDigest = typeof declared.body.manifestDigest === 'string' ? declared.body.manifestDigest : undefined;
    if (!manifestDigest) continue;
    if (declared.body.acknowledgedAt) return {acknowledged: true, manifestDigest};
    const uploads = Array.isArray(declared.body.uploads) ? declared.body.uploads as Array<{sha256?: unknown; url?: unknown}> : [];
    let uploaded = true;
    for (const upload of uploads) {
      if (upload.sha256 !== log.sha256 || typeof upload.url !== 'string') { uploaded = false; break; }
      const put = await input.fetch(upload.url, {
        method: 'PUT',
        headers: {'Content-Type': EVIDENCE_CONTENT_TYPE, 'x-goog-if-generation-match': '0',
          'x-goog-content-length-range': `${log.bytes},${log.bytes}`},
        body: await fs.readFile(log.path),
        signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(60_000, left())))),
      }).catch(() => null);
      // 412: the object already exists (an earlier round's PUT landed); the acknowledge decides whether it is right.
      if (!put || !(put.ok || put.status === 412)) { uploaded = false; break; }
    }
    if (!uploaded) continue;
    const acknowledged = await call('POST', `${route}/acknowledge`, {claimToken, manifestDigest},
      {timeoutMs: Math.max(1, Math.min(70_000, left()))}).catch(() => null);
    if (acknowledged?.status === 200) return {acknowledged: true, manifestDigest};
    if (acknowledged?.status === 403) break;
  }
  return {acknowledged: false, ...(manifestDigest ? {manifestDigest} : {})};
}

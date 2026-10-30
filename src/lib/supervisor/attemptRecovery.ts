/**
 * Finishing what a crash or a failed upload left owed (first-run U5b): the
 * evidence upload under the recovered claim, and a failed install's output.
 * Moved out of superviseLoop.ts unchanged (U3-1b) to keep that file within
 * its line limit.
 */
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {Session} from './attemptReport.js';
import {type EvidenceOutcome, uploadAgentLog} from './attemptEvidence.js';
import {mountAttemptFs} from './attemptFilesystem.js';
import {writeAttemptJournal} from './attemptSettle.js';
import {INSTALL_LOG, MAX_INSTALL_LOG_BYTES} from './checkoutHelper.js';
import type {AttemptJournal, SuperviseDeps} from './superviseLoop.js';

/**
 * Finishes an evidence upload a crash cut off, under the attempt's own recovered claim and before its
 * settlement is posted. The frozen log must still match its journaled digest; nothing is re-run.
 */
export async function resumeEvidence(deps: SuperviseDeps, session: Session, journal: AttemptJournal, claimToken: string,
  deadlineMono: number): Promise<AttemptJournal | 'cancelled'> {
  const frozen = journal.evidence;
  if (!frozen || !journal.settlement || journal.settlement.evidence || !journal.attemptId) return journal;
  const unchanged = (file: {path: string; bytes: number; sha256: string}) => fs.readFile(file.path)
    .then((bytes) => bytes.length === file.bytes && createHash('sha256').update(bytes).digest('hex') === file.sha256)
    .catch(() => false);
  // With a checkout the patch is owed too; one never frozen cannot be rebuilt after a restart.
  const patch = journal.patch;
  const intact = await unchanged(frozen) && (!journal.fs || (patch !== undefined && await unchanged(patch)));
  const outcome: EvidenceOutcome = intact ? await uploadAgentLog({
    call: (method, route, body, options) => session.call(method, route, body, options), fetch: deps.fetch,
    monoMs: () => deps.clock.monoMs(), deadlineMono,
    route: `/api/v1/work-items/${journal.workItemId}/execution-attempts/${journal.attemptId}/evidence-manifest`, claimToken,
    log: {path: frozen.path, sha256: frozen.sha256, bytes: frozen.bytes}, also: patch ? [patch] : [], signal: deps.shutdown,
  }) : {acknowledged: false};
  // Shutdown again: still undecided; the journal is left as it was for the next start.
  if (outcome.cancelled) return 'cancelled';
  const next = {...journal, evidence: {...frozen, ...outcome}, settlement: {...journal.settlement, evidence: outcome}};
  await writeAttemptJournal(deps, next);
  if (outcome.acknowledged) await fs.rm(path.dirname(frozen.path), {recursive: true, force: true}).catch(() => undefined);
  return next;
}

/**
 * Saves a failed install's output beside the attempt's input: the bytes in hand, or else the install log still in the
 * attempt filesystem (a regular file, within its cap). Marks it `saved` only once written; otherwise it stays owed and
 * the filesystem holding it is kept.
 */
export async function saveInstallOutput(deps: SuperviseDeps, journal: AttemptJournal, inputDir: string, bytes?: Buffer): Promise<AttemptJournal> {
  const target = path.join(inputDir, 'install.log');
  const source = journal.fs ? path.join(journal.fs.mountPoint, 'deps', INSTALL_LOG) : undefined;
  const read = async () => (source ? fs.lstat(source).then(async (stat) => (stat.isFile() && stat.size <= MAX_INSTALL_LOG_BYTES + 4096
    ? fs.readFile(source) : undefined), () => undefined) : undefined);
  let output = bytes ?? await read();
  // After a restart the earlier process's private mount is gone: mount the journaled image again, by its checked identity.
  if (output === undefined && journal.fs && journal.fs.state !== 'released' && deps.attemptFs) {
    const remounted = await mountAttemptFs(deps.attemptFs.system, journal.fs, async (record) => {
      journal = {...journal, fs: record};
      await writeAttemptJournal(deps, journal);
    }).then(() => true, (error: unknown) => { deps.log(`The attempt filesystem could not be mounted again: ${(error as Error).message}`); return false; });
    if (remounted) output = await read();
  }
  const saved = output !== undefined && await fs.mkdir(inputDir, {recursive: true, mode: 0o755})
    .then(() => fs.writeFile(target, output, {mode: 0o600})).then(() => true, () => false);
  deps.log(saved ? `The dependency install failed; its output is kept at ${target}.`
    : `The dependency install failed and its output could not be saved; it stays in the attempt filesystem at ${journal.fs?.image}.`);
  if (!saved) return journal;
  const next: AttemptJournal = {...journal, installOutput: 'saved'};
  await writeAttemptJournal(deps, next);
  return next;
}

import {spawn} from 'node:child_process';
import {mkdir, readFile, rename, stat, open, rm, lstat, realpath, readdir} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {hasInlineAgentWorkSecrets} from './agent-work-secrets.js';

export interface MobileDispatchClaim {
  dispatch: {id: string; workItemId: string};
  workItem: {id: string; claimToken: string; [key: string]: unknown};
  controls?: Array<{id: string; action: 'checkpoint' | 'stop'}>;
}

export interface MobileRunnerApi {
  request<T>(path: string, body: unknown, key?: string, signal?: AbortSignal): Promise<T>;
}

export interface MobileRunnerOptions {
  api: MobileRunnerApi;
  runnerId: string;
  workspaceId: string | null;
  executable: string;
  args: string[];
  cwd: string;
  receiptDirectory: string;
  heartbeatIntervalMs?: number;
  requestTimeoutMs?: number;
  /** Attachment IO includes the server's 30s storage read and base64 transfer. */
  attachmentRequestTimeoutMs?: number;
  checkpoint?: (workItem: Record<string, unknown>, signal: AbortSignal) => Promise<void>;
  refreshRunner?: (signal?: AbortSignal) => Promise<unknown>;
}

interface Receipt {
  version: 1;
  dispatchId: string;
  workItemId: string;
  state: 'launching' | 'start_failed' | 'finished' | 'reviewed' | 'failed' | 'stopped';
  exitCode?: number;
  exitSignal?: NodeJS.Signals;
  stopControlId?: string;
  result?: {summary: string; artifactRefs: unknown[]};
  resultRejected?: boolean;
  attachmentScratch?: AttachmentScratch;
}

interface AttachmentScratch {
  version: 1;
  consumerId: string;
  runnerId: string;
  workspaceId: string | null;
  ownerPid: number;
  childPid?: number;
  phase: 'preparing' | 'spawn_pending' | 'spawned';
  rootPath: string;
  rootDev: number;
  rootIno: number;
  directoryDev: number;
  directoryIno: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function durableWrite(path: string, body: unknown, exclusive = false): Promise<void> {
  const handle = await open(path, exclusive ? 'wx' : 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(body)); await handle.sync(); }
  finally { await handle.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const ATTACHMENT_REQUEST_TIMEOUT_MS = 120_000;

class PreparationStopped extends Error {
  constructor(readonly controlId: string) { super('Work stopped during attachment preparation.'); }
}

/** Fence transports that return after cancellation as well as fetch itself. */
async function withRequestSignal<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let aborted!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, {once: true});
  });
  try {
    const result = await Promise.race([action(), cancelled]);
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener('abort', aborted); }
}

function processIsDefinitelyGone(pid: number, group = false): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(group ? -pid : pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** Only remove scratch whose durable provenance and process death we can prove.
 * PID reuse, legacy receipts, and death between spawn and PID persistence remain
 * manual cleanup cases. No receipt state or server execution state changes. */
async function cleanInterruptedAttachments(
  options: MobileRunnerOptions, receipt: Receipt, consumerId: string, receiptPath: string,
): Promise<void> {
  const scratch = receipt.attachmentScratch;
  if (!scratch || scratch.version !== 1 || scratch.consumerId !== consumerId
    || scratch.runnerId !== options.runnerId || scratch.workspaceId !== options.workspaceId
    || !processIsDefinitelyGone(scratch.ownerPid)) return;
  const confirmedNoSpawn = receipt.state === 'start_failed' && scratch.phase === 'spawn_pending'
    && scratch.childPid === undefined;
  if (!confirmedNoSpawn && scratch.phase !== 'preparing' && (scratch.phase !== 'spawned'
    || !processIsDefinitelyGone(scratch.childPid!) || !processIsDefinitelyGone(scratch.childPid!, true))) return;
  try {
    const rootPath = await realpath(options.receiptDirectory);
    if (rootPath !== scratch.rootPath) return;
    // Resolve the configured root once, then reject substituted symlink ancestors
    // on that canonical path. A private owned root excludes other users' writes.
    for (let ancestor = rootPath; ; ancestor = dirname(ancestor)) {
      const info = await lstat(ancestor);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      if (ancestor === dirname(ancestor)) break;
    }
    const root = await lstat(rootPath);
    const receiptInfo = await lstat(receiptPath);
    const uid = process.getuid?.();
    if (uid === undefined || root.uid !== uid || (root.mode & 0o022) !== 0
      || root.dev !== scratch.rootDev || root.ino !== scratch.rootIno
      || !receiptInfo.isFile() || receiptInfo.isSymbolicLink() || receiptInfo.uid !== uid
      || receiptInfo.nlink !== 1 || (receiptInfo.mode & 0o077) !== 0) return;
    const directory = join(rootPath, `${receipt.dispatchId}.attachments`);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0
      || info.dev !== scratch.directoryDev || info.ino !== scratch.directoryIno) return;
    const names = await readdir(directory);
    if (names.length > MAX_ATTACHMENTS) return;
    for (const name of names) {
      const match = /^(\d{1,2})-(.+)$/.exec(name);
      if (!match || Number(match[1]) >= MAX_ATTACHMENTS || !UUID.test(match[2])) return;
      const file = await lstat(join(directory, name));
      if (!file.isFile() || file.isSymbolicLink() || file.uid !== uid || file.nlink !== 1 || (file.mode & 0o077) !== 0) return;
    }
    const current = await lstat(directory);
    if (current.dev !== info.dev || current.ino !== info.ino || !current.isDirectory()) return;
    await rm(directory, {recursive: true, force: true});
    await syncDirectory(rootPath);
  } catch {
    // Missing/replaced paths and uncertain filesystem ownership remain manual
    // reconciliation cases; never include content or provider errors in output.
  }
}

/** Receipt names are display metadata; only generated names become filesystem paths. */
async function prepareWorkAttachments(
  options: MobileRunnerOptions,
  dispatchId: string,
  workItem: MobileDispatchClaim['workItem'],
  rememberScratch: (directory: string) => Promise<void>,
  renewPreparation: (signal: AbortSignal) => Promise<void>,
): Promise<{workItem: Record<string, unknown>; cleanup: () => Promise<void>}> {
  const safeWorkItem: Record<string, unknown> = {...workItem};
  delete safeWorkItem.claimToken;
  const inputContext = workItem.inputContext as Record<string, unknown> | undefined;
  const attachments = inputContext?.attachments;
  if (attachments === undefined) return {workItem: safeWorkItem, cleanup: async () => {}};
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) throw new Error('Invalid work attachments.');
  const validated = attachments.map(attachment => {
    if (!attachment || typeof attachment !== 'object' || typeof attachment.receiptId !== 'string' || !UUID.test(attachment.receiptId)
      || typeof attachment.name !== 'string' || !attachment.name || attachment.name.length > 512) {
      throw new Error('Invalid work attachments.');
    }
    return {receiptId: attachment.receiptId as string, name: attachment.name as string};
  });
  if (!validated.length) return {workItem: safeWorkItem, cleanup: async () => {}};
  const directory = join(resolve(options.receiptDirectory), `${dispatchId}.attachments`);
  // Exclusive creation prevents an existing path or symlink from becoming a write target.
  await mkdir(directory, {mode: 0o700});
  const cleanup = () => rm(directory, {recursive: true, force: true});
  const lifetime = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let pending = Promise.resolve();
  let renewing = false;
  let closing = false;
  const renew = () => {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.requestTimeoutMs ?? 10_000)]);
    return withRequestSignal(signal, () => renewPreparation(signal));
  };
  try {
    // Persist ownership before the first plaintext byte reaches this directory.
    await rememberScratch(directory);
    await renew();
    // Runner liveness expires after 90s and the work lease after 300s. Renew
    // throughout every bounded transfer, including a multi-file preparation.
    timer = setInterval(() => {
      if (renewing || lifetime.signal.aborted) return;
      renewing = true;
      pending = renew().catch(error => {
        if (!closing) lifetime.abort(error);
      }).finally(() => { renewing = false; });
    }, Math.min(options.heartbeatIntervalMs ?? 20_000, 20_000));
    const materialized: Array<{receiptId: string; name: string; localPath: string}> = [];
    let totalBytes = 0;
    for (const [index, attachment] of validated.entries()) {
      const signal = AbortSignal.any([lifetime.signal,
        AbortSignal.timeout(options.attachmentRequestTimeoutMs ?? options.requestTimeoutMs ?? ATTACHMENT_REQUEST_TIMEOUT_MS)]);
      const content = await withRequestSignal(signal, () => options.api.request<{
        receiptId: string; byteLength: number; sha256: string; contentBase64: string;
      }>(`/api/v1/work-items/dispatches/${dispatchId}/attachments/${attachment.receiptId}`, {
        workspaceId: options.workspaceId, claimToken: workItem.claimToken,
      }, undefined, signal));
      if (!content || content.receiptId !== attachment.receiptId
        || !Number.isSafeInteger(content.byteLength) || content.byteLength < 0 || content.byteLength > MAX_ATTACHMENT_BYTES
        || typeof content.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(content.sha256)
        || typeof content.contentBase64 !== 'string' || content.contentBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) {
        throw new Error('Invalid attachment content.');
      }
      const bytes = Buffer.from(content.contentBase64, 'base64');
      try {
        totalBytes += bytes.byteLength;
        if (bytes.byteLength !== content.byteLength || totalBytes > MAX_ATTACHMENT_BYTES * MAX_ATTACHMENTS
          || bytes.toString('base64') !== content.contentBase64
          || createHash('sha256').update(bytes).digest('hex') !== content.sha256) {
          throw new Error('Invalid attachment content.');
        }
        const localPath = join(directory, `${index}-${attachment.receiptId}`);
        const handle = await open(localPath, 'wx', 0o400);
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
        lifetime.signal.throwIfAborted();
        materialized.push({...attachment, localPath});
      } finally { bytes.fill(0); }
    }
    clearInterval(timer);
    await pending;
    lifetime.signal.throwIfAborted();
    // Revalidate ownership and Stop immediately before returning inputs to the
    // spawn path; a delayed preparation continuation cannot start cancelled work.
    await renew();
    safeWorkItem.inputContext = {...inputContext, attachments: materialized};
    return {workItem: safeWorkItem, cleanup};
  } catch (error) {
    closing = true;
    if (timer) clearInterval(timer);
    lifetime.abort(error);
    await pending;
    await cleanup();
    if (error instanceof PreparationStopped) throw error;
    throw new Error('Work attachments could not be prepared.');
  } finally {
    closing = true;
    if (timer) clearInterval(timer);
    lifetime.abort();
    await pending;
  }
}

/** Host configuration supplies the executable and directory. Phone input never becomes shell code. */
export async function consumeMobileDispatch(options: MobileRunnerOptions): Promise<'idle' | 'reviewed' | 'failed' | 'stopped'> {
  const {api, runnerId, workspaceId} = options;
  if (process.platform === 'win32') throw new Error('Mobile host execution requires POSIX process-group termination. Windows is not supported.');
  if (!UUID.test(runnerId)) throw new Error('Runner ID must be a UUID.');
  await mkdir(options.receiptDirectory, {recursive: true, mode: 0o700});
  const identityPath = join(options.receiptDirectory, 'consumer.json');
  try { await durableWrite(identityPath, {id: randomUUID()}, true); await syncDirectory(options.receiptDirectory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const consumerId: unknown = JSON.parse(await readFile(identityPath, 'utf8')).id;
  if (typeof consumerId !== 'string' || !UUID.test(consumerId)) throw new Error('Invalid host consumer identity.');
  const claim = await api.request<MobileDispatchClaim | {dispatch: null}>(
    `/api/v1/work-items/runners/${runnerId}/consume`, {workspaceId, consumerId},
  );
  if (!claim.dispatch || !('workItem' in claim) || !claim.workItem) return 'idle';
  const {dispatch, workItem} = claim;
  if (!UUID.test(dispatch.id) || !UUID.test(workItem.id) || dispatch.workItemId !== workItem.id
    || typeof workItem.claimToken !== 'string' || !workItem.claimToken) {
    throw new Error('Invalid dispatch claim.');
  }
  await mkdir(options.receiptDirectory, {recursive: true, mode: 0o700});
  const receiptPath = join(options.receiptDirectory, `${dispatch.id}.json`);
  let receipt: Receipt = {version: 1, dispatchId: dispatch.id, workItemId: workItem.id, state: 'launching'};
  const saveReceipt = async () => {
    const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
    await durableWrite(temporaryPath, receipt);
    await rename(temporaryPath, receiptPath);
    await syncDirectory(options.receiptDirectory);
  };
  let newReceipt = false;
  try {
    // Reserve before spawning. A second consumer or a restart cannot execute it again.
    await durableWrite(receiptPath, receipt, true);
    await syncDirectory(options.receiptDirectory);
    newReceipt = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Receipt; }
    catch { throw new Error('Invalid dispatch receipt.'); }
    if (receipt.version !== 1 || receipt.dispatchId !== dispatch.id || receipt.workItemId !== workItem.id) {
      throw new Error('Dispatch receipt identity mismatch.');
    }
    // A crash can also land after the outcome was saved but before finally
    // removed plaintext. Check all replays before any terminal-state shortcut.
    await cleanInterruptedAttachments(options, receipt, consumerId, receiptPath);
    if (receipt.state === 'launching') {
      throw new Error('Dispatch already launched or interrupted. Reconcile on the host before retrying; automatic re-execution is disabled.');
    }
    if (hasInlineAgentWorkSecrets(receipt)) {
      // Old receipts must pass the same policy before any replay or terminal-state shortcut.
      receipt = {version: 1, dispatchId: dispatch.id, workItemId: workItem.id, state: 'finished',
        exitCode: Number.isInteger(receipt.exitCode) ? receipt.exitCode : 0, resultRejected: true};
      await saveReceipt();
      try { await rm(join(options.receiptDirectory, `${dispatch.id}.result.json`), {force: true}); }
      catch { throw new Error('Rejected host result cleanup failed.'); }
    }
    if (receipt.state === 'reviewed' || receipt.state === 'failed') return receipt.state;
    if (receipt.state !== 'start_failed' && (!['finished', 'stopped'].includes(receipt.state) || !Number.isInteger(receipt.exitCode))) throw new Error('Invalid dispatch receipt.');
  }
  const acknowledgeStartFailure = async (): Promise<'failed'> => {
    await api.request(`/api/v1/work-items/dispatches/${dispatch.id}/ack`,
      {workspaceId, claimToken: workItem.claimToken, state: 'failed'}, `${dispatch.id}:start-failed`);
    receipt.state = 'failed';
    await saveReceipt();
    return 'failed';
  };
  const claimBody = {workspaceId, claimOwner: `mobile-runner:${runnerId}`, claimToken: workItem.claimToken};
  const heartbeat = (signal?: AbortSignal) => api.request(`/api/v1/work-items/${workItem.id}/heartbeat`, {...claimBody, leaseSeconds: 300}, undefined, signal);
  if (newReceipt) {
    let prepared: Awaited<ReturnType<typeof prepareWorkAttachments>>;
    try {
      prepared = await prepareWorkAttachments(options, dispatch.id, workItem, async directory => {
        const rootPath = await realpath(options.receiptDirectory);
        const root = await lstat(rootPath);
        const scratch = await lstat(directory);
        receipt.attachmentScratch = {version: 1, consumerId, runnerId, workspaceId, ownerPid: process.pid,
          phase: 'preparing', rootPath, rootDev: root.dev, rootIno: root.ino, directoryDev: scratch.dev, directoryIno: scratch.ino};
        await saveReceipt();
      }, async signal => {
        await options.refreshRunner?.(signal);
        signal.throwIfAborted();
        await heartbeat(signal);
        signal.throwIfAborted();
        const update = await api.request<MobileDispatchClaim>(
          `/api/v1/work-items/runners/${runnerId}/consume`, {workspaceId, consumerId}, undefined, signal,
        );
        signal.throwIfAborted();
        if (update.dispatch?.id !== dispatch.id || update.workItem?.claimToken !== workItem.claimToken) {
          throw new Error('Host dispatch ownership changed.');
        }
        for (const control of update.controls ?? []) {
          if (!UUID.test(control.id)) throw new Error('Invalid control identity.');
          if (control.action === 'stop') throw new PreparationStopped(control.id);
          if (control.action !== 'checkpoint') throw new Error('Unknown control action.');
        }
      });
    } catch (error) {
      if (error instanceof PreparationStopped) {
        receipt.state = 'stopped';
        receipt.exitCode = 1;
        receipt.stopControlId = error.controlId;
        await saveReceipt();
        await api.request(`/api/v1/work-items/dispatches/${dispatch.id}/controls/ack`,
          {workspaceId, controlId: error.controlId, claimToken: workItem.claimToken, state: 'acknowledged'}, `${error.controlId}:ack`);
        return 'stopped';
      }
      // No executable has been started, and failure details must not reveal attachment content.
      receipt.state = 'start_failed';
      await saveReceipt();
      return acknowledgeStartFailure();
    }
    const safeWorkItem = prepared.workItem;
    try {
      if (receipt.attachmentScratch) {
        receipt.attachmentScratch.phase = 'spawn_pending';
        await saveReceipt();
      }
      const resultPath = join(options.receiptDirectory, `${dispatch.id}.result.json`);
      const result = await runHostExecutable(options, safeWorkItem, resultPath, async (signal, childPid) => {
        if (receipt.attachmentScratch) {
          receipt.attachmentScratch.phase = 'spawned';
          receipt.attachmentScratch.childPid = childPid;
          await saveReceipt();
        }
        signal.throwIfAborted();
        await api.request(`/api/v1/work-items/dispatches/${dispatch.id}/ack`,
          {workspaceId, claimToken: workItem.claimToken, state: 'acknowledged'}, `${dispatch.id}:ack`, signal);
      }, async signal => {
        await options.refreshRunner?.(signal);
        signal.throwIfAborted();
        await heartbeat(signal);
        signal.throwIfAborted();
        const update = await api.request<MobileDispatchClaim>(
          `/api/v1/work-items/runners/${runnerId}/consume`, {workspaceId, consumerId}, undefined, signal,
        );
        signal.throwIfAborted();
        if (update.dispatch?.id !== dispatch.id || update.workItem?.claimToken !== workItem.claimToken) {
          throw new Error('Host dispatch ownership changed.');
        }
        for (const control of update.controls ?? []) {
          signal.throwIfAborted();
          if (!UUID.test(control.id)) throw new Error('Invalid control identity.');
          if (control.action === 'stop') return control.id;
          if (control.action !== 'checkpoint') throw new Error('Unknown control action.');
          const controlPath = join(options.receiptDirectory, `${control.id}.control.json`);
          let state: 'acknowledged' | 'failed' = 'failed';
          try {
            await durableWrite(controlPath, {state: 'failed'}, true);
            await syncDirectory(options.receiptDirectory);
            signal.throwIfAborted();
            if (options.checkpoint) {
              await options.checkpoint(safeWorkItem, signal);
              signal.throwIfAborted();
              await durableWrite(controlPath, {state: 'acknowledged'});
              state = 'acknowledged';
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
              const previous = JSON.parse(await readFile(controlPath, 'utf8'));
              state = previous.state === 'acknowledged' ? 'acknowledged' : 'failed';
            }
          }
          signal.throwIfAborted();
          await api.request(`/api/v1/work-items/dispatches/${dispatch.id}/controls/ack`,
            {workspaceId, controlId: control.id, claimToken: workItem.claimToken, state}, `${control.id}:ack`, signal);
        }
        return undefined;
      });
      if (!result.spawned) {
        receipt.state = 'start_failed';
      } else {
        receipt.exitCode = result.exitCode;
        receipt.exitSignal = result.exitSignal;
        receipt.stopControlId = result.stopControlId;
        receipt.state = result.stopControlId ? 'stopped' : 'finished';
        if (!result.stopControlId && result.exitCode === 0 && !result.exitSignal) {
          try {
            if ((await stat(resultPath)).size > 65536) throw new Error('Result exceeds 64 KiB');
            const authored = JSON.parse(await readFile(resultPath, 'utf8'));
            if (typeof authored.summary !== 'string' || authored.summary.length > 16000 || !Array.isArray(authored.artifactRefs) || authored.artifactRefs.length > 50) {
              throw new Error('Invalid host result');
            }
            if (hasInlineAgentWorkSecrets(authored)) {
              receipt.resultRejected = true;
              await rm(resultPath, {force: true});
            } else {
              receipt.result = {summary: authored.summary, artifactRefs: authored.artifactRefs};
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Host result file is invalid. Reconcile on the host before submitting it.');
          }
        }
      }
      await saveReceipt();
    } finally { await prepared.cleanup(); }
  }
  if (receipt.state === 'start_failed') {
    // The host proved no process spawned before recording this state. Retrying only sends the ACK.
    return acknowledgeStartFailure();
  }
  if (receipt.state === 'stopped' && receipt.stopControlId) {
    // The configured foreground process group has exited before Stop is acknowledged.
    await api.request(`/api/v1/work-items/dispatches/${dispatch.id}/controls/ack`,
      {workspaceId, controlId: receipt.stopControlId, claimToken: workItem.claimToken, state: 'acknowledged'},
      `${receipt.stopControlId}:ack`);
    return 'stopped';
  }
  // Revalidate the worker lease immediately before submitting the result.
  await heartbeat();
  if (receipt.resultRejected || receipt.exitCode !== 0 || receipt.exitSignal) {
    const failureReason = receipt.resultRejected
      ? 'Host result rejected because it contains inline secret material.'
      : receipt.exitSignal
      ? `Host worker terminated by ${receipt.exitSignal}.`
      : `Host worker exited with code ${receipt.exitCode}.`;
    await api.request(`/api/v1/work-items/${workItem.id}/fail`, {
      ...claimBody,
      failureReason,
      resultSummary: failureReason,
      artifactRefs: [{type: 'worker_run', dispatchId: dispatch.id, exitCode: receipt.exitCode,
        ...(receipt.exitSignal ? {signal: receipt.exitSignal} : {})}],
    }, `${dispatch.id}:fail`);
    receipt.state = 'failed';
    await saveReceipt();
    return 'failed';
  }
  await api.request(`/api/v1/work-items/${workItem.id}/review`, {
    ...claimBody,
    resultSummary: receipt.result?.summary ?? `Host worker finished with exit code ${receipt.exitCode}. No deliverable was supplied.`,
    artifactRefs: [...(receipt.result?.artifactRefs ?? []), {type: 'worker_run', dispatchId: dispatch.id, exitCode: receipt.exitCode}],
    durableMemory: {decision: 'skip', rationale: 'Host runner does not infer durable knowledge from process completion'},
  }, `${dispatch.id}:review`);
  receipt.state = 'reviewed';
  await saveReceipt();
  return 'reviewed';
}

async function runHostExecutable(
  options: MobileRunnerOptions,
  workItem: Record<string, unknown>,
  resultPath: string,
  acknowledge: (signal: AbortSignal, childPid: number) => Promise<void>,
  heartbeat: (signal: AbortSignal) => Promise<string | undefined>,
): Promise<{spawned: false} | {spawned: true; exitCode: number; exitSignal?: NodeJS.Signals; stopControlId?: string}> {
  return new Promise((resolve, reject) => {
    const lifetime = new AbortController();
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      shell: false,
      detached: process.platform !== 'win32',
      // Worker output can contain secrets. Never forward it into task records or logs.
      stdio: ['pipe', 'ignore', 'ignore'],
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TERM: process.env.TERM,
        SIFT_WORK_ITEM_ID: String(workItem.id), SIFT_WORK_RESULT_PATH: resultPath,
      },
    });
    let failure: Error | undefined;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let pending: Promise<void> = Promise.resolve();
    let heartbeatRunning = false;
    let stopControlId: string | undefined;
    let acknowledged = false;
    let spawned = false;
    let startFailed = false;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
      }
    };
    const fail = () => {
      if (lifetime.signal.aborted) return;
      failure = new Error('Host acknowledgement or lease heartbeat failed; worker stopped.');
      lifetime.abort();
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1000);
    };
    const bounded = async (action: () => Promise<unknown>) => {
      let deadline: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([action(), new Promise<never>((_, rejectTimeout) => {
          deadline = setTimeout(() => rejectTimeout(new Error('Runner request timed out')), options.requestTimeoutMs ?? 10_000);
        })]);
      } finally { if (deadline) clearTimeout(deadline); }
    };
    child.once('spawn', () => {
      spawned = true;
      pending = bounded(() => acknowledge(lifetime.signal, child.pid!)).then(() => {
        if (failure || lifetime.signal.aborted) return;
        acknowledged = true;
        // Structured input is delivered only after the server accepted this worker.
        child.stdin.end(JSON.stringify({workItem}));
        timer = setInterval(() => {
          if (heartbeatRunning || failure) return;
          heartbeatRunning = true;
          pending = bounded(() => heartbeat(lifetime.signal)).then(controlId => {
            if (lifetime.signal.aborted) return;
            if (typeof controlId === 'string') {
              stopControlId = controlId;
              if (timer) clearInterval(timer);
              kill('SIGTERM');
              killTimer = setTimeout(() => kill('SIGKILL'), 1000);
            }
          }).catch(fail).finally(() => { heartbeatRunning = false; });
        }, options.heartbeatIntervalMs ?? 20_000);
      }).catch(fail);
    });
    child.stdin.on('error', () => { /* A process may finish without reading its input. */ });
    child.once('error', () => {
      if (!spawned) startFailed = true;
      else {
        failure = new Error('Host process failed after spawning. Reconcile before retrying.');
        kill('SIGKILL');
      }
    });
    child.once('close', async (code, signal) => {
      lifetime.abort();
      await pending;
      if (timer) clearInterval(timer);
      if (failure || stopControlId) kill('SIGKILL');
      if (killTimer) clearTimeout(killTimer);
      if (startFailed) resolve({spawned: false});
      else if (failure) reject(failure);
      else if (!acknowledged) reject(new Error('Host exited before launch acknowledgement. Reconcile before retrying.'));
      else resolve({spawned: true, exitCode: code ?? 1, exitSignal: signal ?? undefined, stopControlId});
    });
  });
}

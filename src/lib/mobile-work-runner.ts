import {spawn} from 'node:child_process';
import {mkdir, readFile, rename, stat, open} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

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
  checkpoint?: (workItem: Record<string, unknown>, signal: AbortSignal) => Promise<void>;
  refreshRunner?: (signal?: AbortSignal) => Promise<unknown>;
}

interface Receipt {
  version: 1;
  dispatchId: string;
  workItemId: string;
  state: 'launching' | 'finished' | 'reviewed' | 'stopped';
  exitCode?: number;
  stopControlId?: string;
  result?: {summary: string; artifactRefs: unknown[]};
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

/** Host configuration supplies the executable and directory. Phone input never becomes shell code. */
export async function consumeMobileDispatch(options: MobileRunnerOptions): Promise<'idle' | 'reviewed' | 'stopped'> {
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
  let newReceipt = false;
  try {
    // Reserve before spawning. A second consumer or a restart cannot execute it again.
    await durableWrite(receiptPath, receipt, true);
    await syncDirectory(options.receiptDirectory);
    newReceipt = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Receipt;
    if (receipt.version !== 1 || receipt.dispatchId !== dispatch.id || receipt.workItemId !== workItem.id) {
      throw new Error('Dispatch receipt identity mismatch.');
    }
    if (receipt.state === 'launching') {
      throw new Error('Dispatch already launched or interrupted. Reconcile on the host before retrying; automatic re-execution is disabled.');
    }
    if (receipt.state === 'reviewed') return 'reviewed';
    if (!['finished', 'stopped'].includes(receipt.state) || !Number.isInteger(receipt.exitCode)) throw new Error('Invalid dispatch receipt.');
  }
  const saveReceipt = async () => {
    const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
    await durableWrite(temporaryPath, receipt);
    await rename(temporaryPath, receiptPath);
    await syncDirectory(options.receiptDirectory);
  };
  const claimBody = {workspaceId, claimOwner: `mobile-runner:${runnerId}`, claimToken: workItem.claimToken};
  const heartbeat = (signal?: AbortSignal) => api.request(`/api/v1/work-items/${workItem.id}/heartbeat`, {...claimBody, leaseSeconds: 300}, undefined, signal);
  if (newReceipt) {
    const safeWorkItem: Record<string, unknown> = {...workItem};
    delete safeWorkItem.claimToken;
    const resultPath = join(options.receiptDirectory, `${dispatch.id}.result.json`);
    const result = await runHostExecutable(options, safeWorkItem, resultPath, async signal => {
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
    receipt.exitCode = result.exitCode;
    receipt.stopControlId = result.stopControlId;
    receipt.state = result.stopControlId ? 'stopped' : 'finished';
    if (!result.stopControlId) {
      try {
        if ((await stat(resultPath)).size > 65536) throw new Error('Result exceeds 64 KiB');
        const authored = JSON.parse(await readFile(resultPath, 'utf8'));
        if (typeof authored.summary !== 'string' || authored.summary.length > 16000 || !Array.isArray(authored.artifactRefs) || authored.artifactRefs.length > 50) {
          throw new Error('Invalid host result');
        }
        receipt.result = {summary: authored.summary, artifactRefs: authored.artifactRefs};
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Host result file is invalid. Reconcile on the host before submitting it.');
      }
    }
    await saveReceipt();
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
  acknowledge: (signal: AbortSignal) => Promise<void>,
  heartbeat: (signal: AbortSignal) => Promise<string | undefined>,
): Promise<{exitCode: number; stopControlId?: string}> {
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
      pending = bounded(() => acknowledge(lifetime.signal)).then(() => {
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
    child.once('error', () => { failure = new Error('Configured host executable could not start.'); });
    child.once('close', async (code) => {
      lifetime.abort();
      await pending;
      if (timer) clearInterval(timer);
      if (failure || stopControlId) kill('SIGKILL');
      if (killTimer) clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (!acknowledged) reject(new Error('Host exited before launch acknowledgement. Reconcile before retrying.'));
      else resolve({exitCode: code ?? 1, stopControlId});
    });
  });
}

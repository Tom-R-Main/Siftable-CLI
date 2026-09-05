import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, open, readFile, rm, writeFile, stat, mkdir, symlink, lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {consumeMobileDispatch, type MobileRunnerApi} from './mobile-work-runner';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {...actual, open: vi.fn(actual.open)};
});

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {...actual, spawn: vi.fn(actual.spawn)};
});

const runnerId = '11111111-1111-4111-8111-111111111111';
const dispatchId = '22222222-2222-4222-8222-222222222222';
const workItemId = '33333333-3333-4333-8333-333333333333';
const controlId = '44444444-4444-4444-8444-444444444444';
const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, {recursive: true, force: true}))); });

async function fixture(control?: 'stop' | 'checkpoint', termination?: number | 'SIGTERM') {
  const directory = await mkdtemp(join(tmpdir(), 'mobile-host-test-'));
  paths.push(directory);
  const marker = join(directory, 'executions');
  const calls: Array<{path: string; body: any; key?: string}> = [];
  let failReview = false;
  const api: MobileRunnerApi = {async request<T>(path, body, key) {
    calls.push({path, body, key});
    if (path.endsWith('/consume')) return {
      dispatch: {id: dispatchId, workItemId},
      workItem: {id: workItemId, claimToken: 'synthetic-worker-lease', prompt: 'Do not execute $(touch unexpected)'},
      controls: control && calls.filter(call => call.path.endsWith('/consume')).length > 1
        ? [{id: controlId, action: control}] : [],
    } as T;
    if (path.endsWith('/review') && failReview) throw new Error('Simulated lost response');
    return {} as T;
  }};
  return {
    directory, marker, calls, loseReview: () => { failReview = true; }, restore: () => { failReview = false; },
    options: {
      api, runnerId, workspaceId: null, executable: process.execPath,
      args: ['-e', `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const work=JSON.parse(input).workItem;if(work.claimToken)process.exit(9);require('fs').appendFileSync(process.argv[1],'once\\n');require('fs').writeFileSync(process.env.SIFT_WORK_RESULT_PATH,JSON.stringify({summary:'Synthetic deliverable',artifactRefs:[]}));${typeof termination === 'number' ? `process.exit(${termination})` : termination ? `process.kill(process.pid,'${termination}')` : control ? 'setTimeout(()=>process.exit(0),500)' : ''}});`, marker],
      cwd: directory, receiptDirectory: directory, heartbeatIntervalMs: 30,
    },
  };
}

const attachmentId = '55555555-5555-4555-8555-555555555555';
const otherAttachmentId = '66666666-6666-4666-8666-666666666666';
const attachmentBytes = Buffer.from('Attached brief: count three tasks.\n\u0000binary-tail', 'utf8');
function attachmentContent(receiptId = attachmentId) {
  return {receiptId, byteLength: attachmentBytes.length,
    sha256: createHash('sha256').update(attachmentBytes).digest('hex'), contentBase64: attachmentBytes.toString('base64')};
}
function attachToFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  attachments: unknown = [{receiptId: attachmentId, name: '../outside/brief.txt'}],
  content: (path: string) => unknown = () => attachmentContent(),
) {
  const request = f.options.api.request.bind(f.options.api);
  f.options.api.request = async <T>(path: string, body: unknown, key?: string, signal?: AbortSignal): Promise<T> => {
    const response = await request<Record<string, any>>(path, body, key, signal);
    if (path.endsWith('/consume')) response.workItem.inputContext = {attachments};
    if (path.includes('/attachments/')) return content(path) as T;
    return response as T;
  };
}

describe('mobile host runner', () => {
  it('runs one real process, excludes lease input and replays a lost result without executing twice', async () => {
    const f = await fixture();
    f.loseReview();
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('lost response');
    f.restore();
    expect(await consumeMobileDispatch(f.options)).toBe('reviewed');
    expect(await readFile(f.marker, 'utf8')).toBe('once\n');
    const receipt = await readFile(join(f.directory, `${dispatchId}.json`), 'utf8');
    expect(receipt).not.toContain('synthetic-worker-lease');
    expect(f.calls.filter(call => call.path.endsWith('/review')).map(call => call.key)).toEqual([`${dispatchId}:review`, `${dispatchId}:review`]);
    expect(f.calls.find(call => call.path.endsWith('/review'))?.body.resultSummary).toBe('Synthetic deliverable');
  });

  it.each(['ENOENT', 'EACCES'])('fails a confirmed no-spawn %s dispatch without running or stranding it', async failure => {
    const f = await fixture();
    f.options.executable = join(f.directory, 'unavailable-executable');
    if (failure === 'EACCES') await writeFile(f.options.executable, '#!/bin/sh\nexit 0\n', {mode: 0o600});
    expect(await consumeMobileDispatch(f.options)).toBe('failed');
    expect(f.calls.find(call => call.path.endsWith('/ack'))?.body).toMatchObject({state: 'failed'});
    expect(f.calls.some(call => call.path.endsWith('/heartbeat') || call.path.endsWith('/review') || call.path.endsWith('/fail'))).toBe(false);
    expect(JSON.parse(await readFile(join(f.directory, `${dispatchId}.json`), 'utf8')).state).toBe('failed');
    f.options.executable = process.execPath;
    expect(await consumeMobileDispatch(f.options)).toBe('failed');
    await expect(readFile(f.marker, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('persists definitive no-spawn evidence before failed ACK and retries a lost response without spawning', async () => {
    const f = await fixture();
    f.options.executable = join(f.directory, 'missing-executable');
    const originalRequest = f.options.api.request.bind(f.options.api);
    let lost = true;
    f.options.api.request = async <T>(path: string, body: unknown, key?: string, signal?: AbortSignal): Promise<T> => {
      const response = await originalRequest<T>(path, body, key, signal);
      if (path.endsWith('/ack')) {
        expect(body).toMatchObject({state: 'failed'});
        const persisted = await readFile(join(f.directory, `${dispatchId}.json`), 'utf8');
        expect(JSON.parse(persisted).state).toBe('start_failed');
        expect(persisted).not.toContain('synthetic-worker-lease');
        if (lost) throw new Error('Lost failed acknowledgement response');
      }
      return response;
    };
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('Lost failed acknowledgement response');
    lost = false;
    f.options.executable = process.execPath;
    expect(await consumeMobileDispatch(f.options)).toBe('failed');
    const acknowledgements = f.calls.filter(call => call.path.endsWith('/ack'));
    expect(acknowledgements).toHaveLength(2);
    expect(acknowledgements[0].key).toBe(`${dispatchId}:start-failed`);
    expect(acknowledgements[1]).toEqual(acknowledgements[0]);
    await expect(readFile(f.marker, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('keeps an error after a real spawn uncertain instead of claiming the executable never started', async () => {
    const f = await fixture();
    const originalRequest = f.options.api.request.bind(f.options.api);
    f.options.api.request = async <T>(path: string, body: unknown, key?: string, signal?: AbortSignal): Promise<T> => {
      if (path.endsWith('/ack')) {
        const child = vi.mocked(spawn).mock.results.at(-1)?.value;
        expect(child.pid).toBeGreaterThan(0);
        child.emit('error', new Error('Synthetic error after spawn'));
      }
      return originalRequest<T>(path, body, key, signal);
    };
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('failed after spawning');
    expect(JSON.parse(await readFile(join(f.directory, `${dispatchId}.json`), 'utf8')).state).toBe('launching');
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('already launched or interrupted');
    expect(f.calls.some(call => call.path.endsWith('/ack') && call.body.state === 'failed')).toBe(false);
    expect(f.calls.some(call => call.path.endsWith('/review'))).toBe(false);
  });

  it('stops the actual process before acknowledging the control and never submits it as a result', async () => {
    const f = await fixture('stop');
    expect(await consumeMobileDispatch(f.options)).toBe('stopped');
    expect(f.calls.find(call => call.path.endsWith('/controls/ack'))?.body).toMatchObject({controlId, state: 'acknowledged'});
    expect(f.calls.some(call => call.path.endsWith('/review'))).toBe(false);
    expect(JSON.parse(await readFile(join(f.directory, `${dispatchId}.json`), 'utf8')).state).toBe('stopped');
    expect(f.calls.some(call => call.path.endsWith('/fail'))).toBe(false);
  });

  it('runs a configured checkpoint once even when delivery is repeated', async () => {
    const f = await fixture('checkpoint');
    let checkpoints = 0;
    expect(await consumeMobileDispatch({...f.options, checkpoint: async () => { checkpoints += 1; }})).toBe('reviewed');
    expect(checkpoints).toBe(1);
    expect(f.calls.find(call => call.path.endsWith('/controls/ack'))?.body.state).toBe('acknowledged');
  });

  it('fences delayed heartbeat continuations after the worker has been stopped', async () => {
    const f = await fixture('checkpoint');
    let checkpoints = 0;
    await expect(consumeMobileDispatch({
      ...f.options, requestTimeoutMs: 30,
      refreshRunner: () => new Promise(resolve => setTimeout(resolve, 120)),
      checkpoint: async () => { checkpoints += 1; },
    })).rejects.toThrow('heartbeat failed');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(checkpoints).toBe(0);
    expect(f.calls.filter(call => call.path.endsWith('/consume'))).toHaveLength(1);
    expect(f.calls.some(call => call.path.endsWith('/controls/ack'))).toBe(false);
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('already launched or interrupted');
    expect(f.calls.some(call => call.path.endsWith('/ack') && call.body.state === 'failed')).toBe(false);
  });

  it('does not submit a result when the child exits before launch acknowledgement succeeds', async () => {
    const f = await fixture();
    const originalRequest = f.options.api.request.bind(f.options.api);
    const api: MobileRunnerApi = {
      async request<T>(path, body, key, signal) {
        if (path.endsWith('/ack')) {
          return new Promise<T>((_resolve, reject) => {
            if (signal?.aborted) { reject(new Error('Acknowledgement aborted')); return; }
            signal?.addEventListener('abort', () => reject(new Error('Acknowledgement aborted')), {once: true});
          });
        }
        return originalRequest<T>(path, body, key, signal);
      },
    };
    await expect(consumeMobileDispatch({
      ...f.options, api,
      // This executable exits without consuming the stdin gated on acknowledgement.
      args: ['-e', 'process.exit(0)'],
      requestTimeoutMs: 1000,
    })).rejects.toThrow();
    expect(f.calls.some(call => call.path.endsWith('/review'))).toBe(false);
  });

  it('reports failed consistently when a checkpoint marker cannot be persisted', async () => {
    const f = await fixture('checkpoint');
    let checkpoints = 0;
    expect(await consumeMobileDispatch({...f.options, checkpoint: async () => {
      checkpoints += 1;
      vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error('storage unavailable'), {code: 'EACCES'}));
    }})).toBe('reviewed');
    expect(checkpoints).toBe(1);
    const acknowledgements = f.calls.filter(call => call.path.endsWith('/controls/ack'));
    expect(acknowledgements.length).toBeGreaterThan(1);
    expect(acknowledgements.every(call => call.body.state === 'failed')).toBe(true);
    expect(JSON.parse(await readFile(join(f.directory, `${controlId}.control.json`), 'utf8')).state).toBe('failed');
  });

  it.each([17, 'SIGTERM'] as const)('routes actual process termination %s to failure, never review', async termination => {
    const f = await fixture(undefined, termination);
    expect(await consumeMobileDispatch(f.options)).toBe('failed');
    expect(f.calls.some(call => call.path.endsWith('/review'))).toBe(false);
    const failure = f.calls.find(call => call.path.endsWith('/fail'));
    expect(failure?.key).toBe(`${dispatchId}:fail`);
    expect(failure?.body).toMatchObject({
      failureReason: typeof termination === 'number' ? 'Host worker exited with code 17.' : 'Host worker terminated by SIGTERM.',
      artifactRefs: [{type: 'worker_run', dispatchId, exitCode: typeof termination === 'number' ? termination : 1}],
    });
    expect(failure?.body.resultSummary).not.toBe('Synthetic deliverable');
    const receipt = JSON.parse(await readFile(join(f.directory, `${dispatchId}.json`), 'utf8'));
    expect(receipt.state).toBe('failed');
    expect(receipt.result).toBeUndefined();
    if (typeof termination === 'string') expect(receipt.exitSignal).toBe(termination);
  });

  it('replays a lost failure response with the same identity without launching again', async () => {
    const f = await fixture(undefined, 23);
    const originalRequest = f.options.api.request.bind(f.options.api);
    let lost = true;
    f.options.api.request = async <T>(path: string, body: unknown, key?: string, signal?: AbortSignal): Promise<T> => {
      const response = await originalRequest<T>(path, body, key, signal);
      if (path.endsWith('/fail') && lost) throw new Error('Simulated lost failure response');
      return response;
    };
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('lost failure response');
    expect(JSON.parse(await readFile(join(f.directory, `${dispatchId}.json`), 'utf8')).state).toBe('finished');
    lost = false;
    expect(await consumeMobileDispatch(f.options)).toBe('failed');
    expect(await consumeMobileDispatch(f.options)).toBe('failed');
    expect(await readFile(f.marker, 'utf8')).toBe('once\n');
    const failures = f.calls.filter(call => call.path.endsWith('/fail'));
    expect(failures.map(call => call.key)).toEqual([`${dispatchId}:fail`, `${dispatchId}:fail`]);
    expect(failures[0].body).toEqual(failures[1].body);
    expect(f.calls.some(call => call.path.endsWith('/review'))).toBe(false);
  });

  it('delivers byte-exact private files to an actual worker and cleans them before result retry', async () => {
    const f = await fixture();
    attachToFixture(f);
    f.options.args = ['-e', `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
      const fs=require('fs'),path=require('path'),work=JSON.parse(input).workItem,a=work.inputContext.attachments[0];
      if(work.claimToken||a.name!=='../outside/brief.txt')process.exit(9);
      if((fs.statSync(a.localPath).mode&511)!==256||(fs.statSync(path.dirname(a.localPath)).mode&511)!==448)process.exit(8);
      const bytes=fs.readFileSync(a.localPath);
      fs.appendFileSync(process.argv[1],a.localPath+'\\n');
      fs.writeFileSync(process.env.SIFT_WORK_RESULT_PATH,JSON.stringify({summary:'Brief bytes: '+bytes.toString('hex'),artifactRefs:[]}));
    });`, f.marker];
    f.loseReview();
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('lost response');
    const localPath = (await readFile(f.marker, 'utf8')).trim();
    expect(localPath).toBe(join(f.directory, `${dispatchId}.attachments`, `0-${attachmentId}`));
    await expect(stat(localPath)).rejects.toMatchObject({code: 'ENOENT'});
    await expect(stat(join(f.directory, `${dispatchId}.attachments`))).rejects.toMatchObject({code: 'ENOENT'});
    expect(f.calls.find(call => call.path.endsWith('/review'))?.body.resultSummary).toBe(`Brief bytes: ${attachmentBytes.toString('hex')}`);
    f.restore();
    expect(await consumeMobileDispatch(f.options)).toBe('reviewed');
    expect(f.calls.filter(call => call.path.includes('/attachments/'))).toHaveLength(1);
    expect((await readFile(f.marker, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it.each(['unavailable', 'wrong receipt', 'hash mismatch', 'length mismatch', 'noncanonical base64', 'oversized', 'oversized encoded body'])('fails closed before spawn for %s attachment content', async failure => {
    const f = await fixture();
    attachToFixture(f, undefined, () => {
      const content = attachmentContent();
      if (failure === 'unavailable') throw new Error('private provider error must not reach work records');
      if (failure === 'wrong receipt') content.receiptId = otherAttachmentId;
      if (failure === 'hash mismatch') content.sha256 = '0'.repeat(64);
      if (failure === 'length mismatch') content.byteLength += 1;
      if (failure === 'noncanonical base64') content.contentBase64 += '\n';
      if (failure === 'oversized') content.byteLength = 20 * 1024 * 1024 + 1;
      if (failure === 'oversized encoded body') content.contentBase64 = 'a'.repeat(Math.ceil(20 * 1024 * 1024 / 3) * 4 + 1);
      return content;
    });
    const starts = vi.mocked(spawn).mock.calls.length;
    expect(await consumeMobileDispatch(f.options)).toBe('failed');
    expect(vi.mocked(spawn).mock.calls).toHaveLength(starts);
    expect(f.calls.find(call => call.path.endsWith('/ack'))?.body.state).toBe('failed');
    expect(f.calls.some(call => call.path.endsWith('/review'))).toBe(false);
    expect(JSON.stringify(f.calls)).not.toContain('private provider error');
    await expect(stat(join(f.directory, `${dispatchId}.attachments`))).rejects.toMatchObject({code: 'ENOENT'});
    expect(JSON.parse(await readFile(join(f.directory, `${dispatchId}.json`), 'utf8')).state).toBe('failed');
  });

  it('cleans earlier attachment files if a later receipt is unavailable', async () => {
    const f = await fixture();
    attachToFixture(f, [{receiptId: attachmentId, name: 'one'}, {receiptId: otherAttachmentId, name: 'two'}], path => {
      if (path.endsWith(otherAttachmentId)) throw new Error('unavailable');
      return attachmentContent();
    });
    expect(await consumeMobileDispatch(f.options)).toBe('failed');
    expect(f.calls.filter(call => call.path.includes('/attachments/'))).toHaveLength(2);
    await expect(stat(join(f.directory, `${dispatchId}.attachments`))).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(f.marker, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it.each(['spawn failure', 'nonzero exit', 'stop'])('cleans materialized files after %s', async termination => {
    const f = await fixture(termination === 'stop' ? 'stop' : undefined, termination === 'nonzero exit' ? 17 : undefined);
    attachToFixture(f);
    if (termination === 'spawn failure') f.options.executable = join(f.directory, 'unavailable');
    expect(await consumeMobileDispatch(f.options)).toBe(termination === 'stop' ? 'stopped' : 'failed');
    await expect(stat(join(f.directory, `${dispatchId}.attachments`))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('does not download or spawn again when retrying a failed preparation acknowledgement', async () => {
    const f = await fixture();
    attachToFixture(f, undefined, () => {throw new Error('unavailable');});
    const request = f.options.api.request.bind(f.options.api);
    let lost = true;
    f.options.api.request = async <T>(path: string, body: unknown, key?: string, signal?: AbortSignal): Promise<T> => {
      const response = await request<T>(path, body, key, signal);
      if (path.endsWith('/ack') && lost) throw new Error('Lost acknowledgement');
      return response;
    };
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('Lost acknowledgement');
    expect(JSON.parse(await readFile(join(f.directory, `${dispatchId}.json`), 'utf8')).state).toBe('start_failed');
    lost = false;
    expect(await consumeMobileDispatch(f.options)).toBe('failed');
    expect(f.calls.filter(call => call.path.includes('/attachments/'))).toHaveLength(1);
    expect(f.calls.filter(call => call.path.endsWith('/ack')).map(call => call.key)).toEqual([`${dispatchId}:start-failed`, `${dispatchId}:start-failed`]);
    await expect(readFile(f.marker, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('rejects more than 20 attachment receipts before retrieval or spawn', async () => {
    const f = await fixture();
    attachToFixture(f, Array.from({length: 21}, () => ({receiptId: attachmentId, name: 'brief'})));
    expect(await consumeMobileDispatch(f.options)).toBe('failed');
    expect(f.calls.some(call => call.path.includes('/attachments/'))).toBe(false);
    await expect(readFile(f.marker, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('does not follow an existing attachment-directory symlink or alter its target', async () => {
    const f = await fixture();
    attachToFixture(f);
    const outside = join(f.directory, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'retain'), 'keep');
    const directory = join(f.directory, `${dispatchId}.attachments`);
    await symlink(outside, directory);
    expect(await consumeMobileDispatch(f.options)).toBe('failed');
    expect((await lstat(directory)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, 'retain'), 'utf8')).toBe('keep');
    expect(f.calls.some(call => call.path.includes('/attachments/'))).toBe(false);
    await expect(readFile(f.marker, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it.each([
    {summary: 'Authorization: Bearer synthetic-output-sentinel', artifactRefs: []},
    {summary: 'Finished', artifactRefs: [{metadata: {apiKey: 'synthetic-output-sentinel'}}]},
    {summary: 'Finished', artifactRefs: [{url: 'https://example.test?token=synthetic-output-sentinel'}]},
    {summary: 'Finished', artifactRefs: [{'Bearer synthetic-output-sentinel': 'metadata'}]},
  ])('rejects secret-bearing worker output before durable receipts and review', async authored => {
    const f = await fixture();
    f.options.args = ['-e', `process.stdin.resume();process.stdin.on('end',()=>require('fs').writeFileSync(process.env.SIFT_WORK_RESULT_PATH,${JSON.stringify(JSON.stringify(authored))}));`];
    expect(await consumeMobileDispatch(f.options)).toBe('failed');
    expect(f.calls.some(call => call.path.endsWith('/review'))).toBe(false);
    expect(f.calls.find(call => call.path.endsWith('/fail'))?.body.failureReason).toBe('Host result rejected because it contains inline secret material.');
    expect(JSON.stringify(f.calls)).not.toContain('synthetic-output-sentinel');
    const persisted = await readFile(join(f.directory, `${dispatchId}.json`), 'utf8');
    expect(persisted).not.toContain('synthetic-output-sentinel');
    expect(JSON.parse(persisted)).toMatchObject({state: 'failed', resultRejected: true});
    expect(JSON.parse(persisted).result).toBeUndefined();
    await expect(stat(join(f.directory, `${dispatchId}.result.json`))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it.each(['finished', 'reviewed'])('guards and scrubs secret-bearing legacy %s receipts before any replay', async state => {
    const f = await fixture();
    const unsafeResult = {summary: 'sift_pat_synthetic_receipt_sentinel', artifactRefs: []};
    await writeFile(join(f.directory, `${dispatchId}.json`), JSON.stringify({version: 1, dispatchId, workItemId, state, exitCode: 0, result: unsafeResult}));
    await writeFile(join(f.directory, `${dispatchId}.result.json`), JSON.stringify(unsafeResult));
    const starts = vi.mocked(spawn).mock.calls.length;
    expect(await consumeMobileDispatch(f.options)).toBe('failed');
    expect(vi.mocked(spawn).mock.calls).toHaveLength(starts);
    expect(f.calls.some(call => call.path.endsWith('/review'))).toBe(false);
    expect(JSON.stringify(f.calls)).not.toContain('synthetic_receipt_sentinel');
    expect(await readFile(join(f.directory, `${dispatchId}.json`), 'utf8')).not.toContain('synthetic_receipt_sentinel');
    await expect(stat(join(f.directory, `${dispatchId}.result.json`))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('retries sanitized output rejection without restoring rejected content', async () => {
    const f = await fixture();
    f.options.args = ['-e', `process.stdin.resume();process.stdin.on('end',()=>require('fs').writeFileSync(process.env.SIFT_WORK_RESULT_PATH,JSON.stringify({summary:'password=synthetic-retry-sentinel',artifactRefs:[]})));`];
    const request = f.options.api.request.bind(f.options.api);
    let lost = true;
    f.options.api.request = async <T>(path: string, body: unknown, key?: string, signal?: AbortSignal): Promise<T> => {
      const response = await request<T>(path, body, key, signal);
      if (path.endsWith('/fail') && lost) throw new Error('Lost rejection acknowledgement');
      return response;
    };
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('Lost rejection acknowledgement');
    const starts = vi.mocked(spawn).mock.calls.length;
    lost = false;
    expect(await consumeMobileDispatch(f.options)).toBe('failed');
    expect(vi.mocked(spawn).mock.calls).toHaveLength(starts);
    const failures = f.calls.filter(call => call.path.endsWith('/fail'));
    expect(failures).toHaveLength(2);
    expect(failures[0]).toEqual(failures[1]);
    expect(JSON.stringify(f.calls)).not.toContain('synthetic-retry-sentinel');
  });

  it('preserves non-secret environment references in authored results', async () => {
    const f = await fixture();
    const summary = 'Read the API using Bearer $SIFT_TOKEN and token="$TOKEN"';
    f.options.args = ['-e', `process.stdin.resume();process.stdin.on('end',()=>require('fs').writeFileSync(process.env.SIFT_WORK_RESULT_PATH,${JSON.stringify(JSON.stringify({summary,artifactRefs:[]}))}));`];
    expect(await consumeMobileDispatch(f.options)).toBe('reviewed');
    expect(f.calls.find(call => call.path.endsWith('/review'))?.body.resultSummary).toBe(summary);
  });

  it('scrubs legacy rejected content even when the server lease no longer permits failure', async () => {
    const f = await fixture();
    const receiptPath = join(f.directory, `${dispatchId}.json`);
    await writeFile(receiptPath, JSON.stringify({version: 1, dispatchId, workItemId, state: 'reviewed', exitCode: 0,
      apiKey: 'synthetic-retired-sentinel', result: {summary: 'Authorization: Bearer synthetic-retired-sentinel', artifactRefs: []}}));
    await writeFile(join(f.directory, `${dispatchId}.result.json`), 'synthetic-retired-sentinel');
    const request = f.options.api.request.bind(f.options.api);
    f.options.api.request = async <T>(path: string, body: unknown, key?: string, signal?: AbortSignal): Promise<T> => {
      if (path.endsWith('/heartbeat')) throw new Error('Lease is no longer active; reconcile on host');
      return request<T>(path, body, key, signal);
    };
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('Lease is no longer active');
    const persisted = await readFile(receiptPath, 'utf8');
    expect(persisted).not.toContain('synthetic-retired-sentinel');
    expect(JSON.parse(persisted)).toMatchObject({state: 'finished', resultRejected: true});
    expect(f.calls.some(call => call.path.endsWith('/review') || call.path.endsWith('/fail'))).toBe(false);
    await expect(stat(join(f.directory, `${dispatchId}.result.json`))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('does not expose malformed receipt text through JSON parse errors', async () => {
    const f = await fixture();
    await writeFile(join(f.directory, `${dispatchId}.json`), '{"password":"synthetic-malformed-sentinel" broken');
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('Invalid dispatch receipt.');
    expect(f.calls.some(call => call.path.endsWith('/review'))).toBe(false);
  });

});

import {mkdtemp, open, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {consumeMobileDispatch, type MobileRunnerApi} from './mobile-work-runner';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {...actual, open: vi.fn(actual.open)};
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

  it('reserves execution before spawning and refuses automatic restart after an interrupted launch', async () => {
    const f = await fixture();
    f.options.executable = join(f.directory, 'missing-executable');
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('could not start');
    f.options.executable = process.execPath;
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('already launched or interrupted');
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

});

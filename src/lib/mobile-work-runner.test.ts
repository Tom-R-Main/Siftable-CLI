import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, open, readFile, rm, writeFile, stat, mkdir, symlink, lstat, realpath, rename, chmod} from 'node:fs/promises';
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

function fakeRequestClock() {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('Synthetic request timeout')), milliseconds);
    return controller.signal;
  });
  return () => { timeout.mockRestore(); vi.useRealTimers(); };
}

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

async function interruptedAttachmentFixture() {
  const f = await fixture();
  const child = spawn(process.execPath, ['-e', ''], {stdio: 'ignore'});
  const deadPid = child.pid!;
  await new Promise<void>(resolve => child.once('close', () => resolve()));
  const rootPath = await realpath(f.directory);
  const root = await lstat(rootPath);
  const directory = join(rootPath, `${dispatchId}.attachments`);
  await mkdir(directory, {mode: 0o700});
  const scratch = await lstat(directory);
  const localPath = join(directory, `0-${attachmentId}`);
  await writeFile(localPath, attachmentBytes, {mode: 0o400});
  await writeFile(join(f.directory, 'consumer.json'), JSON.stringify({id: controlId}), {mode: 0o600});
  const receipt = {version: 1, dispatchId, workItemId, state: 'launching', attachmentScratch: {
    version: 1, consumerId: controlId, runnerId, workspaceId: null, ownerPid: deadPid, childPid: deadPid,
    phase: 'spawned', rootPath, rootDev: root.dev, rootIno: root.ino, directoryDev: scratch.dev, directoryIno: scratch.ino,
  }};
  const save = () => writeFile(join(f.directory, `${dispatchId}.json`), JSON.stringify(receipt), {mode: 0o600});
  await save();
  return {...f, receipt, save, scratchDirectory: directory, localPath};
}

async function interruptedResultFixture() {
  const f = await interruptedAttachmentFixture();
  const directory = join(f.directory, `${dispatchId}.result`);
  await rename(f.scratchDirectory, directory);
  const path = join(directory, 'result.json');
  await rename(join(directory, `0-${attachmentId}`), path);
  await chmod(path, 0o600);
  await writeFile(path, JSON.stringify({summary: 'Transient result sentinel', artifactRefs: []}));
  Object.assign(f.receipt, {resultScratch: f.receipt.attachmentScratch});
  Reflect.deleteProperty(f.receipt, 'attachmentScratch');
  await f.save();
  return {...f, resultDirectory: directory, resultPath: path};
}

describe('mobile host runner', () => {
  it('precreates a private result inside a private dispatch directory under an unchanged 0755 operator root', async () => {
    const f = await fixture();
    await chmod(f.directory, 0o755);
    const previousMask = process.umask(0o022);
    f.options.args = ['-e', `process.stdin.resume();process.stdin.on('end',()=>{const fs=require('fs'),p=process.env.SIFT_WORK_RESULT_PATH;
      const fileMode=fs.existsSync(p)?fs.statSync(p).mode&511:null, directoryMode=fs.statSync(require('path').dirname(p)).mode&511;
      fs.writeFileSync(p,JSON.stringify({summary:'Private result',artifactRefs:[{fileMode,directoryMode}]}));});`];
    try {
      expect(await consumeMobileDispatch(f.options)).toBe('reviewed');
      expect(f.calls.find(call => call.path.endsWith('/review'))?.body.artifactRefs[0]).toEqual({fileMode: 0o600, directoryMode: 0o700});
      expect((await stat(f.directory)).mode & 0o777).toBe(0o755);
      expect((await stat(join(f.directory, `${dispatchId}.json`))).mode & 0o777).toBe(0o600);
      await expect(lstat(join(f.directory, `${dispatchId}.result`))).rejects.toMatchObject({code: 'ENOENT'});
      await expect(lstat(join(f.directory, `${dispatchId}.result.json`))).rejects.toMatchObject({code: 'ENOENT'});
    } finally { process.umask(previousMask); }
  });

  it.each([0, 9, 'SIGTERM'] as const)('removes transient results after a durable outcome for exit %s, including lost response replay', async exit => {
    const f = await fixture(undefined, exit);
    f.loseReview();
    if (exit === 0) await expect(consumeMobileDispatch(f.options)).rejects.toThrow('Simulated lost response');
    else expect(await consumeMobileDispatch(f.options)).toBe('failed');
    const receipt = JSON.parse(await readFile(join(f.directory, `${dispatchId}.json`), 'utf8'));
    expect(receipt.state).toBe(exit === 0 ? 'finished' : 'failed');
    await expect(lstat(join(f.directory, `${dispatchId}.result`))).rejects.toMatchObject({code: 'ENOENT'});
    await expect(lstat(join(f.directory, `${dispatchId}.result.json`))).rejects.toMatchObject({code: 'ENOENT'});
    const starts = vi.mocked(spawn).mock.calls.length;
    f.restore();
    expect(await consumeMobileDispatch(f.options)).toBe(exit === 0 ? 'reviewed' : 'failed');
    expect(vi.mocked(spawn).mock.calls).toHaveLength(starts);
  });

  it.each(['symlink', 'hardlink', 'fifo', 'relaxed-mode'] as const)('rejects unsafe result replacement by %s without persisting or exposing its contents', async replacement => {
    const f = await fixture();
    const outside = join(f.directory, 'outside.json');
    await writeFile(outside, JSON.stringify({summary: 'Untrusted replacement sentinel', artifactRefs: []}), {mode: 0o600});
    f.options.args = ['-e', `process.stdin.resume();process.stdin.on('end',()=>{const fs=require('fs'),p=process.env.SIFT_WORK_RESULT_PATH;
      fs.unlinkSync(p);${replacement === 'symlink' ? `fs.symlinkSync(${JSON.stringify(outside)},p);`
        : replacement === 'hardlink' ? `fs.linkSync(${JSON.stringify(outside)},p);`
        : replacement === 'fifo' ? `require('child_process').execFileSync('mkfifo',[p]);`
        : `fs.writeFileSync(p+'.tmp',fs.readFileSync(${JSON.stringify(outside)}),{mode:0o644});fs.chmodSync(p+'.tmp',0o644);fs.renameSync(p+'.tmp',p);`}});`];
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('Host result file is invalid');
    expect(f.calls.some(call => call.path.endsWith('/review'))).toBe(false);
    expect(await readFile(join(f.directory, `${dispatchId}.json`), 'utf8')).not.toContain('Untrusted replacement sentinel');
    expect(await readFile(outside, 'utf8')).toContain('Untrusted replacement sentinel');
    expect((await lstat(join(f.directory, `${dispatchId}.result`))).mode & 0o777).toBe(0o700);
  });

  it('does not replace or delete an existing result-directory symlink', async () => {
    const f = await fixture();
    const outside = join(f.directory, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'retain'), 'retain');
    await symlink(outside, join(f.directory, `${dispatchId}.result`));
    const starts = vi.mocked(spawn).mock.calls.length;
    expect(await consumeMobileDispatch(f.options)).toBe('failed');
    expect(vi.mocked(spawn).mock.calls).toHaveLength(starts);
    expect(await readFile(join(outside, 'retain'), 'utf8')).toBe('retain');
    expect((await lstat(join(f.directory, `${dispatchId}.result`))).isSymbolicLink()).toBe(true);
  });

  it.each(['launching', 'finished', 'reviewed', 'failed', 'stopped', 'start_failed'])('reconciles private result retention on %s replay without reading transient bytes or respawning', async state => {
    const f = await interruptedResultFixture();
    Object.assign(f.receipt, {state, exitCode: 0, ...(state === 'launching' ? {} : {result: {summary: 'Durable result', artifactRefs: []}}),
      ...(state === 'stopped' ? {stopControlId: controlId} : {})});
    await f.save();
    const starts = vi.mocked(spawn).mock.calls.length;
    if (state === 'launching') await expect(consumeMobileDispatch(f.options)).rejects.toThrow('automatic re-execution is disabled');
    else expect(await consumeMobileDispatch(f.options)).toBe(['failed', 'start_failed'].includes(state) ? 'failed' : state === 'stopped' ? 'stopped' : 'reviewed');
    if (state === 'launching') {
      expect(await readFile(f.resultPath, 'utf8')).toContain('Transient result sentinel');
      expect((await stat(f.resultDirectory)).mode & 0o777).toBe(0o700);
    } else await expect(lstat(f.resultDirectory)).rejects.toMatchObject({code: 'ENOENT'});
    expect(vi.mocked(spawn).mock.calls).toHaveLength(starts);
    expect(JSON.stringify(f.calls)).not.toContain('Transient result sentinel');
    if (state === 'finished') expect(f.calls.find(call => call.path.endsWith('/review'))?.body.resultSummary).toBe('Durable result');
  });

  it('preserves private transient results while the interrupted worker may still be alive', async () => {
    const f = await interruptedResultFixture();
    const record = f.receipt as unknown as {resultScratch: {childPid: number}};
    record.resultScratch.childPid = process.pid;
    await f.save();
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('automatic re-execution is disabled');
    expect(await readFile(f.resultPath, 'utf8')).toContain('Transient result sentinel');
    expect((await stat(f.resultDirectory)).mode & 0o777).toBe(0o700);
  });

  it('preserves the only authored result when the child exits but its durable outcome cannot be saved', async () => {
    const f = await fixture();
    const originalOpen = vi.mocked(open).getMockImplementation()!;
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (String(path).endsWith(`${dispatchId}.json.${process.pid}.tmp`)) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (data, options) => {
          if (typeof data === 'string' && JSON.parse(data).state === 'finished') throw new Error('Synthetic durable outcome failure');
          return write(data, options);
        };
      }
      return handle;
    });
    try {
      await expect(consumeMobileDispatch(f.options)).rejects.toThrow('Synthetic durable outcome failure');
    } finally { vi.mocked(open).mockImplementation(originalOpen); }
    const resultPath = join(f.directory, `${dispatchId}.result`, 'result.json');
    expect(JSON.parse(await readFile(resultPath, 'utf8')).summary).toBe('Synthetic deliverable');
    expect((await stat(resultPath)).mode & 0o777).toBe(0o600);
    const receipt = JSON.parse(await readFile(join(f.directory, `${dispatchId}.json`), 'utf8'));
    expect(receipt.state).toBe('launching');
    expect(receipt.result).toBeUndefined();
    const starts = vi.mocked(spawn).mock.calls.length;
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('automatic re-execution is disabled');
    expect(vi.mocked(spawn).mock.calls).toHaveLength(starts);
    expect(JSON.parse(await readFile(resultPath, 'utf8')).summary).toBe('Synthetic deliverable');
    expect(f.calls.some(call => call.path.endsWith('/review'))).toBe(false);
  });

  it('preserves an unowned legacy result symlink when replaying a durable receipt', async () => {
    const f = await fixture();
    const outside = join(f.directory, 'outside.json');
    await writeFile(outside, 'preserve external bytes');
    const legacyPath = join(f.directory, `${dispatchId}.result.json`);
    await symlink(outside, legacyPath);
    await writeFile(join(f.directory, `${dispatchId}.json`), JSON.stringify({version: 1, dispatchId, workItemId, state: 'reviewed', exitCode: 0}));
    expect(await consumeMobileDispatch(f.options)).toBe('reviewed');
    expect((await lstat(legacyPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, 'utf8')).toBe('preserve external bytes');
  });
  it.each([false, true])('allows a 45-second attachment transfer while renewing preparation leases (explicit attachment override: %s)', async explicitOverride => {
    const f = await fixture();
    attachToFixture(f);
    const restoreClock = fakeRequestClock();
    const refreshRunner = vi.fn(async () => ({}));
    const request = f.options.api.request.bind(f.options.api);
    let started!: () => void;
    const transferStarted = new Promise<void>(resolve => { started = resolve; });
    f.options.api.request = async <T>(path: string, body: unknown, key?: string, signal?: AbortSignal): Promise<T> => {
      if (path.includes('/attachments/')) {
        started();
        await new Promise<void>((resolve, reject) => {
          setTimeout(resolve, 45_000);
          signal?.addEventListener('abort', () => reject(signal.reason), {once: true});
        });
      }
      return request<T>(path, body, key, signal);
    };
    try {
      const spawns = vi.mocked(spawn).mock.calls.length;
      const run = consumeMobileDispatch({...f.options, refreshRunner, heartbeatIntervalMs: 20_000,
        ...(explicitOverride ? {requestTimeoutMs: 1000, attachmentRequestTimeoutMs: 120_000} : {})});
      await transferStarted;
      await vi.advanceTimersByTimeAsync(35_000);
      expect(vi.mocked(spawn).mock.calls).toHaveLength(spawns);
      expect(refreshRunner.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(vi.mocked(AbortSignal.timeout).mock.calls).toContainEqual([explicitOverride ? 1000 : 10_000]);
      expect(vi.mocked(AbortSignal.timeout).mock.calls).toContainEqual([120_000]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await run).toBe('reviewed');
      expect(await readFile(f.marker, 'utf8')).toBe('once\n');
      await expect(lstat(join(f.directory, `${dispatchId}.attachments`))).rejects.toMatchObject({code: 'ENOENT'});
      const calls = f.calls.length;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(f.calls).toHaveLength(calls);
    } finally { restoreClock(); }
  });

  it.each(['requestTimeoutMs', 'attachmentRequestTimeoutMs'] as const)('preserves an explicit short %s and safely fences a late attachment response', async timeoutOption => {
    const f = await fixture();
    attachToFixture(f);
    const restoreClock = fakeRequestClock();
    const request = f.options.api.request.bind(f.options.api);
    let started!: () => void;
    const transferStarted = new Promise<void>(resolve => { started = resolve; });
    f.options.api.request = async <T>(path: string, body: unknown, key?: string, signal?: AbortSignal): Promise<T> => {
      if (path.includes('/attachments/')) {
        started();
        // Deliberately ignore cancellation; a late transport continuation may
        // return bytes but must never write files or start execution.
        await new Promise(resolve => setTimeout(resolve, 45_000));
      }
      return request<T>(path, body, key, signal);
    };
    try {
      const spawns = vi.mocked(spawn).mock.calls.length;
      const run = consumeMobileDispatch({...f.options, [timeoutOption]: 500, heartbeatIntervalMs: 20_000});
      await transferStarted;
      await vi.advanceTimersByTimeAsync(500);
      expect(await run).toBe('failed');
      await expect(lstat(join(f.directory, `${dispatchId}.attachments`))).rejects.toMatchObject({code: 'ENOENT'});
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.mocked(spawn).mock.calls).toHaveLength(spawns);
      expect(f.calls.filter(call => call.path.endsWith('/ack'))).toEqual([
        expect.objectContaining({key: `${dispatchId}:start-failed`, body: expect.objectContaining({state: 'failed'})}),
      ]);
      expect(f.calls.some(call => call.path.endsWith('/review'))).toBe(false);
    } finally { restoreClock(); }
  });

  it.each(['lease-loss', 'stop'] as const)('aborts attachment preparation on %s before a child can spawn', async cause => {
    const f = await fixture();
    attachToFixture(f);
    const restoreClock = fakeRequestClock();
    const request = f.options.api.request.bind(f.options.api);
    let started!: () => void;
    const transferStarted = new Promise<void>(resolve => { started = resolve; });
    let transferring = false;
    let leaseLost = false;
    f.options.api.request = async <T>(path: string, body: unknown, key?: string, signal?: AbortSignal): Promise<T> => {
      if (path.includes('/attachments/')) {
        transferring = true; started();
        await new Promise<void>((resolve, reject) => {
          setTimeout(resolve, 45_000);
          signal?.addEventListener('abort', () => reject(signal.reason), {once: true});
        });
      }
      if (transferring && cause === 'lease-loss' && path.endsWith('/heartbeat')) {
        leaseLost = true;
        throw new Error('Synthetic lease loss');
      }
      const response = await request<Record<string, any>>(path, body, key, signal);
      if (transferring && cause === 'stop' && path.endsWith('/consume')) response.controls = [{id: controlId, action: 'stop'}];
      return response as T;
    };
    try {
      const spawns = vi.mocked(spawn).mock.calls.length;
      const run = consumeMobileDispatch({...f.options, refreshRunner: async () => ({}), heartbeatIntervalMs: 20_000});
      await transferStarted;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await run).toBe(cause === 'stop' ? 'stopped' : 'failed');
      expect(vi.mocked(spawn).mock.calls).toHaveLength(spawns);
      await expect(lstat(join(f.directory, `${dispatchId}.attachments`))).rejects.toMatchObject({code: 'ENOENT'});
      const calls = f.calls.length;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(f.calls).toHaveLength(calls);
      expect(f.calls.some(call => call.path.endsWith('/review'))).toBe(false);
      if (cause === 'lease-loss') expect(leaseLost).toBe(true);
      if (cause === 'stop') expect(f.calls.at(-1)).toMatchObject({key: `${controlId}:ack`, body: {state: 'acknowledged'}});
    } finally { restoreClock(); }
  });

  it('keeps the preparation control deadline at ten seconds and fences a late renewal', async () => {
    const f = await fixture();
    attachToFixture(f);
    const restoreClock = fakeRequestClock();
    const request = f.options.api.request.bind(f.options.api);
    let started!: () => void;
    const transferStarted = new Promise<void>(resolve => { started = resolve; });
    const refreshRunner = vi.fn(async () => {
      if (refreshRunner.mock.calls.length > 1) await new Promise(resolve => setTimeout(resolve, 80_000));
    });
    f.options.api.request = async <T>(path: string, body: unknown, key?: string, signal?: AbortSignal): Promise<T> => {
      if (path.includes('/attachments/')) {
        started();
        await new Promise<void>((resolve, reject) => {
          setTimeout(resolve, 70_000);
          signal?.addEventListener('abort', () => reject(signal.reason), {once: true});
        });
      }
      return request<T>(path, body, key, signal);
    };
    try {
      const spawns = vi.mocked(spawn).mock.calls.length;
      let finished = false;
      const run = consumeMobileDispatch({...f.options, refreshRunner, heartbeatIntervalMs: 20_000})
        .then(result => { finished = true; return result; });
      await transferStarted;
      await vi.advanceTimersByTimeAsync(29_999);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await run).toBe('failed');
      const calls = f.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.calls).toHaveLength(calls);
      expect(refreshRunner).toHaveBeenCalledTimes(2);
      expect(vi.mocked(spawn).mock.calls).toHaveLength(spawns);
      await expect(lstat(join(f.directory, `${dispatchId}.attachments`))).rejects.toMatchObject({code: 'ENOENT'});
    } finally { restoreClock(); }
  });
  it('cleans verified orphan attachment bytes before refusing an interrupted launch replay', async () => {
    const f = await interruptedAttachmentFixture();
    const spawns = vi.mocked(spawn).mock.calls.length;
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('automatic re-execution is disabled');
    await expect(lstat(f.scratchDirectory)).rejects.toMatchObject({code: 'ENOENT'});
    expect(vi.mocked(spawn).mock.calls).toHaveLength(spawns);
    expect(f.calls.map(call => call.path)).toEqual([`/api/v1/work-items/runners/${runnerId}/consume`]);
    expect(JSON.parse(await readFile(join(f.directory, `${dispatchId}.json`), 'utf8')).state).toBe('launching');
  });

  it.each([
    {state: 'reviewed', exitCode: 0, outcome: 'reviewed', endpoints: ['consume']},
    {state: 'failed', exitCode: 1, outcome: 'failed', endpoints: ['consume']},
    {state: 'finished', exitCode: 0, outcome: 'reviewed', endpoints: ['consume', 'heartbeat', 'review']},
    {state: 'finished', exitCode: 9, outcome: 'failed', endpoints: ['consume', 'heartbeat', 'fail']},
    {state: 'stopped', exitCode: 1, outcome: 'stopped', endpoints: ['consume', 'controls/ack']},
    {state: 'start_failed', exitCode: 1, outcome: 'failed', endpoints: ['consume', 'ack']},
  ])('cleans orphan scratch during $state/$exitCode replay without changing the durable outcome', async ({state, exitCode, outcome, endpoints}) => {
    const f = await interruptedAttachmentFixture();
    Object.assign(f.receipt, {state, exitCode, result: {summary: 'Preserved deliverable', artifactRefs: [{path: 'report.txt'}]},
      ...(state === 'stopped' ? {stopControlId: controlId} : {})});
    await f.save();
    const spawns = vi.mocked(spawn).mock.calls.length;
    expect(await consumeMobileDispatch(f.options)).toBe(outcome);
    await expect(lstat(f.scratchDirectory)).rejects.toMatchObject({code: 'ENOENT'});
    expect(vi.mocked(spawn).mock.calls).toHaveLength(spawns);
    expect(f.calls).toHaveLength(endpoints.length);
    for (const [index, endpoint] of endpoints.entries()) expect(f.calls[index].path.endsWith(`/${endpoint}`)).toBe(true);
    const mutation = f.calls.at(-1)!;
    if (state === 'finished' && exitCode === 0) {
      expect(mutation.key).toBe(`${dispatchId}:review`);
      expect(mutation.body).toMatchObject({resultSummary: 'Preserved deliverable', artifactRefs: [{path: 'report.txt'}, {type: 'worker_run', dispatchId, exitCode}]});
    }
    if (state === 'finished' && exitCode !== 0) expect(mutation.key).toBe(`${dispatchId}:fail`);
    if (state === 'stopped') expect(mutation).toMatchObject({key: `${controlId}:ack`, body: {state: 'acknowledged', controlId}});
    if (state === 'start_failed') expect(mutation).toMatchObject({key: `${dispatchId}:start-failed`, body: {state: 'failed'}});
  });

  it('cleans a confirmed no-spawn failure even when no child PID was recorded', async () => {
    const f = await interruptedAttachmentFixture();
    f.receipt.state = 'start_failed';
    f.receipt.attachmentScratch.phase = 'spawn_pending';
    Reflect.deleteProperty(f.receipt.attachmentScratch, 'childPid');
    await f.save();
    expect(await consumeMobileDispatch(f.options)).toBe('failed');
    await expect(lstat(f.scratchDirectory)).rejects.toMatchObject({code: 'ENOENT'});
    expect(f.calls.at(-1)).toMatchObject({key: `${dispatchId}:start-failed`, body: {state: 'failed'}});
  });

  it('cleans a real killed runner and worker scratch on restart without another execution', async () => {
    const f = await fixture();
    const workerCode = `process.stdin.resume();process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(f.marker)},String(process.pid));setInterval(()=>{},1000);});`;
    const runnerCode = `const {consumeMobileDispatch}=await import(${JSON.stringify(new URL('../../dist/lib/mobile-work-runner.js', import.meta.url).href)});
      await consumeMobileDispatch({runnerId:${JSON.stringify(runnerId)},workspaceId:null,receiptDirectory:${JSON.stringify(f.directory)},cwd:${JSON.stringify(f.directory)},
        executable:process.execPath,args:['-e',${JSON.stringify(workerCode)}],api:{async request(path){
          if(path.endsWith('/consume')) return {dispatch:{id:${JSON.stringify(dispatchId)},workItemId:${JSON.stringify(workItemId)}},
            workItem:{id:${JSON.stringify(workItemId)},claimToken:'synthetic-lease',inputContext:{attachments:[{receiptId:${JSON.stringify(attachmentId)},name:'brief'}]}}};
          if(path.includes('/attachments/')) return ${JSON.stringify(attachmentContent())}; return {};
        }}});`;
    const manager = spawn(process.execPath, ['--input-type=module', '-e', runnerCode], {stdio: 'ignore'});
    const managerClosed = new Promise<void>(resolve => manager.once('close', () => resolve()));
    let childPid: number | undefined;
    try {
      await vi.waitFor(async () => {
        if (manager.exitCode !== null) throw new Error('Synthetic runner exited before worker readiness');
        childPid = Number(await readFile(f.marker, 'utf8'));
        expect(childPid).toBeGreaterThan(0);
      });
      const directory = join(f.directory, `${dispatchId}.attachments`);
      expect(await readFile(join(directory, `0-${attachmentId}`))).toEqual(attachmentBytes);
      manager.kill('SIGKILL');
      await managerClosed;
      // A detached worker can outlive its manager; preserve its inputs while live.
      await expect(consumeMobileDispatch(f.options)).rejects.toThrow('automatic re-execution is disabled');
      expect(await readFile(join(directory, `0-${attachmentId}`))).toEqual(attachmentBytes);
      process.kill(-childPid!, 'SIGKILL');
      await vi.waitFor(() => {
        expect(() => process.kill(childPid!, 0)).toThrow();
        expect(() => process.kill(-childPid!, 0)).toThrow();
      });
      await expect(consumeMobileDispatch(f.options)).rejects.toThrow('automatic re-execution is disabled');
      await expect(lstat(directory)).rejects.toMatchObject({code: 'ENOENT'});
      expect(await readFile(f.marker, 'utf8')).toBe(String(childPid));
      expect(f.calls.every(call => call.path.endsWith('/consume'))).toBe(true);
    } finally {
      manager.kill('SIGKILL');
      await managerClosed;
      if (!childPid) {
        try { childPid = JSON.parse(await readFile(join(f.directory, `${dispatchId}.json`), 'utf8')).attachmentScratch?.childPid; }
        catch { /* The runner may have failed before spawning. */ }
      }
      if (childPid) { try { process.kill(-childPid, 'SIGKILL'); } catch { /* Already gone. */ } }
    }
  });

  it.each(['ownerPid', 'childPid'] as const)('retains attachment bytes when %s is still alive', async field => {
    const f = await interruptedAttachmentFixture();
    f.receipt.attachmentScratch[field] = process.pid;
    await f.save();
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('automatic re-execution is disabled');
    expect(await readFile(f.localPath)).toEqual(attachmentBytes);
  });

  it.each(['spawn_pending', 'unknown'] as const)('retains attachment bytes when spawn evidence is %s', async phase => {
    const f = await interruptedAttachmentFixture();
    f.receipt.attachmentScratch.phase = phase;
    await f.save();
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('automatic re-execution is disabled');
    expect(await readFile(f.localPath)).toEqual(attachmentBytes);
  });

  it.each(['consumerId', 'runnerId', 'workspaceId', 'directoryIno', 'rootIno'] as const)('retains scratch when %s ownership does not match', async field => {
    const f = await interruptedAttachmentFixture();
    Object.assign(f.receipt.attachmentScratch, {[field]: field.endsWith('Ino') ? 1 : attachmentId});
    await f.save();
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('automatic re-execution is disabled');
    expect(await readFile(f.localPath)).toEqual(attachmentBytes);
  });

  it('does not follow a replacement scratch symlink during interrupted cleanup', async () => {
    const f = await interruptedAttachmentFixture();
    const outside = join(f.directory, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, `0-${attachmentId}`), 'retain');
    await rm(f.scratchDirectory, {recursive: true});
    await symlink(outside, f.scratchDirectory);
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('automatic re-execution is disabled');
    expect((await lstat(f.scratchDirectory)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, `0-${attachmentId}`), 'utf8')).toBe('retain');
  });

  it('retains legacy interrupted scratch without process ownership evidence', async () => {
    const f = await interruptedAttachmentFixture();
    Reflect.deleteProperty(f.receipt, 'attachmentScratch');
    await f.save();
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('automatic re-execution is disabled');
    expect(await readFile(f.localPath)).toEqual(attachmentBytes);
  });

  it('cleans an interrupted preparation that durably predates any spawn attempt', async () => {
    const f = await interruptedAttachmentFixture();
    f.receipt.attachmentScratch.phase = 'preparing';
    Reflect.deleteProperty(f.receipt.attachmentScratch, 'childPid');
    await f.save();
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('automatic re-execution is disabled');
    await expect(lstat(f.scratchDirectory)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it.each(['unexpected-file', `0-${otherAttachmentId}`])('retains scratch containing an unowned or symbolic-link entry: %s', async name => {
    const f = await interruptedAttachmentFixture();
    const outside = join(f.directory, 'outside');
    await writeFile(outside, 'retain');
    if (name === 'unexpected-file') await writeFile(join(f.scratchDirectory, name), 'unknown');
    else await symlink(outside, join(f.scratchDirectory, name));
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('automatic re-execution is disabled');
    expect(await readFile(f.localPath)).toEqual(attachmentBytes);
    expect(await readFile(outside, 'utf8')).toBe('retain');
  });

  it('retains scratch if the configured root is replaced by a symlink to a different root', async () => {
    const f = await interruptedAttachmentFixture();
    const replacement = `${f.directory}-replacement`;
    paths.push(replacement);
    await rename(f.directory, replacement);
    await symlink(replacement, f.directory);
    await expect(consumeMobileDispatch(f.options)).rejects.toThrow('automatic re-execution is disabled');
    expect(await readFile(f.localPath.replace(f.directory, replacement))).toEqual(attachmentBytes);
  });
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
    {summary: 'Finished', artifactRefs: [{token: 'synthetic-output-sentinel'}]},
    {summary: 'Finished', artifactRefs: [{credential: 'synthetic-output-sentinel'}]},
    {summary: 'Finished', artifactRefs: [{credentials: 'synthetic-output-sentinel'}]},
    {summary: 'Finished', artifactRefs: [{privateKey: 'synthetic-output-sentinel'}]},
    {summary: 'Finished', artifactRefs: [{private_key: 'synthetic-output-sentinel'}]},
    {summary: '-----BEGIN PRIVATE KEY-----\nsynthetic-output-sentinel\n-----END PRIVATE KEY-----', artifactRefs: []},
    {summary: '-----BEGIN ENCRYPTED PRIVATE KEY-----\nsynthetic-output-sentinel\n-----END ENCRYPTED PRIVATE KEY-----', artifactRefs: []},
    {summary: 'Finished', artifactRefs: [{description: '-----BEGIN RSA PRIVATE KEY-----\nsynthetic-output-sentinel\n-----END RSA PRIVATE KEY-----'}]},
    {summary: 'Finished', artifactRefs: [{'-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-output-sentinel\n-----END OPENSSH PRIVATE KEY-----': 'metadata'}]},
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
    await expect(stat(join(f.directory, `${dispatchId}.result`))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it.each(['finished', 'reviewed'].flatMap(state => [
    {state, unsafeResult: {summary: 'sift_pat_synthetic_receipt_sentinel', artifactRefs: []}},
    {state, unsafeResult: {summary: 'Finished', artifactRefs: [{private_key: 'synthetic_receipt_sentinel'}]}},
    {state, unsafeResult: {summary: '-----BEGIN PRIVATE KEY-----\nsynthetic_receipt_sentinel\n-----END PRIVATE KEY-----', artifactRefs: []}},
  ]))('guards and scrubs secret-bearing legacy $state receipts before any replay', async ({state, unsafeResult}) => {
    const f = await fixture();
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

  it('preserves public PEM and ordinary token metadata in authored results', async () => {
    const f = await fixture();
    const result = {summary: 'Published certificate metadata', artifactRefs: [{
      publicKey: '-----BEGIN PUBLIC KEY-----\nsynthetic-public-fixture\n-----END PUBLIC KEY-----',
      certificate: '-----BEGIN CERTIFICATE-----\nsynthetic-certificate-fixture\n-----END CERTIFICATE-----',
      tokenCount: 123,
    }]};
    f.options.args = ['-e', `process.stdin.resume();process.stdin.on('end',()=>require('fs').writeFileSync(process.env.SIFT_WORK_RESULT_PATH,${JSON.stringify(JSON.stringify(result))}));`];
    expect(await consumeMobileDispatch(f.options)).toBe('reviewed');
    expect(f.calls.find(call => call.path.endsWith('/review'))?.body.artifactRefs).toEqual([
      ...result.artifactRefs, {dispatchId, exitCode: 0, type: 'worker_run'},
    ]);
    expect(JSON.parse(await readFile(join(f.directory, `${dispatchId}.json`), 'utf8')).result).toEqual(result);
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

import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { ProcessJobManager } from '../interactive-tui/processJobs';
import { currentExecutionContext, withExecutionContext, type ToolExecutionContext } from '../interactive-tui/agent-harness/framework/execution-context';
import { runSupervisedShell } from '../interactive-tui/shellExecution';

let root: string;
let jobs: ProcessJobManager;
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const node = (code: string) => `exec ${quote(process.execPath)} -e ${quote(code)}`;
const context = (extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  sessionId: 'owner', turnId: 'turn-1', callId: 'call-1', workspaceRoot: root, sessionCwd: root,
  approval: {policy: 'allow', scopeId: 'scope-1'}, ...extra,
});
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for job state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sift-process-jobs-')));
  jobs = new ProcessJobManager(1024, 30);
});
afterEach(async () => { await jobs.close(); await rm(root, {recursive: true, force: true}); });

test('a real service survives start, independent tool calls and status reads, then stops', async () => {
  const job = await jobs.start(node("require('http').createServer((req,res)=>res.end('alive')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"), root, context());
  await until(() => /\d+/.test(jobs.read(job.jobId, context()).output));
  expect((await runSupervisedShell('printf unrelated', root)).stdout).toBe('unrelated');
  const current = jobs.read(job.jobId, context({turnId: 'turn-2', callId: 'call-2'}));
  expect(current.status).toBe('running');
  const port = Number(current.output.trim());
  const body = await new Promise<string>((resolve, reject) => {
    get(`http://127.0.0.1:${port}`, response => {
      let value = ''; response.on('data', chunk => { value += chunk; }); response.on('end', () => resolve(value));
    }).on('error', reject);
  });
  expect(body).toBe('alive');
  expect(await jobs.stop(job.jobId, context())).toMatchObject({status: 'stopped', terminationConfirmed: true, stopReason: 'requested'});
  expect(await jobs.stop(job.jobId, context())).toMatchObject({terminationConfirmed: true});
});

test('job identity is fenced by session, workspace and authority, not model arguments', async () => {
  const job = await jobs.start('exec sleep 30', root, context());
  for (const other of [context({sessionId: 'other'}), context({workspaceRoot: tmpdir()}), context({approval: {policy: 'allow', scopeId: 'other'}})]) {
    expect(() => jobs.read(job.jobId, other)).toThrow('not owned');
    await expect(jobs.stop(job.jobId, other)).rejects.toThrow('not owned');
    expect(jobs.list(other)).toEqual([]);
  }
  expect(jobs.read(job.jobId, context()).status).toBe('running');
});

test('cwd symlinks cannot escape the authorized workspace', async () => {
  await symlink(tmpdir(), join(root, 'escape'));
  await expect(jobs.start('true', join(root, 'escape'), context())).rejects.toThrow('authorized workspace');
  expect(jobs.list(context())).toEqual([]);
});

test('host cancellation remains connected after the tool execution context ends', async () => {
  const controller = new AbortController();
  const job = await withExecutionContext(context({signal: controller.signal}), async () => {
    return withExecutionContext(currentExecutionContext()!, () => jobs.start('exec sleep 30', root, currentExecutionContext()!));
  });
  expect(jobs.read(job.jobId, context()).status).toBe('running');
  controller.abort();
  await until(() => jobs.read(job.jobId, context()).terminationConfirmed);
  expect(jobs.read(job.jobId, context())).toMatchObject({status: 'stopped', stopReason: 'cancelled'});
});

test('expired or cancelled admission never starts a process', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(jobs.start('exec sleep 30', root, context({signal: controller.signal}))).rejects.toThrow('cancelled');
  await expect(jobs.start('exec sleep 30', root, context({deadline: Date.now() - 1}))).rejects.toThrow('deadline');
  expect(jobs.list(context())).toEqual([]);
});

test('jobs have bounded lifetimes even when no model polls them', async () => {
  const job = await jobs.start('exec sleep 30', root, context(), 40);
  await until(() => jobs.read(job.jobId, context()).terminationConfirmed);
  expect(jobs.read(job.jobId, context())).toMatchObject({stopReason: 'expired', status: 'stopped'});
});

test('bounded output exposes eviction and stable incremental byte cursors', async () => {
  const job = await jobs.start(node("process.stdout.write('x'.repeat(5000)); setInterval(()=>{},1000)"), root, context());
  await until(() => jobs.read(job.jobId, context()).totalOutputBytes === 5000);
  const page = jobs.read(job.jobId, context());
  expect(page).toMatchObject({outputStart: 3976, nextOffset: 5000, outputLost: true, more: false});
  expect(Buffer.byteLength(page.output)).toBe(1024);
  expect(jobs.read(job.jobId, context(), page.nextOffset).output).toBe('');
  expect(() => jobs.read(job.jobId, context(), 5001)).toThrow('beyond');
});

test('a naturally exiting command retains its observed exit code and output', async () => {
  const job = await jobs.start('printf failure; exit 7', root, context());
  await until(() => jobs.read(job.jobId, context()).terminationConfirmed);
  expect(jobs.read(job.jobId, context())).toMatchObject({status: 'exited', exitCode: 7, output: 'failure'});
});

test('shutdown kills a service that ignores TERM and refuses further starts', async () => {
  const job = await jobs.start(node("process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"), root, context());
  await until(() => jobs.read(job.jobId, context()).output.includes('ready'));
  await jobs.close();
  expect(jobs.read(job.jobId, context())).toMatchObject({status: 'stopped', signal: 'SIGKILL', terminationConfirmed: true, stopReason: 'shutdown'});
  await expect(jobs.start('true', root, context())).rejects.toThrow('shutting down');
});

test('new managers do not reattach an unknown job identity', async () => {
  expect(() => jobs.read('old-pid-or-id', context())).toThrow('cannot be recovered');
});

test('an unconfirmed stop retains supervision, capacity and identity until cleanup succeeds', async () => {
  const exitListeners = process.listenerCount('exit');
  const job = await jobs.start('exec sleep 30', root, context());
  const kill = process.kill.bind(process);
  const blockedSignals = jest.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
    if (pid < 0 && signal !== 0) return true; // Simulate signals accepted without termination.
    return kill(pid, signal);
  }) as typeof process.kill);
  try {
    expect(await jobs.stop(job.jobId, context())).toMatchObject({status: 'unknown', terminationConfirmed: false});
    expect(process.listenerCount('exit')).toBe(exitListeners + 1);
    for (let index = 0; index < 7; index++) await jobs.start('exec sleep 30', root, context());
    await expect(jobs.start('true', root, context())).rejects.toThrow('eight active jobs');
    // Exercise retention eviction: uncertainty is never a terminal record.
    const other = context({sessionId: 'other'});
    for (let index = 0; index < 65; index++) {
      const finished = await jobs.start('true', root, other);
      await until(() => jobs.read(finished.jobId, other).terminationConfirmed);
    }
    expect(jobs.read(job.jobId, context()).status).toBe('unknown');
    await expect(jobs.close()).rejects.toThrow('could not be confirmed');
    expect(process.listenerCount('exit')).toBe(exitListeners + 1);
  } finally { blockedSignals.mockRestore(); }
  await jobs.close();
  expect(jobs.read(job.jobId, context()).terminationConfirmed).toBe(true);
  expect(process.listenerCount('exit')).toBe(exitListeners);
}, 15_000);

test('session cancellation drains older-turn jobs while leaving other sessions running', async () => {
  const older = await jobs.start(node("process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"), root, context({turnId: 'old'}));
  const other = context({sessionId: 'other'});
  const unrelated = await jobs.start('exec sleep 30', root, other);
  await until(() => jobs.read(older.jobId, context()).output.includes('ready'));
  await jobs.stopSession('owner');
  expect(jobs.read(older.jobId, context())).toMatchObject({status: 'stopped', terminationConfirmed: true, signal: 'SIGKILL'});
  expect(jobs.read(unrelated.jobId, other).status).toBe('running');
});

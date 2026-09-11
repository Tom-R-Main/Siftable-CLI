import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetBrainAgentsForTests, agentHarnessAsk, closeBrain, getAgent, setBrainModel } from '../interactive-tui/brain';
import { ProcessJobManager } from '../interactive-tui/processJobs';
import * as fsEngine from '../interactive-tui/fsEngine';
import { createChatAgent } from '../interactive-tui/agent-harness/framework/chat-agent';
import { sessionJournalIdForConversation } from '../interactive-tui/sessionMailbox';
import { rejectAllConfirms, resetBypass, resolveApproval, setConfirmListener } from '../interactive-tui/confirmGate';
import type { ToolExecutionContext } from '../interactive-tui/agent-harness/framework/execution-context';

type Tool = { name: string; handler: (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<any> };
let root: string;
let tools: Record<string, Tool>;
let savedRoot: string | undefined;
let savedCwd: string | undefined;
beforeEach(async () => {
  savedRoot = process.env.SIFT_WORKSPACE_ROOT; savedCwd = process.env.SIFT_USER_CWD;
  root = await realpath(await mkdtemp(join(tmpdir(), 'sift-execution-')));
  process.env.SIFT_WORKSPACE_ROOT = root; process.env.SIFT_USER_CWD = root;
  const createChatAgent = jest.fn(async () => ({ chat: async function* () {} }));
  (globalThis as any).__SIFT_AGENT_HARNESS__ = {
    createChatAgent, defineTool: (tool: Tool) => tool,
    ok: (data: unknown) => ({ success: true, data }), err: (error: string) => ({ success: false, error }),
  };
  __resetBrainAgentsForTests(); await getAgent();
  tools = Object.fromEntries(((createChatAgent.mock.calls as any)[0][0].tools as Tool[]).map((tool) => [tool.name, tool]));
});
afterEach(async () => {
  await closeBrain();
  rejectAllConfirms(); resetBypass(); setConfirmListener(null); __resetBrainAgentsForTests();
  delete (globalThis as any).__SIFT_AGENT_HARNESS__;
  if (savedRoot === undefined) delete process.env.SIFT_WORKSPACE_ROOT; else process.env.SIFT_WORKSPACE_ROOT = savedRoot;
  if (savedCwd === undefined) delete process.env.SIFT_USER_CWD; else process.env.SIFT_USER_CWD = savedCwd;
  await rm(root, { recursive: true, force: true });
});
const context = (root: string, signal?: AbortSignal): ToolExecutionContext => ({ sessionId: 'session', turnId: 'turn', callId: 'call', sessionCwd: root, workspaceRoot: root, signal });

test('workspace change during approval refuses dispatch into either workspace', async () => {
  setConfirmListener((request) => { process.env.SIFT_WORKSPACE_ROOT = tmpdir(); resolveApproval(request.id, 'allow'); });
  const result = await tools.write_file.handler({ path: 'new.txt', content: 'new' }, context(root));
  expect(result).toMatchObject({ success: false });
  expect(result.error).toContain('changed after dispatch');
  await expect(readFile(join(root, 'new.txt'))).rejects.toThrow();
});

test('background jobs require approval and cannot dispatch after navigation changes', async () => {
  setConfirmListener(request => resolveApproval(request.id, 'deny'));
  const refused = await tools.start_process_job.handler({command: 'exec sleep 30'}, context(root));
  expect(refused).toMatchObject({success: false});
  expect((await tools.list_process_jobs.handler({}, context(root))).data).toEqual([]);
  setConfirmListener(request => { process.env.SIFT_WORKSPACE_ROOT = tmpdir(); resolveApproval(request.id, 'allow'); });
  const changed = await tools.start_process_job.handler({command: 'exec sleep 30'}, context(root));
  expect(changed).toMatchObject({success: false});
  expect(changed.error).toContain('changed after dispatch');
});

test('brain job tools retain ownership across calls and shutdown removes live ownership', async () => {
  setConfirmListener(request => resolveApproval(request.id, 'allow'));
  const start = await tools.start_process_job.handler({command: 'exec sleep 30'}, context(root));
  expect(start).toMatchObject({success: true, data: {status: 'running'}});
  const jobId = start.data.jobId;
  expect(await tools.read_process_job.handler({jobId}, {...context(root), sessionId: 'different'})).toMatchObject({success: false});
  expect(await tools.read_process_job.handler({jobId}, {...context(root), turnId: 'next-turn'})).toMatchObject({success: true, data: {status: 'running'}});
  expect(await tools.stop_process_job.handler({jobId}, context(root))).toMatchObject({success: true, data: {terminationConfirmed: true}});
  const second = await tools.start_process_job.handler({command: 'exec sleep 30'}, context(root));
  expect(second.success).toBe(true);
  await closeBrain();
  expect(await tools.read_process_job.handler({jobId: second.data.jobId}, context(root))).toMatchObject({success: false});
});

test('brain shutdown failure retains the process manager for inspection and retry', async () => {
  setConfirmListener(request => resolveApproval(request.id, 'allow'));
  const started = await tools.start_process_job.handler({command: 'exec sleep 30'}, context(root));
  const failClose = jest.spyOn(ProcessJobManager.prototype, 'close').mockRejectedValueOnce(new Error('simulated unconfirmed cleanup'));
  try {
    await expect(closeBrain()).rejects.toThrow('failed to close');
    expect(await tools.read_process_job.handler({jobId: started.data.jobId}, context(root))).toMatchObject({success: true, data: {status: 'running'}});
  } finally { failClose.mockRestore(); }
  await closeBrain();
  expect(await tools.read_process_job.handler({jobId: started.data.jobId}, context(root))).toMatchObject({success: false});
});

test('interrupted brain settlement waits for an older-turn TERM-ignoring job to stop', async () => {
  setConfirmListener(request => resolveApproval(request.id, 'allow'));
  const owner = {...context(root), sessionId: sessionJournalIdForConversation(root), turnId: 'older-turn'};
  const command = `exec '${process.execPath}' -e 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)'`;
  const started = await tools.start_process_job.handler({command}, owner);
  const jobId = started.data.jobId;
  const deadline = Date.now() + 3000;
  while (!(await tools.read_process_job.handler({jobId}, owner)).data.output.includes('ready')) {
    if (Date.now() > deadline) throw new Error('Job did not become ready');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const controller = new AbortController(); controller.abort();
  const result = await agentHarnessAsk('cancel this session', () => {}, controller.signal);
  expect(result).toMatchObject({status: 'interrupted', jobCleanup: 'confirmed'});
  expect(await tools.read_process_job.handler({jobId}, owner)).toMatchObject({success: true, data: {terminationConfirmed: true, signal: 'SIGKILL'}});
});

test('interrupted result reports unconfirmed job cleanup instead of claiming settlement', async () => {
  const owner = {...context(root), sessionId: sessionJournalIdForConversation(root)};
  setConfirmListener(request => resolveApproval(request.id, 'allow'));
  const started = await tools.start_process_job.handler({command: 'exec sleep 30'}, owner);
  const stop = jest.spyOn(ProcessJobManager.prototype, 'stopSession').mockRejectedValueOnce(new Error('cleanup could not be confirmed'));
  try {
    const controller = new AbortController(); controller.abort();
    expect(await agentHarnessAsk('cancel', () => {}, controller.signal)).toMatchObject({status: 'interrupted', jobCleanup: 'unknown'});
    expect(await tools.read_process_job.handler({jobId: started.data.jobId}, owner)).toMatchObject({success: true, data: {status: 'running'}});
  } finally { stop.mockRestore(); }
});

test('cancellation during approval cannot mutate after a late response', async () => {
  const controller = new AbortController();
  let id = '';
  setConfirmListener((request) => { id = request.id; controller.abort(); });
  const result = await tools.write_file.handler({ path: 'new.txt', content: 'new' }, context(root, controller.signal));
  resolveApproval(id, 'allow');
  expect(result.success).toBe(false);
  await expect(readFile(join(root, 'new.txt'))).rejects.toThrow();
});

test('read paths retain the dispatch workspace when ambient navigation changes', async () => {
  await writeFile(join(root, 'snapshot.txt'), 'snapshot workspace');
  process.env.SIFT_USER_CWD = tmpdir();
  process.env.SIFT_WORKSPACE_ROOT = tmpdir();
  const result = await tools.read_file.handler({ path: 'snapshot.txt' }, context(root));
  expect(result.success).toBe(true);
  expect(JSON.stringify(result.data)).toContain('snapshot workspace');
});

test('an approved failing command returns its known exit and diagnostics for repair', async () => {
  setConfirmListener((request) => resolveApproval(request.id, 'allow'));
  const result = await tools.run_terminal_command.handler({ command: "printf 'test assertion failed'; exit 1" }, context(root));
  expect(result).toMatchObject({ success: false, executionOutcome: 'failed', data: { exitCode: 1, terminationConfirmed: true } });
  expect(result.data.stdout).toBe('test assertion failed');
  expect(result.error).toContain('file effects were not rolled back');
});

test('ambiguous edit is unchanged and model repairs the match in the same turn', async () => {
  const path = join(root, 'CHANGELOG.rst');
  const original = 'Current\nAdded\n~~~~~\n\nPrevious\nAdded\n~~~~~\n';
  await writeFile(path, original);
  setConfirmListener(request => resolveApproval(request.id, 'allow'));
  let requests = 0;
  const agent = await createChatAgent({memory: false, maxToolRounds: 3,
    tools: [tools.edit_file as any],
    executionContext: () => ({workspaceRoot: root, sessionCwd: root}),
    adapter: {name: 'fixture', model: 'fixture', chat: async history => {
      requests += 1;
      if (requests === 1) return {toolCall: {id: 'ambiguous', name: 'edit_file', args: {path, old: 'Added\n~~~~~', new: 'Added\n~~~~~\n- new feature'}}};
      if (requests === 2) {
        expect(await readFile(path, 'utf8')).toBe(original);
        expect(JSON.parse(history.at(-1)!.content as string)).toMatchObject({success: false, executionOutcome: 'failed'});
        return {toolCall: {id: 'specific', name: 'edit_file', args: {path, old: 'Current\nAdded\n~~~~~', new: 'Current\nAdded\n~~~~~\n- new feature'}}};
      }
      return {text: 'Edited the current entry.'};
    }},
  });
  try {
    const result = await agent.chat('Add this feature to the current changelog');
    expect(result).toMatchObject({rounds: 3, run: {status: 'completed'}});
    expect(requests).toBe(3);
    expect(await readFile(path, 'utf8')).toBe(original.replace('Current\nAdded\n~~~~~', 'Current\nAdded\n~~~~~\n- new feature'));
    const events = agent.getSessionEvents();
    expect(events.filter(event => event.type === 'turn/started')).toHaveLength(1);
    expect(events.filter(event => event.type === 'tool/result').map(event => event.data.outcome)).toEqual(['failed', 'succeeded']);
  } finally {await agent.close();}
});

test('edit errors with ambiguous-match prose do not assert no effects', async () => {
  const path = join(root, 'file.txt'); await writeFile(path, 'original');
  setConfirmListener(request => resolveApproval(request.id, 'allow'));
  const edit = jest.spyOn(fsEngine, 'editText').mockImplementationOnce(async () => {
    await writeFile(path, 'already changed');
    throw new Error('edit_file: ambiguous edit: the text to replace appears more than once');
  });
  try {
    expect(await tools.edit_file.handler({path, old: 'original', new: 'new'}, context(root))).toMatchObject({success: false, executionOutcome: 'unknown'});
    expect(await readFile(path, 'utf8')).toBe('already changed');
  } finally {edit.mockRestore();}
});

test('a no-match edit is a typed pre-write rejection: failed, not unknown, and the model may retry (CLI-047)', async () => {
  const path = join(root, 'file.txt'); await writeFile(path, 'original');
  setConfirmListener(request => resolveApproval(request.id, 'allow'));
  const missing = await tools.edit_file.handler({path, old: 'not present anywhere', new: 'new'}, context(root));
  expect(missing).toMatchObject({success: false, executionOutcome: 'failed', data: {mutationState: 'not_applied'}});
  expect(String((missing as {error?: string}).error)).toContain('no match for the text to replace');
  expect(await readFile(path, 'utf8')).toBe('original');
  const absent = await tools.edit_file.handler({path: join(root, 'nope.txt'), old: 'x', new: 'y'}, context(root));
  expect(absent).toMatchObject({success: false, executionOutcome: 'failed', data: {mutationState: 'not_applied'}});
  const outside = await tools.write_file.handler({path: join(root, '..', 'escape.txt'), content: 'x'}, context(root));
  expect(outside).toMatchObject({success: false, executionOutcome: 'failed', data: {mutationState: 'not_applied'}});
});

test('post-write observer errors stay unknown even when typed as an edit rejection', async () => {
  const path = join(root, 'file.txt'); await writeFile(path, 'original');
  setConfirmListener(request => resolveApproval(request.id, 'allow'));
  const observer = jest.spyOn(fsEngine, 'clearWorkspaceFileCache').mockImplementationOnce(() => {throw new fsEngine.AmbiguousEditError();});
  try {
    expect(await tools.edit_file.handler({path, old: 'original', new: 'new'}, context(root))).toMatchObject({success: false, executionOutcome: 'unknown', data: {mutationState: 'applied'}});
    expect(await readFile(path, 'utf8')).toBe('new');
  } finally {observer.mockRestore();}
});

test.each(['write_file', 'edit_file'] as const)('%s preserves applied receipt failure and stops without replay', async toolName => {
  const path = join(root, 'receipt.txt');
  if (toolName === 'edit_file') await writeFile(path, 'foo');
  setConfirmListener(request => resolveApproval(request.id, 'allow'));
  const mutate = jest.spyOn(fsEngine, toolName === 'write_file' ? 'writeText' : 'editText').mockImplementationOnce(async () => {
    await writeFile(path, 'foobar');
    throw new fsEngine.MutationReceiptError('applied', new Error('receipt delivery failed'));
  });
  let requests = 0;
  const agent = await createChatAgent({memory: false, maxToolRounds: 3,
    tools: [tools[toolName] as any],
    executionContext: () => ({workspaceRoot: root, sessionCwd: root}),
    adapter: {name: 'fixture', model: 'fixture', chat: async () => {
      requests += 1;
      return {toolCall: {id: 'mutation', name: toolName, args: toolName === 'write_file'
        ? {path, content: 'foobar'} : {path, old: 'foo', new: 'foobar'}}};
    }},
  });
  try {
    await expect(agent.chat('Update the file')).rejects.toThrow('outcomes are unknown');
    expect(requests).toBe(1);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(await readFile(path, 'utf8')).toBe('foobar');
    expect(agent.getSessionEvents().filter(event => event.type === 'tool/result')).toEqual([
      expect.objectContaining({data: expect.objectContaining({outcome: 'unknown', result: expect.objectContaining({data: {mutationState: 'applied'}})})}),
    ]);
  } finally {mutate.mockRestore(); await agent.close();}
});

test('whole-file overwrite refuses a version changed since the model read it', async () => {
  const path = join(root, 'file.txt');
  await writeFile(path, 'original');
  expect((await tools.read_file.handler({ path }, context(root))).success).toBe(true);
  await writeFile(path, 'concurrent editor');
  setConfirmListener((request) => resolveApproval(request.id, 'allow'));
  const result = await tools.write_file.handler({ path, content: 'model edit' }, context(root));
  expect(result.success).toBe(false);
  expect(await readFile(path, 'utf8')).toBe('concurrent editor');
});

test('a file changed during approval is preserved', async () => {
  const path = join(root, 'file.txt');
  await writeFile(path, 'original');
  await tools.read_file.handler({ path }, context(root));
  setConfirmListener((request) => { void writeFile(path, 'concurrent').then(() => resolveApproval(request.id, 'allow')); });
  const result = await tools.write_file.handler({ path, content: 'model edit' }, context(root));
  expect(result.success).toBe(false);
  expect(result.error).toContain('File changed');
  expect(await readFile(path, 'utf8')).toBe('concurrent');
});

test('shutdown drains agents retired by a model switch before releasing ownership', async () => {
  const agent = await getAgent();
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  agent.close = jest.fn(() => { began(); return new Promise<void>((resolve) => { release = resolve; }); });
  setBrainModel({ model: 'replacement-fixture' });
  let closed = false;
  const shutdown = closeBrain().then(() => { closed = true; });
  await started;
  expect(closed).toBe(false);
  release();
  await shutdown;
  expect(closed).toBe(true);
});


test.each(['capped', 'invalid-root'] as const)('search repairs %s feedback in the same turn', async failure => {
  await writeFile(join(root, 'a.txt'), 'unrelated');
  await mkdir(join(root, 'z'));
  await writeFile(join(root, 'z', 'target.ts'), 'const NEEDLE = true;');
  let requests = 0;
  const agent = await createChatAgent({
    memory: false, tools: [tools.search_local_files as any],
    executionContext: () => ({workspaceRoot: root, sessionCwd: root}),
    adapter: {name: 'fixture', model: 'fixture', chat: async history => {
      requests += 1;
      if (requests === 1) return {toolCall: {id: 'initial', name: 'search_local_files', args: {
        root: failure === 'capped' ? root : join(root, 'a.txt'), query: 'NEEDLE', maxFiles: 1,
      }}};
      const receipt = JSON.parse(history.at(-1)!.content as string);
      if (requests === 2) {
        expect(receipt.data.stats.scan.status).toBe(failure === 'capped' ? 'partial' : 'failed');
        expect(receipt.message).toContain(failure === 'capped' ? 'Search incomplete' : 'Search failed');
        expect(receipt.message).not.toContain('Search complete within');
        return {toolCall: {id: 'narrowed', name: 'search_local_files', args: {root: join(root, 'z'), query: 'NEEDLE'}}};
      }
      expect(receipt.data.stats.scan.status).toBe('complete');
      expect(receipt.data.matches).toHaveLength(1);
      expect(receipt.data.matches[0].path).toBe('target.ts');
      return {text: 'Found NEEDLE in z/target.ts.'};
    }},
  });
  try {
    expect(await agent.chat('Find NEEDLE')).toMatchObject({rounds: 3, run: {status: 'completed'}});
    expect(requests).toBe(3);
    expect(agent.getSessionEvents().filter(event => event.type === 'turn/started')).toHaveLength(1);
  } finally {await agent.close();}
});

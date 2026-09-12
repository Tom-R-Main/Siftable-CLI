import { ToolRegistry } from '../interactive-tui/agent-harness/framework/registry';
import { currentExecutionContext, withExecutionContext, type ToolExecutionContext } from '../interactive-tui/agent-harness/framework/execution-context';
import { runSupervisedShell, shellEnvironment } from '../interactive-tui/shellExecution';
import { requestConfirm, resolveApproval, resetBypass, rejectAllConfirms, setConfirmListener } from '../interactive-tui/confirmGate';

// runSupervisedShell returns before spawning on win32, so the POSIX deadline
// escalation paths cannot be observed there.
const posixTest = process.platform === 'win32' ? test.skip : test;

const context = (overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  sessionId: 'session-A', turnId: 'turn-A', callId: 'call-A', workspaceRoot: process.cwd(), sessionCwd: process.cwd(), ...overrides,
});

afterEach(() => { rejectAllConfirms(); resetBypass(); setConfirmListener(null); });

test('registry fences a cancelled call before admission and supplies trusted immutable context', async () => {
  const registry = new ToolRegistry();
  const handler = jest.fn(async (_params, ctx) => {
    expect(currentExecutionContext()).toBe(ctx);
    expect(Object.isFrozen(ctx)).toBe(true);
    return { success: true };
  });
  registry.register({ name: 'test', description: '', inputSchema: { type: 'object', properties: {} }, handler });
  const controller = new AbortController(); controller.abort();
  expect(await registry.execute('test', {}, context({ signal: controller.signal }))).toMatchObject({ success: false, executionOutcome: 'failed' });
  expect(handler).not.toHaveBeenCalled();
  expect(await registry.execute('test', {}, context())).toMatchObject({ success: true });
  expect(handler.mock.calls[0][1].callId).toBe('call-A');
});

test('parallel invocations cannot retarget one another through ambient context', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'scope', description: '', inputSchema: { type: 'object', properties: {} },
    handler: async (_params, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, ctx?.callId === 'first' ? 10 : 1));
      return { success: true, data: { callId: currentExecutionContext()?.callId, cwd: currentExecutionContext()?.sessionCwd } };
    },
  });
  const results = await Promise.all([
    registry.execute('scope', {}, context({ callId: 'first', sessionCwd: '/first' })),
    registry.execute('scope', {}, context({ callId: 'second', sessionCwd: '/second' })),
  ]);
  expect(results.map((result) => result.data)).toEqual([{ callId: 'first', cwd: '/first' }, { callId: 'second', cwd: '/second' }]);
  expect(currentExecutionContext()).toBeUndefined();
});

test('expired registry deadline denies admission and context is cleaned after handler throw', async () => {
  const registry = new ToolRegistry();
  const handler = jest.fn(async () => { throw new Error('possible effect'); });
  registry.register({ name: 'effect', description: '', inputSchema: { type: 'object', properties: {} }, handler });
  expect(await registry.execute('effect', {}, context({ deadline: Date.now() - 1 }))).toMatchObject({ executionOutcome: 'failed' });
  expect(handler).not.toHaveBeenCalled();
  expect(await registry.execute('effect', {}, context())).toMatchObject({ executionOutcome: 'unknown' });
  expect(currentExecutionContext()).toBeUndefined();
});

test('cancels pending approval and ignores late scope-wide approval', async () => {
  const controller = new AbortController();
  let id = '';
  setConfirmListener((request) => { id = request.id; });
  const pending = withExecutionContext(context({ signal: controller.signal }), () => requestConfirm({ kind: 'command', path: 'echo test', detail: '' }));
  controller.abort();
  expect(await pending).toBe(false);
  resolveApproval(id, 'bypass');
  setConfirmListener(null);
  expect(await withExecutionContext(context(), () => requestConfirm({ kind: 'command', path: 'echo test', detail: '' }))).toBe(false);
});

test('deadline cancels approval and bypass permission does not leak into another session', async () => {
  setConfirmListener(() => {});
  expect(await withExecutionContext(context({ deadline: Date.now() + 20 }), () => requestConfirm({ kind: 'write', path: '/unused', detail: '' }))).toBe(false);
  setConfirmListener((request) => resolveApproval(request.id, 'bypass'));
  expect(await withExecutionContext(context(), () => requestConfirm({ kind: 'write', path: '/unused', detail: '' }))).toBe(true);
  setConfirmListener(null);
  expect(await withExecutionContext(context({ sessionId: 'session-B' }), () => requestConfirm({ kind: 'write', path: '/unused', detail: '' }))).toBe(false);
});

test('shell excludes ambient credentials and shell startup injection', () => {
  expect(shellEnvironment({ PATH: '/bin', HOME: '/home/test', OPENROUTER_API_KEY: 'opaque', SIFT_PAT: 'opaque', AWS_SECRET_ACCESS_KEY: 'opaque', BASH_ENV: '/startup', NODE_OPTIONS: '--require /hook' })).toEqual({ PATH: '/bin', HOME: '/home/test' });
});

test('shell preserves a known nonzero exit and bounded output for the repair loop', async () => {
  const result = await runSupervisedShell("printf 'abcdefghijklmnop'; exit 3", process.cwd(), { maxOutputBytes: 8 });
  expect(result).toMatchObject({ started: true, exitCode: 3, executionOutcome: 'failed', outputTruncated: true, stdout: 'abcdefgh', terminationConfirmed: true });
});

test('shell cancellation before admission creates no child', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runSupervisedShell('exit 0', process.cwd(), { context: context({ signal: controller.signal }) });
  expect(result).toMatchObject({ started: false, cancelled: true, executionOutcome: 'failed' });
});

test('shell interrupts a running process group including its child', async () => {
  const controller = new AbortController();
  let childPid = 0;
  const result = await runSupervisedShell('sleep 30 & echo $!; wait', process.cwd(), {
    context: context({ signal: controller.signal, onOutput: ({ text }) => { childPid = Number(text.trim()); controller.abort(); } }),
    killGraceMs: 50,
  });
  expect(childPid).toBeGreaterThan(0);
  expect(result).toMatchObject({ started: true, cancelled: true, executionOutcome: 'unknown', terminationConfirmed: true });
  expect(() => process.kill(childPid, 0)).toThrow();
});

posixTest('shell deadline escalates when TERM is ignored; a confirmed-dead timeout is a known failure (CLI-048)', async () => {
  const result = await runSupervisedShell("trap '' TERM; while :; do :; done", process.cwd(), { timeoutMs: 40, killGraceMs: 30 });
  expect(result).toMatchObject({ timedOut: true, started: true, executionOutcome: 'failed', terminationConfirmed: true, signal: 'SIGKILL' });
});

posixTest('a timed-out command keeps its partial output and only unconfirmed termination stays unknown', async () => {
  const result = await runSupervisedShell('echo partial; sleep 30', process.cwd(), { timeoutMs: 100, killGraceMs: 30 });
  expect(result).toMatchObject({ timedOut: true, cancelled: false, executionOutcome: 'failed', terminationConfirmed: true });
  expect(result.output).toContain('partial');
});

test('shell does not report clean completion while a background descendant survives', async () => {
  const result = await runSupervisedShell('sleep 30 >/dev/null 2>&1 & echo $!; exit 0', process.cwd(), { killGraceMs: 30 });
  const pid = Number(result.stdout.trim());
  expect(pid).toBeGreaterThan(0);
  expect(result).toMatchObject({ exitCode: 0, executionOutcome: 'unknown', terminationConfirmed: true });
  expect(() => process.kill(pid, 0)).toThrow();
});

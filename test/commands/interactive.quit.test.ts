import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createConfirmedQuit} from '../../interactive-tui/confirmedQuit';
import {ProcessJobManager} from '../../interactive-tui/processJobs';

describe('confirmed TUI quit', () => {
  it('keeps the renderer alive until shutdown settles and coalesces concurrent quit requests', async () => {
    let release!: () => void;
    const settled = new Promise<void>(resolve => {release = resolve;});
    const close = jest.fn(() => settled), destroy = jest.fn();
    const quit = createConfirmedQuit(close, destroy);
    const first = quit(), second = quit();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1); expect(destroy).not.toHaveBeenCalled();
    release(); await first;
    expect(destroy).toHaveBeenCalledTimes(1);
    await quit(); expect(close).toHaveBeenCalledTimes(1); expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('retains the renderer after uncertain cleanup and permits an explicit retry', async () => {
    const close = jest.fn().mockRejectedValueOnce(new Error('termination unconfirmed')).mockResolvedValueOnce(undefined);
    const destroy = jest.fn(), quit = createConfirmedQuit(close, destroy);
    await expect(quit()).rejects.toThrow('termination unconfirmed');
    expect(destroy).not.toHaveBeenCalled();
    await quit(); expect(close).toHaveBeenCalledTimes(2); expect(destroy).toHaveBeenCalledTimes(1);
  });

  (process.platform === 'win32' ? it.skip : it)('drains a real idle session job before destroying the UI', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sift-quit-job-')));
    const manager = new ProcessJobManager(4096, 50);
    const context = {sessionId: 'idle-session', turnId: 'completed-turn', callId: 'job', workspaceRoot: root, sessionCwd: root};
    try {
      const job = await manager.start('exec sleep 60', root, context, 60000);
      expect(manager.read(job.jobId, context).terminationConfirmed).toBe(false);
      let destroyed = false;
      await createConfirmedQuit(() => manager.close(), () => {
        const terminal = manager.read(job.jobId, context);
        expect(terminal.terminationConfirmed).toBe(true);
        expect(terminal.status).toBe('stopped');
        expect(terminal.stopReason).toBe('shutdown');
        destroyed = true;
      })();
      expect(destroyed).toBe(true);
    } finally {await manager.close(); await rm(root, {recursive: true, force: true});}
  });
});

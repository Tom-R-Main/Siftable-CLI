import {Flags} from '@oclif/core';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {BaseCommand} from '../../lib/base-command.js';
import {consumeMobileDispatch} from '../../lib/mobile-work-runner.js';
import {resolveWorkspaceTenantId} from '../../lib/workspace-context.js';

export default class WorkerListen extends BaseCommand {
  static description = 'Receive reviewed mobile launches on a host-configured local worker';
  static flags = {
    ...BaseCommand.baseFlags,
    runner: Flags.string({description: 'Stable runner UUID', required: true}),
    name: Flags.string({description: 'Runner name shown on the phone', required: true}),
    'agent-alias-id': Flags.string({description: 'Agent alias UUID for this runner; defaults to the credential binding'}),
    executable: Flags.string({description: 'Host-approved executable; receives work JSON on stdin', required: true}),
    arg: Flags.string({description: 'Fixed executable argument (repeatable)', multiple: true, default: []}),
    cwd: Flags.string({description: 'Host-approved working directory', required: true}),
    receipts: Flags.string({description: 'Durable local receipt directory', required: true}),
    'checkpoint-executable': Flags.string({description: 'Optional host-approved checkpoint executable'}),
    'checkpoint-arg': Flags.string({description: 'Fixed checkpoint argument (repeatable)', multiple: true, default: []}),
    once: Flags.boolean({description: 'Register and poll once, then exit', default: false}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(WorkerListen);
    const workspaceId = resolveWorkspaceTenantId(flags.workspace) ?? null;
    const api = {request: <T>(path: string, body: unknown, key?: string, signal?: AbortSignal) =>
      this.apiRequest<T>(flags, path, {method: 'POST', body, idempotencyKey: key, signal})};
    const refreshRunner = (signal?: AbortSignal) => api.request('/api/v1/work-items/runners/heartbeat', {
        workspaceId, runnerId: flags.runner, displayName: flags.name, assignedAliasId: flags['agent-alias-id'],
      }, undefined, signal);
    do {
      await refreshRunner();
      const state = await consumeMobileDispatch({
        api, runnerId: flags.runner, workspaceId,
        executable: flags.executable, args: flags.arg, cwd: resolve(flags.cwd),
        receiptDirectory: resolve(flags.receipts),
        refreshRunner,
        checkpoint: flags['checkpoint-executable'] ? (workItem, signal) => new Promise<void>((resolveCheckpoint, rejectCheckpoint) => {
          signal.throwIfAborted();
          const child = spawn(flags['checkpoint-executable']!, flags['checkpoint-arg'], {
            cwd: resolve(flags.cwd), shell: false, stdio: 'ignore', detached: true,
            env: {PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, SIFT_WORK_ITEM_ID: String(workItem.id)},
          });
          const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
          const timeout = setTimeout(stop, 8000);
          signal.addEventListener('abort', stop, {once: true});
          child.once('error', () => rejectCheckpoint(new Error('Host checkpoint failed.')));
          child.once('close', code => {
            clearTimeout(timeout); signal.removeEventListener('abort', stop); stop();
            return code === 0 && !signal.aborted ? resolveCheckpoint() : rejectCheckpoint(new Error('Host checkpoint failed.'));
          });
        }) : undefined,
      });
      if (flags.once) return {state};
      await delay(5_000);
    } while (true);
  }
}

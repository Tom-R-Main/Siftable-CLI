import {Flags} from '@oclif/core';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {BaseCommand} from '../../lib/base-command.js';
import {consumeMobileDispatch, withMobileRunnerRequestTimeout} from '../../lib/mobile-work-runner.js';
import {listenForMobileWork} from '../../lib/mobile-work-listener.js';
import {resolveWorkspaceTenantId} from '../../lib/workspace-context.js';

/** The checkpoint executable's whole environment. SIFT_CONTROL_ID is the
 * control's durable ID: a redelivered control carries the same one, so an
 * idempotent executable (the agent runtime's checkpoint bridge) can replay
 * instead of checkpointing twice. */
export function checkpointEnvironment(workItem: Record<string, unknown>, controlId: string): NodeJS.ProcessEnv {
  return {PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    SIFT_WORK_ITEM_ID: String(workItem.id), SIFT_CONTROL_ID: controlId};
}

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
    const api = withMobileRunnerRequestTimeout({request: <T>(path: string, body: unknown, key?: string, signal?: AbortSignal) =>
      this.apiRequest<T>(flags, path, {method: 'POST', body, idempotencyKey: key, signal})});
    const refreshRunner = (signal?: AbortSignal) => api.request('/api/v1/work-items/runners/heartbeat', {
        workspaceId, runnerId: flags.runner, displayName: flags.name, assignedAliasId: flags['agent-alias-id'],
      }, undefined, signal);
    return listenForMobileWork({
      once: flags.once,
      onRetry: delayMs => this.warn(`Runner connection interrupted; retrying in ${delayMs / 1000}s.`),
      poll: async () => {
        await refreshRunner();
        const state = await consumeMobileDispatch({
          api, runnerId: flags.runner, workspaceId,
          executable: flags.executable, args: flags.arg, cwd: resolve(flags.cwd),
          receiptDirectory: resolve(flags.receipts),
          refreshRunner,
          checkpoint: flags['checkpoint-executable'] ? (workItem, signal, controlId) => new Promise<void>((resolveCheckpoint, rejectCheckpoint) => {
            signal.throwIfAborted();
            const child = spawn(flags['checkpoint-executable']!, flags['checkpoint-arg'], {
              cwd: resolve(flags.cwd), shell: false, stdio: 'ignore', detached: true,
              env: checkpointEnvironment(workItem, controlId),
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
        return {state};
      },
    });
  }
}

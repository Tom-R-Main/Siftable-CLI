import {Flags} from '@oclif/core';
import {promises as fs} from 'node:fs';
import {BaseCommand} from '../../lib/base-command.js';
import {AttemptFsError, ensureAttemptRoot, hostAttemptFsSystem} from '../../lib/supervisor/attemptFilesystem.js';
import {hostIPv4Addresses} from '../../lib/supervisor/containerSandbox.js';
import {createHostDocker, hostAttach} from '../../lib/supervisor/hostDocker.js';
import {acquireStateLock, MachineStateError, SUPERVISOR_STATE_DIR} from '../../lib/supervisor/machineState.js';
import {systemClock} from '../../lib/supervisor/superviseAuthority.js';
import {type AttemptPlan, superviseOnce, SuperviseError, type SuperviseOutcome, supervisorAssets} from '../../lib/supervisor/superviseLoop.js';
import {INPUT_ROOT} from '../../lib/supervisor/supervisorService.js';
import {ensureSupervisorAccount} from '../../lib/supervisor/systemAccount.js';

const IDLE_MS = 15_000;
/** Each attempt's preallocated filesystem image and its mount point live here, root-only (U5b-2c). */
const ATTEMPT_ROOT = '/var/lib/siftable/attempts';
const BLOCKED_MS = 60_000;

/** A fixture plan file until setup launches record the plan on the work item (U6). */
async function readPlanFile(file: string): Promise<AttemptPlan> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new SuperviseError(`${file} must be a regular file owned by root and not writable by others.`);
  const plan = JSON.parse(await fs.readFile(file, 'utf8')) as AttemptPlan;
  if (typeof plan.repositoryId !== 'string' || typeof plan.branch !== 'string' || !/^[0-9a-f]{40}$/.test(String(plan.baseSha))
    || typeof plan.imageRef !== 'string' || !Array.isArray(plan.command) || !plan.command.every((part) => typeof part === 'string')) {
    throw new SuperviseError(`${file} is not a plan: repositoryId, branch, baseSha (40 hex), imageRef and command are required.`);
  }
  return plan;
}

function describe(outcome: SuperviseOutcome): string {
  switch (outcome.kind) {
    case 'idle': return 'No work for this machine.';
    case 'held': return `Holding resources that could not be shown gone: ${outcome.held.join(', ')}. No new work starts until they are.`
      + (outcome.held.some((item) => item.startsWith('create:'))
        ? ' A create never answered; once Docker shows no such resource, run `sudo sift machine supervise --once --release-unknown-creates`.' : '');
    case 'refused': return `Not starting work: ${outcome.reason}.`
      + (outcome.conflicts?.length ? ` The server refused part of its settlement (${outcome.conflicts.join(', ')}); the record is kept under retired/ for reconciliation.` : '');
    case 'recovered': return outcome.conflicts?.length ? `An attempt left by an earlier run was settled with server conflicts (${outcome.conflicts.join(', ')}); `
      + 'its record is kept under retired/ for reconciliation. It was not relaunched.'
      : outcome.settled ? 'Settled an attempt left by an earlier run; it was not relaunched.'
      : 'An earlier attempt is torn down; telling the server how it ended is still pending. It is never relaunched.';
    case 'finished': return outcome.reason === 'shutdown' ? `Stopped the running attempt for shutdown; cgroup ${outcome.facts.cgroupEmpty}, `
      + `resources ${outcome.facts.resourcesRemoved ? 'removed' : `held: ${outcome.facts.held.join(', ')}`}`
      + `${outcome.conflicts?.length ? `; server conflicts: ${outcome.conflicts.join(', ')}` : ''}.` : `Attempt finished (${outcome.reason}${outcome.exitCode === undefined ? '' : `, exit ${outcome.exitCode}`}); `
      + `cgroup ${outcome.facts.cgroupEmpty}, resources ${outcome.facts.resourcesRemoved ? 'removed' : `held: ${outcome.facts.held.join(', ')}`}`
      + `${outcome.conflicts?.length ? `; server conflicts: ${outcome.conflicts.join(', ')}` : ''}.`;
  }
}

export default class MachineSupervise extends BaseCommand {
  static description = 'Run this machine\'s contained supervisor: claim work, run it in the sandbox, stop and clean up (run as root, normally by systemd)';

  static flags = {
    ...BaseCommand.baseFlags,
    once: Flags.boolean({default: false, description: 'Run at most one attempt, then exit'}),
    'plan-file': Flags.string({description: 'Root-owned JSON plan used for every dispatch (test fixture until setup launches record plans)'}),
    'release-unknown-creates': Flags.boolean({default: false,
      description: 'After checking Docker yourself: treat held creates whose result was never known, and that are not found by name, as never made'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(MachineSupervise);
    if (process.platform !== 'linux') this.error('The supervisor runs on Linux only.');
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) this.error('Run this as root; it reads the supervisor\'s credential and starts containers.');
    const account = await ensureSupervisorAccount();
    // A fresh machine has no /var/lib/siftable: made here, root-only, and checked, before any attempt needs it.
    // Inputs and kept evidence sit beside the attempt images, on storage a restart or reboot does not empty.
    for (const root of [ATTEMPT_ROOT, INPUT_ROOT]) {
      await ensureAttemptRoot(root).catch((error: unknown) => {
        if (error instanceof AttemptFsError) this.error(`The supervisor directory ${root} is not usable: ${error.message}`);
        throw error;
      });
    }
    const state = {root: SUPERVISOR_STATE_DIR, owner: {uid: account.uid, gid: account.gid}};
    // One machine command at a time, for the life of this process: no second supervisor, no qualify alongside.
    let release: () => Promise<void>;
    try {
      release = await acquireStateLock(state, process.pid, 'supervise');
    } catch (error) {
      if (error instanceof MachineStateError) this.error(error.message);
      throw error;
    }
    const shutdown = new AbortController();
    const stop = () => shutdown.abort();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    const pause = (ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      shutdown.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, {once: true});
    });
    const deps = {
      fetch: globalThis.fetch, docker: createHostDocker(), attach: hostAttach, clock: systemClock,
      readFile: (file: string) => fs.readFile(file, 'utf8'),
      hostAddresses: hostIPv4Addresses,
      state, shutdown: shutdown.signal, releaseUnknownCreates: flags['release-unknown-creates'],
      log: (line: string) => process.stderr.write(`${line}\n`),
      assets: supervisorAssets(),
      attemptFs: {system: hostAttemptFsSystem, root: ATTEMPT_ROOT},
      inputRoot: INPUT_ROOT,
      resolvePlan: async () => (flags['plan-file'] ? readPlanFile(flags['plan-file']) : null),
    };
    try {
      for (;;) {
        let outcome: SuperviseOutcome;
        try {
          outcome = await superviseOnce(deps);
        } catch (error) {
          if (error instanceof SuperviseError || error instanceof MachineStateError) this.error(error.message);
          throw error;
        }
        this.log(describe(outcome));
        if (flags.once || shutdown.signal.aborted) return outcome;
        if (outcome.kind === 'idle') await pause(IDLE_MS);
        // Held resources, a refusal, or a server settlement still pending: wait before trying again.
        if (outcome.kind === 'refused' || outcome.kind === 'held' || (outcome.kind !== 'idle' && !outcome.settled)) await pause(BLOCKED_MS);
        if (shutdown.signal.aborted) return outcome;
      }
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      await release();
    }
  }
}

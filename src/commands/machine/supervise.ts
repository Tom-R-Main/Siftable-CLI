import {Flags} from '@oclif/core';
import {promises as fs} from 'node:fs';
import {BaseCommand} from '../../lib/base-command.js';
import {createHostDocker, hostAttach} from '../../lib/supervisor/hostDocker.js';
import {MachineStateError, SUPERVISOR_STATE_DIR} from '../../lib/supervisor/machineState.js';
import {systemClock} from '../../lib/supervisor/superviseAuthority.js';
import {type AttemptPlan, superviseOnce, SuperviseError, type SuperviseOutcome, supervisorAssets} from '../../lib/supervisor/superviseLoop.js';
import {INPUT_ROOT} from '../../lib/supervisor/supervisorService.js';
import {ensureSupervisorAccount} from '../../lib/supervisor/systemAccount.js';

const IDLE_MS = 15_000;
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
    case 'held': return `Holding resources that could not be shown gone: ${outcome.held.join(', ')}. No new work starts until they are.`;
    case 'refused': return `Not starting work: ${outcome.reason}.`;
    case 'recovered': return 'Tore down an attempt left by an earlier run; it was not relaunched.';
    case 'finished': return `Attempt finished (${outcome.reason}${outcome.exitCode === undefined ? '' : `, exit ${outcome.exitCode}`}); `
      + `cgroup ${outcome.facts.cgroupEmpty}, resources ${outcome.facts.resourcesRemoved ? 'removed' : `held: ${outcome.facts.held.join(', ')}`}.`;
  }
}

export default class MachineSupervise extends BaseCommand {
  static description = 'Run this machine\'s contained supervisor: claim work, run it in the sandbox, stop and clean up (run as root, normally by systemd)';

  static flags = {
    ...BaseCommand.baseFlags,
    once: Flags.boolean({default: false, description: 'Run at most one attempt, then exit'}),
    'plan-file': Flags.string({description: 'Root-owned JSON plan used for every dispatch (test fixture until setup launches record plans)'}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(MachineSupervise);
    if (process.platform !== 'linux') this.error('The supervisor runs on Linux only.');
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) this.error('Run this as root; it reads the supervisor\'s credential and starts containers.');
    const account = await ensureSupervisorAccount();
    await fs.mkdir(INPUT_ROOT, {recursive: true, mode: 0o755});
    const deps = {
      fetch: globalThis.fetch, docker: createHostDocker(), attach: hostAttach, clock: systemClock,
      readFile: (file: string) => fs.readFile(file, 'utf8'),
      state: {root: SUPERVISOR_STATE_DIR, owner: {uid: account.uid, gid: account.gid}},
      log: (line: string) => process.stderr.write(`${line}\n`),
      assets: supervisorAssets(),
      inputRoot: INPUT_ROOT,
      resolvePlan: async () => (flags['plan-file'] ? readPlanFile(flags['plan-file']) : null),
    };
    for (;;) {
      let outcome: SuperviseOutcome;
      try {
        outcome = await superviseOnce(deps);
      } catch (error) {
        if (error instanceof SuperviseError || error instanceof MachineStateError) this.error(error.message);
        throw error;
      }
      this.log(describe(outcome));
      if (flags.once) return outcome;
      if (outcome.kind === 'idle' || outcome.kind === 'refused') await new Promise((resolve) => setTimeout(resolve, outcome.kind === 'idle' ? IDLE_MS : BLOCKED_MS));
      if (outcome.kind === 'held') await new Promise((resolve) => setTimeout(resolve, BLOCKED_MS));
    }
  }
}

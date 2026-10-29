/**
 * One supervised attempt (first-run U2d-2; contract
 * `.context/first-run-u2/u2d2-contract.md` revision 2). The order is fixed:
 *
 *   consume → attach attempt (starting) → create containers → pre-start gate
 *   → start held → running inspect, members, owned cgroup → launcher ready
 *   → ack dispatch → report running → open model routes, send go
 *   → renew by returned authority; Stop control, agent exit or cap → stop
 *
 * Every effect is journaled before it happens. A journal left by a crash is
 * torn down by exact IDs and run label and is never relaunched; anything that
 * cannot be shown gone stays held and blocks further work. The claim token is
 * never written to disk: a restart recovers it from consume.
 */
import {randomBytes, randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {attemptSliceName, cgroupSetupProblem, isInsideAttemptSlice, parseCgroupV2, type ReadFile} from './attemptCgroup.js';
import {GO_LINE, READY_LINE} from './attemptLauncher.js';
import {evaluateNetworkInspect, evaluateSandboxInspect, networkCreateArgs, sandboxCreateArgs, type SandboxContainerSpec} from './containerSandbox.js';
import type {DeadlineDocker} from './hostDocker.js';
import {type Attach, type AttachedProcess, ensureImage, readFirstLine} from './machineQualify.js';
import {archiveJournal, inspectMachineState, type MachineRecord, type MachineStateOptions, readCredential, readJournal, removeJournal, writeJournal} from './machineState.js';
import {attemptRelayHandler} from './modelRelayHandler.js';
import {DIAGNOSTIC_PATH, MODEL_PATHS, SIDECAR_PORT} from './relaySidecar.js';
import {serveSidecarFrames} from './sidecarBridge.js';
import {STOP_BUDGET_MS, type StopFacts, stopAttempt} from './stopAttempt.js';
import {heartbeatDeadlineAt, HEARTBEAT_BUDGET_MS, initialCaps, nextRenewalDelay, renewedCap, type SupervisorClock} from './superviseAuthority.js';

export const JOURNAL = 'attempt-journal.json';
const READY_TIMEOUT_MS = 15_000;
const CONTROL_POLL_MS = 5_000;
const ACK_ATTEMPTS = 3;

export interface AttemptPlan {
  repositoryId: string;
  branch: string;
  baseSha: string;
  imageRef: string;
  /** The workload the launcher starts after `go`, exactly as the plan froze it. */
  command: string[];
}

export interface SuperviseDeps {
  fetch: typeof fetch;
  docker: DeadlineDocker;
  attach: Attach;
  clock: SupervisorClock;
  readFile: ReadFile;
  state: MachineStateOptions;
  log: (line: string) => void;
  assets: {sidecar: string; launcher: string};
  /** Root-owned directory for read-only attempt inputs, outside the supervisor's state and any home. */
  inputRoot: string;
  resolvePlan: (workItem: Record<string, unknown>) => Promise<AttemptPlan | null>;
  /** Tests shorten these; production uses the defaults. */
  timing?: {controlPollMs?: number; readyTimeoutMs?: number};
  /** Aborted when the service is stopping: the running attempt is stopped and cleaned up before return. */
  shutdown?: AbortSignal;
}

type JournalState = 'claimed' | 'attached' | 'created' | 'started' | 'acknowledging' | 'running' | 'stopping' | 'held';

export interface AttemptJournal {
  version: 1;
  state: JournalState;
  runId: string;
  dispatchId: string;
  workItemId: string;
  runtimeId: string;
  attemptId?: string;
  networkId?: string;
  containers: {sidecar?: string; agent?: string};
  cgroups?: {sidecar?: string; agent?: string};
  /** The last model call ID handed out; journaled before the call is sent. */
  callSeq: number;
  stop?: {reason: StopReason; controlId?: string; facts?: StopFacts};
}

export type StopReason = 'stop_control' | 'workload_exited' | 'lease_lost' | 'ack_unknown' | 'start_failed' | 'shutdown' | 'recovered';
export type SuperviseOutcome =
  | {kind: 'idle'}
  | {kind: 'held'; held: string[]}
  | {kind: 'refused'; reason: string}
  | {kind: 'recovered'}
  | {kind: 'finished'; reason: StopReason; exitCode?: number; facts: StopFacts};

export class SuperviseError extends Error {}

interface ApiResult {status: number; body: Record<string, unknown>}

/** Machine identity and the authenticated API, read once per attempt. */
interface Session {
  machine: MachineRecord;
  token: string;
  workspaceId: string | null;
  consumerId: string;
  call(method: 'GET' | 'POST', route: string, body?: unknown, options?: {key?: string; timeoutMs?: number}): Promise<ApiResult>;
}

async function openSession(deps: SuperviseDeps): Promise<Session> {
  const state = await inspectMachineState(deps.state);
  if (state.kind !== 'enrolled') throw new SuperviseError('This machine is not enrolled.');
  const token = await readCredential(deps.state);
  if (!token) throw new SuperviseError('The enrollment credential is missing.');
  const {machine} = state;
  const identity = await readJournal<{id: string}>(deps.state, 'consumer-journal.json');
  const consumerId = identity?.id ?? randomUUID();
  if (!identity) await writeJournal(deps.state, 'consumer-journal.json', {id: consumerId});
  return {
    machine, token, consumerId,
    workspaceId: machine.scope.type === 'workspace' ? machine.scope.id : null,
    async call(method, route, body, options = {}) {
      const response = await deps.fetch(`${machine.apiUrl}${route}`, {
        // AbortSignal.timeout takes whole milliseconds; monotonic arithmetic is fractional.
        method, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.floor(options.timeoutMs ?? 30_000))),
        headers: {
          'Authorization': `Bearer ${token}`,
          ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
          ...(options.key ? {'Idempotency-Key': options.key} : {}),
          ...(machine.scope.type === 'workspace' ? {'X-Workspace-Id': machine.scope.id} : {}),
        },
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
      const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
      return {status: response.status, body: parsed};
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

async function mustDocker(deps: SuperviseDeps, args: string[]): Promise<string> {
  const result = await deps.docker(args);
  if (result.code !== 0) throw new SuperviseError(`docker ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim().slice(0, 200) || `exit ${result.code}`}`);
  return result.stdout.trim();
}

/** Everything a crashed or held run left, by exact ID and by its run label, within a deadline. */
async function ownedResources(deps: SuperviseDeps, journal: AttemptJournal, deadlineMono?: number) {
  const label = `label=sift.machine.run=${journal.runId}`;
  const listed = await deps.docker(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', label], {deadlineMono});
  const networks = await deps.docker(['network', 'ls', '--quiet', '--no-trunc', '--filter', label], {deadlineMono});
  const containers = new Set([...Object.values(journal.containers).filter(Boolean) as string[],
    ...(listed.code === 0 ? listed.stdout.split('\n').map((id) => id.trim()).filter(Boolean) : [])]);
  const networkIds = new Set([...(journal.networkId ? [journal.networkId] : []),
    ...(networks.code === 0 ? networks.stdout.split('\n').map((id) => id.trim()).filter(Boolean) : [])]);
  return {containers: [...containers], networkIds: [...networkIds], complete: listed.code === 0 && networks.code === 0};
}

/** Tears down a journal's run; returns what is still held. Never relaunches. */
async function settle(deps: SuperviseDeps, journal: AttemptJournal, reason: StopReason, controlId?: string): Promise<{facts: StopFacts; journal: AttemptJournal}> {
  const stop = {reason, ...(controlId ? {controlId} : {})};
  let current: AttemptJournal = {...journal, state: 'stopping', stop};
  await writeJournal(deps.state, JOURNAL, current);
  let facts: StopFacts;
  if (!current.attemptId) {
    const owned = await ownedResources(deps, current, deps.clock.monoMs() + STOP_BUDGET_MS);
    // No attempt slice was ever bound: nothing was started under it. Remove what was created.
    const held: string[] = owned.complete ? [] : [`run:${current.runId}`];
    for (const id of owned.containers) {
      const removed = await deps.docker(['container', 'rm', '--force', '--volumes', id]);
      if (removed.code !== 0 && !/No such container/i.test(removed.stderr)) held.push(`container:${id}`);
    }
    for (const id of owned.networkIds) {
      const removed = await deps.docker(['network', 'rm', id]);
      if (removed.code !== 0 && !/No such network|not found/i.test(removed.stderr)) held.push(`network:${id}`);
    }
    facts = {processesStopped: owned.containers.length === 0 || held.length === 0, cgroupEmpty: 'empty', resourcesRemoved: held.length === 0, held};
  } else {
    const journaled = current;
    facts = await stopAttempt(deps, {attemptId: current.attemptId,
      containers: Object.values(current.containers).filter((id): id is string => Boolean(id)), networkId: current.networkId},
    (deadlineMono) => ownedResources(deps, journaled, deadlineMono));
  }
  current = {...current, state: facts.held.length > 0 ? 'held' : 'stopping', stop: {...stop, facts}};
  await writeJournal(deps.state, JOURNAL, current);
  return {facts, journal: current};
}

/** Archives a settled journal that holds nothing; a held one stays active and blocks consume. */
async function close(deps: SuperviseDeps, journal: AttemptJournal): Promise<void> {
  if (journal.state === 'held') return;
  await archiveJournal(deps.state, JOURNAL, new Date(deps.clock.wallMs()));
  await removeJournal(deps.state, JOURNAL);
}

function attemptSpecs(deps: SuperviseDeps, journal: AttemptJournal, attemptId: string, plan: AttemptPlan, networkId: string, nonce: string, inputFile: string) {
  const slice = attemptSliceName(attemptId);
  const relayName = `sift-a-${journal.runId}-relay`;
  const labels = (role: string) => ({'sift.machine.run': journal.runId, 'sift.machine.role': role, 'sift.machine.attempt': attemptId});
  const relayBase = `http://${relayName}:${SIDECAR_PORT}`;
  const sidecar: SandboxContainerSpec = {
    name: relayName, imageRef: plan.imageRef, networkId, labels: labels('relay'),
    entrypoint: 'node', command: ['/sift/relaySidecar.js'],
    mounts: [{source: deps.assets.sidecar, target: '/sift/relaySidecar.js'}],
    tmpfs: ['/tmp'], env: {}, limits: {cpus: 0.5, memoryMb: 256, pidsLimit: 64}, cgroupParent: slice, interactive: true,
  };
  const agent: SandboxContainerSpec = {
    name: `sift-a-${journal.runId}-agent`, imageRef: plan.imageRef, networkId, labels: labels('agent'),
    entrypoint: 'node', command: ['/sift/attemptLauncher.js', ...plan.command],
    mounts: [{source: deps.assets.launcher, target: '/sift/attemptLauncher.js'}, {source: inputFile, target: '/sift/input.json'}],
    tmpfs: ['/tmp', '/workspace'],
    env: {
      SIFT_DIAGNOSTIC_URL: `${relayBase}${DIAGNOSTIC_PATH}`, SIFT_DIAGNOSTIC_NONCE: nonce,
      // SDKs append their own paths: Anthropic adds /v1/messages, OpenAI adds /responses to a base ending in /v1.
      ANTHROPIC_BASE_URL: `${relayBase}${MODEL_PATHS.anthropic.replace(/\/v1\/messages$/, '')}`,
      OPENAI_BASE_URL: `${relayBase}${MODEL_PATHS.openai.replace(/\/responses$/, '')}`,
    },
    limits: {cpus: 2, memoryMb: 4096, pidsLimit: 512}, cgroupParent: slice, interactive: true,
  };
  return {sidecar, agent, networkLabels: {'sift.machine.run': journal.runId, 'sift.machine.attempt': attemptId}};
}

/**
 * Runs at most one attempt. Returns `held` without consuming while an earlier
 * attempt's resources could not be shown gone.
 */
export async function superviseOnce(deps: SuperviseDeps): Promise<SuperviseOutcome> {
  const earlier = await readJournal<AttemptJournal>(deps.state, JOURNAL);
  if (earlier) {
    const {facts, journal} = await settle(deps, earlier, earlier.stop?.reason ?? 'recovered', earlier.stop?.controlId);
    if (facts.held.length > 0) return {kind: 'held', held: facts.held};
    await close(deps, journal);
    return {kind: 'recovered'};
  }

  const info = await deps.docker(['info', '--format', '{{json .}}']);
  const setupProblem = info.code === 0 ? cgroupSetupProblem(JSON.parse(info.stdout || '{}') as Record<string, unknown>) : 'docker_unavailable';
  if (setupProblem) return {kind: 'refused', reason: setupProblem};

  const session = await openSession(deps);
  const {machine, workspaceId} = session;
  const sentMono = deps.clock.monoMs();
  const consumed = await session.call('POST', `/api/v1/work-items/runners/${machine.runnerId}/consume`, {workspaceId, consumerId: session.consumerId});
  if (consumed.status === 403) return {kind: 'refused', reason: 'not_admitted'};
  if (consumed.status !== 200) throw new SuperviseError(`consume returned HTTP ${consumed.status}`);
  const dispatch = consumed.body.dispatch as {id?: string; workItemId?: string; computeGrantId?: unknown; computeGrantExpiresAt?: unknown} | null;
  const workItem = consumed.body.workItem as ({id?: string; claimToken?: string; claimExpiresAt?: unknown} & Record<string, unknown>) | null;
  if (!dispatch?.id || !workItem?.id || typeof workItem.claimToken !== 'string') return {kind: 'idle'};
  const claimToken = workItem.claimToken;
  const claimOwner = `mobile-runner:${machine.runnerId}`;
  const {cap: firstCap, grantCap} = initialCaps(deps.clock, {claimExpiresAt: workItem.claimExpiresAt, computeGrantExpiresAt: dispatch.computeGrantExpiresAt}, sentMono);
  let cap = firstCap;

  let journal: AttemptJournal = {
    version: 1, state: 'claimed', runId: randomBytes(6).toString('hex'), dispatchId: dispatch.id, workItemId: workItem.id,
    runtimeId: `machine:${machine.enrollmentId}:${dispatch.id}`, containers: {}, callSeq: 0,
  };
  const save = async (next: AttemptJournal) => { journal = next; await writeJournal(deps.state, JOURNAL, journal); };
  await save(journal);

  // Nothing has been created yet, so a refusal here is a truthful failed start.
  const refuseStart = async (reason: string): Promise<SuperviseOutcome> => {
    await session.call('POST', `/api/v1/work-items/dispatches/${dispatch.id}/ack`, {workspaceId, claimToken, state: 'failed'}, {key: `${dispatch.id}:start-failed`});
    await close(deps, journal);
    return {kind: 'refused', reason};
  };
  // A grant-bound dispatch needs an approved managed launch payload; this supervisor does not fake one.
  if (dispatch.computeGrantId) return refuseStart('compute_grant_dispatch_unsupported');
  const plan = await deps.resolvePlan(workItem);
  if (!plan) return refuseStart('no_plan');

  const report = (state: 'starting' | 'running' | 'interrupted' | 'ended', endReason?: 'lease_lost' | 'terminated' | 'failed') =>
    session.call('POST', `/api/v1/work-items/${workItem.id}/execution-attempts`, {
      runtimeId: journal.runtimeId, leaseGeneration: 1, state, claimOwner, claimToken, dispatchId: dispatch.id,
      workspace: {repositoryId: plan.repositoryId, branch: plan.branch, baseSha: plan.baseSha},
      ...(endReason ? {endReason} : {}),
    }, {key: `${journal.runtimeId}:1:${state}`});

  const attached = await report('starting');
  const attemptId = (attached.body.attempt as {id?: string} | undefined)?.id;
  if (attached.status !== 200 || !attemptId) return refuseStart(`attach_http_${attached.status}`);
  await save({...journal, state: 'attached', attemptId});

  let sidecar: AttachedProcess | undefined;
  let agent: AttachedProcess | undefined;
  let modelsOpen = false;
  const inputDir = path.join(deps.inputRoot, attemptId);
  const finish = async (reason: StopReason, exitCode?: number, controlId?: string): Promise<SuperviseOutcome> => {
    modelsOpen = false;
    agent?.stdin.end();
    const settled = await settle(deps, journal, reason, controlId);
    sidecar?.kill();
    agent?.kill();
    journal = settled.journal;
    await fs.rm(inputDir, {recursive: true, force: true}).catch(() => undefined);
    const live = deps.clock.monoMs() < cap;
    if (live && reason === 'start_failed' && !sidecar && !agent) {
      // Containers were created but never started: a failed start is the truth.
      await session.call('POST', `/api/v1/work-items/dispatches/${dispatch.id}/ack`, {workspaceId, claimToken, state: 'failed'},
        {key: `${dispatch.id}:start-failed`}).catch(() => undefined);
    }
    if (live && reason === 'stop_control' && controlId && settled.facts.cgroupEmpty === 'empty') {
      // Acknowledged only on an observed empty cgroup under a live claim.
      await session.call('POST', `/api/v1/work-items/dispatches/${dispatch.id}/controls/ack`,
        {workspaceId, controlId, claimToken, state: 'acknowledged'}, {key: `${controlId}:ack`});
    }
    if (live) {
      const terminal = reason === 'lease_lost' ? report('interrupted', 'lease_lost')
        : reason === 'shutdown' ? report('interrupted', 'terminated')
        : reason === 'workload_exited' && exitCode === 0 ? report('ended')
          : report('ended', reason === 'stop_control' ? 'terminated' : 'failed');
      await terminal.catch(() => undefined);
    }
    await close(deps, journal);
    return {kind: 'finished', reason, exitCode, facts: settled.facts};
  };

  try {
    const imageId = await ensureImage(deps.docker, plan.imageRef);
    const nonce = randomBytes(16).toString('hex');
    await fs.mkdir(inputDir, {recursive: true, mode: 0o755});
    const inputFile = path.join(inputDir, 'input.json');
    await fs.writeFile(inputFile, JSON.stringify({attemptId, workItemId: workItem.id, title: workItem.title, prompt: workItem.prompt,
      acceptanceCriteria: workItem.acceptanceCriteria, writeScope: workItem.writeScope, plan}), {mode: 0o444});

    const labelsOnly = attemptSpecs(deps, journal, attemptId, plan, '', nonce, inputFile).networkLabels;
    const networkId = await mustDocker(deps, networkCreateArgs(`sift-a-${journal.runId}`, labelsOnly));
    await save({...journal, networkId});
    const specs = attemptSpecs(deps, journal, attemptId, plan, networkId, nonce, inputFile);
    const sidecarId = await mustDocker(deps, sandboxCreateArgs(specs.sidecar));
    await save({...journal, containers: {...journal.containers, sidecar: sidecarId}});
    const agentId = await mustDocker(deps, sandboxCreateArgs(specs.agent));
    await save({...journal, state: 'created', containers: {...journal.containers, agent: agentId}});

    const inspectBoth = async (phase: 'created' | 'running') => {
      const inspected = JSON.parse(await mustDocker(deps, ['container', 'inspect', sidecarId, agentId])) as unknown[];
      const byId = new Map(inspected.map((entry) => [(entry as {Id?: string}).Id, entry]));
      return [
        ...evaluateSandboxInspect(byId.get(sidecarId), {containerId: sidecarId, imageRef: plan.imageRef, imageId, networkId, spec: specs.sidecar, phase}).problems.map((p) => `relay:${p}`),
        ...evaluateSandboxInspect(byId.get(agentId), {containerId: agentId, imageRef: plan.imageRef, imageId, networkId, spec: specs.agent, phase}).problems.map((p) => `agent:${p}`),
      ];
    };
    const created = await inspectBoth('created');
    if (created.length > 0) {
      deps.log(`The sandbox was not created as specified: ${created.join(', ')}`);
      return await finish('start_failed');
    }

    if (deps.shutdown?.aborted) return await finish('shutdown');
    sidecar = deps.attach(['start', '--attach', '--interactive', sidecarId]);
    serveSidecarFrames(sidecar.stdout, sidecar.stdin, attemptRelayHandler({fetch: deps.fetch, diagnosticNonce: nonce}, {
      apiUrl: machine.apiUrl, token: session.token, workspaceId, workItemId: workItem.id, attemptId, claimToken,
    }, {
      open: () => modelsOpen,
      nextCallId: async () => {
        await save({...journal, callSeq: journal.callSeq + 1});
        return `${attemptId}:${journal.callSeq}`;
      },
    }));
    agent = deps.attach(['start', '--attach', '--interactive', agentId]);
    await save({...journal, state: 'started'});

    // Readiness: the launcher reached the relay through the sidecar and saw this run's nonce.
    const ready = await readFirstLine(agent.stdout, deps.timing?.readyTimeoutMs ?? READY_TIMEOUT_MS);
    // Keep the workload's output flowing; U5b collects it as evidence.
    agent.stdout.resume();
    const running = await inspectBoth('running');
    const [network] = JSON.parse(await mustDocker(deps, ['network', 'inspect', networkId])) as unknown[];
    running.push(...evaluateNetworkInspect(network, {networkId, labels: specs.networkLabels, containerIds: [sidecarId, agentId]}));
    const cgroups: Record<string, string | null> = {};
    for (const [role, id] of [['sidecar', sidecarId], ['agent', agentId]] as const) {
      const pid = Number(await mustDocker(deps, ['container', 'inspect', '--format', '{{.State.Pid}}', id]));
      cgroups[role] = Number.isInteger(pid) && pid > 0 ? parseCgroupV2(await deps.readFile(`/proc/${pid}/cgroup`).catch(() => '')) : null;
      if (!isInsideAttemptSlice(cgroups[role], attemptId)) running.push(`${role}:cgroup_membership`);
    }
    await save({...journal, cgroups: {sidecar: cgroups.sidecar ?? undefined, agent: cgroups.agent ?? undefined}});
    if (ready !== READY_LINE) running.push('launcher_not_ready');
    if (running.length > 0) {
      deps.log(`The attempt did not start as specified: ${running.join(', ')}`);
      return await finish('start_failed');
    }

    if (deps.shutdown?.aborted) return await finish('shutdown');
    // Positive acknowledgement before any workload or model call. A lost reply is unknown, never failed.
    await save({...journal, state: 'acknowledging'});
    let acknowledged = false;
    for (let attempt = 0; attempt < ACK_ATTEMPTS && !acknowledged && deps.clock.monoMs() < cap; attempt++) {
      const ack = await session.call('POST', `/api/v1/work-items/dispatches/${dispatch.id}/ack`,
        {workspaceId, claimToken, state: 'acknowledged'}, {key: `${dispatch.id}:ack`}).catch(() => null);
      if (ack?.status === 200) acknowledged = true;
      else if (ack && ack.status >= 400 && ack.status < 500) break;
    }
    if (!acknowledged) return await finish('ack_unknown');
    await save({...journal, state: 'running'});
    await report('running').catch(() => undefined);
    modelsOpen = true;
    agent.stdin.write(`${GO_LINE}\n`);

    const exited = agent.exited.then((code) => ({kind: 'exit' as const, code}));
    const stopping = new Promise<{kind: 'shutdown'}>((resolve) => {
      if (deps.shutdown?.aborted) resolve({kind: 'shutdown'});
      deps.shutdown?.addEventListener('abort', () => resolve({kind: 'shutdown'}), {once: true});
    });
    let renewAt = deps.clock.monoMs() + nextRenewalDelay(cap, deps.clock.monoMs());
    let pollAt = deps.clock.monoMs() + (deps.timing?.controlPollMs ?? CONTROL_POLL_MS);
    for (;;) {
      const now = deps.clock.monoMs();
      if (now >= cap) return await finish('lease_lost');
      const event = await Promise.race([exited, stopping, sleep(Math.min(renewAt, pollAt, cap) - now).then(() => ({kind: 'tick' as const}))]);
      if (event.kind === 'exit') return await finish('workload_exited', event.code);
      if (event.kind === 'shutdown') return await finish('shutdown');
      if (deps.clock.monoMs() >= pollAt) {
        pollAt = deps.clock.monoMs() + (deps.timing?.controlPollMs ?? CONTROL_POLL_MS);
        const scope = workspaceId ?? 'personal';
        const controls = await session.call('GET', `/api/v1/work-items/dispatches/${dispatch.id}/controls?workspaceId=${scope}`, undefined,
          {timeoutMs: Math.max(1, Math.min(10_000, cap - deps.clock.monoMs()))}).catch(() => null);
        const stop = (controls?.body.controls as Array<{id: string; action: string; state: string}> | undefined)
          ?.find((control) => control.action === 'stop' && control.state === 'pending');
        if (stop) return await finish('stop_control', undefined, stop.id);
      }
      if (deps.clock.monoMs() >= renewAt) {
        const sent = deps.clock.monoMs();
        const renewal = await session.call('POST', `/api/v1/work-items/dispatches/${dispatch.id}/heartbeat`, {
          workspaceId, runnerId: machine.runnerId, consumerId: session.consumerId, workItemId: workItem.id,
          claimOwner, claimToken, deadlineAt: heartbeatDeadlineAt(deps.clock),
        }, {timeoutMs: Math.max(1, Math.min(HEARTBEAT_BUDGET_MS, cap - sent))}).catch(() => null);
        if (renewal?.status === 200) {
          cap = renewedCap(deps.clock, (renewal.body.authority as {claimExpiresAt?: unknown} | undefined)?.claimExpiresAt, sent, grantCap);
        } else if (renewal && (renewal.status === 403 || renewal.status === 409)) {
          return await finish('lease_lost');
        }
        // Anything else leaves the confirmed cap where it was.
        renewAt = deps.clock.monoMs() + nextRenewalDelay(cap, deps.clock.monoMs());
      }
    }
  } catch (error) {
    deps.log(`The attempt failed: ${(error as Error).message}`);
    return finish('start_failed');
  }
}

/** The shipped sidecar and launcher programs, beside this module in dist. */
export function supervisorAssets(): SuperviseDeps['assets'] {
  return {sidecar: path.join(__dirname, 'relaySidecar.js'), launcher: path.join(__dirname, 'attemptLauncher.js')};
}

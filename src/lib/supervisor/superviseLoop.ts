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
import {hostname} from 'node:os';
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

type JournalState = 'claimed' | 'attached' | 'created' | 'started' | 'acknowledging' | 'running' | 'stopping' | 'held' | 'settling';

/**
 * What the server still has to be told once resources are gone. Each item is
 * pending until a 200 confirms it; a 409 is a recorded conflict, not success.
 */
export interface Settlement {
  reason: StopReason;
  exitCode?: number;
  controlId?: string;
  /** Whether anything was started; a failed start ack is sent only when nothing was. */
  started: boolean;
  /** Whether the Stop may be acknowledged: the cgroup was observed empty. */
  cgroupEmpty: boolean;
  attemptReport: 'pending' | 'done' | 'conflict' | 'skipped';
  work: 'pending' | 'done' | 'conflict';
}

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
  /** The workspace the attempt was attached with; terminal reports repeat it. */
  workspace?: {repositoryId: string; branch: string; baseSha: string};
  /** The last model call ID handed out; journaled before the call is sent. */
  callSeq: number;
  stop?: {reason: StopReason; controlId?: string; facts?: StopFacts};
  settlement?: Settlement;
}

/** Dispatches this machine has started an attempt for; none is ever executed twice. */
const LEDGER = 'dispatches-journal.json';
const LEDGER_LIMIT = 500;

export type StopReason = 'stop_control' | 'workload_exited' | 'lease_lost' | 'ack_unknown' | 'start_failed' | 'shutdown' | 'recovered';
export type SuperviseOutcome =
  | {kind: 'idle'}
  | {kind: 'held'; held: string[]}
  | {kind: 'refused'; reason: string}
  | {kind: 'recovered'; settled: boolean}
  | {kind: 'finished'; reason: StopReason; exitCode?: number; facts: StopFacts; settled: boolean};

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

const RUNNER_HEARTBEAT_MS = 45_000;

function terminalReport(settlement: Settlement): {state: 'ended' | 'interrupted'; endReason?: 'lease_lost' | 'terminated' | 'failed'} {
  switch (settlement.reason) {
    case 'workload_exited': return settlement.exitCode === 0 ? {state: 'ended'} : {state: 'ended', endReason: 'failed'};
    case 'stop_control': return {state: 'ended', endReason: 'terminated'};
    case 'lease_lost': return {state: 'interrupted', endReason: 'lease_lost'};
    case 'shutdown': return {state: 'interrupted', endReason: 'terminated'};
    default: return {state: 'ended', endReason: 'failed'};
  }
}

const settledStatus = (status: number | undefined): 'done' | 'conflict' | 'pending' => (status === 200 ? 'done' : status === 409 ? 'conflict' : 'pending');

/**
 * Tells the server how the attempt ended, using the dispatch's live claim.
 * Returns the updated settlement; anything not confirmed stays pending.
 */
async function postSettlement(
  session: Session, journal: AttemptJournal, claimToken: string, timeoutMs: number,
): Promise<Settlement> {
  const settlement = {...(journal.settlement as Settlement)};
  const {workspaceId, machine} = session;
  const claimOwner = `mobile-runner:${machine.runnerId}`;
  const options = (key: string) => ({key, timeoutMs});
  // Without the attach workspace the server cannot match the attempt; nothing can be reported for it.
  if (settlement.attemptReport === 'pending' && !journal.workspace) settlement.attemptReport = 'skipped';
  if (settlement.attemptReport === 'pending' && journal.workspace) {
    const terminal = terminalReport(settlement);
    const reply = await session.call('POST', `/api/v1/work-items/${journal.workItemId}/execution-attempts`, {
      runtimeId: journal.runtimeId, leaseGeneration: 1, state: terminal.state, claimOwner, claimToken, dispatchId: journal.dispatchId,
      workspace: journal.workspace, ...(terminal.endReason ? {endReason: terminal.endReason} : {}),
    }, options(`${journal.runtimeId}:1:${terminal.state}`)).catch(() => null);
    settlement.attemptReport = settledStatus(reply?.status);
  }
  if (settlement.work === 'pending') {
    let reply: ApiResult | null;
    if (!settlement.started) {
      // Nothing ran: a failed start is the truth.
      reply = await session.call('POST', `/api/v1/work-items/dispatches/${journal.dispatchId}/ack`,
        {workspaceId, claimToken, state: 'failed'}, options(`${journal.dispatchId}:start-failed`)).catch(() => null);
    } else if (settlement.reason === 'stop_control' && settlement.controlId) {
      if (!settlement.cgroupEmpty) return settlement;
      // Acknowledged only on an observed empty cgroup; the server then cancels the work item.
      reply = await session.call('POST', `/api/v1/work-items/dispatches/${journal.dispatchId}/controls/ack`,
        {workspaceId, controlId: settlement.controlId, claimToken, state: 'acknowledged'}, options(`${settlement.controlId}:ack`)).catch(() => null);
    } else if (settlement.reason === 'workload_exited' && settlement.exitCode === 0) {
      reply = await session.call('POST', `/api/v1/work-items/${journal.workItemId}/review`, {
        workspaceId, claimOwner, claimToken,
        resultSummary: 'The workload exited 0. The supervisor collected no deliverable; verification and evidence are later units.',
        artifactRefs: [{type: 'worker_run', dispatchId: journal.dispatchId, attemptId: journal.attemptId, exitCode: 0}],
        durableMemory: {decision: 'skip', rationale: 'A supervised run does not infer durable knowledge from process completion'},
      }, options(`${journal.dispatchId}:review`)).catch(() => null);
    } else {
      const failureReason = settlement.reason === 'workload_exited'
        ? `The workload exited with code ${settlement.exitCode ?? 'unknown'}.`
        : `The supervisor stopped this attempt (${settlement.reason}); it was not re-executed.`;
      reply = await session.call('POST', `/api/v1/work-items/${journal.workItemId}/fail`, {
        workspaceId, claimOwner, claimToken, failureReason, resultSummary: failureReason,
        artifactRefs: [{type: 'worker_run', dispatchId: journal.dispatchId, attemptId: journal.attemptId, reason: settlement.reason}],
      }, options(`${journal.dispatchId}:fail`)).catch(() => null);
    }
    settlement.work = settledStatus(reply?.status);
  }
  return settlement;
}

const isSettled = (settlement: Settlement) => settlement.attemptReport !== 'pending' && settlement.work !== 'pending';

async function readLedger(deps: SuperviseDeps): Promise<string[]> {
  return (await readJournal<{executed?: string[]}>(deps.state, LEDGER))?.executed ?? [];
}

async function recordDispatch(deps: SuperviseDeps, dispatchId: string): Promise<void> {
  const executed = (await readLedger(deps)).filter((id) => id !== dispatchId);
  await writeJournal(deps.state, LEDGER, {executed: [...executed, dispatchId].slice(-LEDGER_LIMIT)});
}

/**
 * Runs at most one attempt. Returns `held` without consuming while an earlier
 * attempt's resources could not be shown gone. An earlier attempt whose
 * server settlement is still pending is settled with the recovered claim; it
 * is never run again, and neither is any dispatch already in the ledger.
 */
export async function superviseOnce(deps: SuperviseDeps): Promise<SuperviseOutcome> {
  let earlier = await readJournal<AttemptJournal>(deps.state, JOURNAL);
  if (earlier && earlier.state !== 'settling') {
    const reason = earlier.stop?.reason ?? 'recovered';
    const {facts, journal} = await settle(deps, earlier, reason, earlier.stop?.controlId);
    if (facts.held.length > 0) return {kind: 'held', held: facts.held};
    earlier = {...journal, state: 'settling', settlement: {...(journal.settlement ?? {
      reason, ...(journal.stop?.controlId ? {controlId: journal.stop.controlId} : {}),
      started: Boolean(journal.containers.sidecar || journal.containers.agent),
      attemptReport: journal.attemptId ? 'pending' : 'skipped', work: 'pending',
    }), cgroupEmpty: facts.cgroupEmpty === 'empty'}};
    await writeJournal(deps.state, JOURNAL, earlier);
  }

  const info = await deps.docker(['info', '--format', '{{json .}}']);
  const setupProblem = info.code === 0 ? cgroupSetupProblem(JSON.parse(info.stdout || '{}') as Record<string, unknown>) : 'docker_unavailable';
  if (setupProblem && !earlier) return {kind: 'refused', reason: setupProblem};

  const session = await openSession(deps);
  const {machine, workspaceId} = session;
  const heartbeatRunner = () => session.call('POST', '/api/v1/work-items/runners/heartbeat', {
    workspaceId, runnerId: machine.runnerId, displayName: `siftable supervisor (${hostname()})`.slice(0, 120),
  }, {timeoutMs: 10_000});
  // The runner must be live before consume; a new enrollment's runner starts expired.
  const announced = await heartbeatRunner();
  if (announced.status === 403) return {kind: 'refused', reason: 'not_admitted'};
  if (announced.status !== 200) return {kind: 'refused', reason: `runner_heartbeat_http_${announced.status}`};

  const sentMono = deps.clock.monoMs();
  const consumed = await session.call('POST', `/api/v1/work-items/runners/${machine.runnerId}/consume`, {workspaceId, consumerId: session.consumerId});
  if (consumed.status === 403) return {kind: 'refused', reason: 'not_admitted'};
  if (consumed.status !== 200) throw new SuperviseError(`consume returned HTTP ${consumed.status}`);
  const dispatch = consumed.body.dispatch as {id?: string; workItemId?: string; computeGrantId?: unknown; computeGrantExpiresAt?: unknown} | null;
  const workItem = consumed.body.workItem as ({id?: string; claimToken?: string; claimExpiresAt?: unknown} & Record<string, unknown>) | null;
  const claimed = Boolean(dispatch?.id && workItem?.id && typeof workItem.claimToken === 'string');

  if (earlier) {
    // Settle the earlier attempt with its own recovered claim, or record that the claim is gone.
    let settled = false;
    if (claimed && dispatch?.id === earlier.dispatchId) {
      const settlement = await postSettlement(session, earlier, workItem?.claimToken as string, 30_000);
      earlier = {...earlier, settlement};
      settled = isSettled(settlement);
      await writeJournal(deps.state, JOURNAL, earlier);
      if (!settled) return {kind: 'recovered', settled: false};
    }
    await archiveJournal(deps.state, JOURNAL, new Date(deps.clock.wallMs()));
    await removeJournal(deps.state, JOURNAL);
    if (!claimed || dispatch?.id === earlier.dispatchId) return {kind: 'recovered', settled};
  }
  if (setupProblem) return {kind: 'refused', reason: setupProblem};
  if (!claimed || !dispatch?.id || !workItem?.id) return {kind: 'idle'};
  const claimToken = workItem.claimToken as string;
  const claimOwner = `mobile-runner:${machine.runnerId}`;
  const {cap: firstCap, grantCap} = initialCaps(deps.clock, {claimExpiresAt: workItem.claimExpiresAt, computeGrantExpiresAt: dispatch.computeGrantExpiresAt}, sentMono);
  let cap = firstCap;
  const capLeft = () => cap - deps.clock.monoMs();
  const within = (ms: number) => Math.max(1, Math.min(ms, capLeft()));

  let journal: AttemptJournal = {
    version: 1, state: 'claimed', runId: randomBytes(6).toString('hex'), dispatchId: dispatch.id, workItemId: workItem.id,
    runtimeId: `machine:${machine.enrollmentId}:${dispatch.id}`, containers: {}, callSeq: 0,
  };
  // One writer: every write persists the latest journal, in order, so no snapshot can overwrite a later one.
  let writing: Promise<void> = Promise.resolve();
  const persist = () => {
    writing = writing.then(() => writeJournal(deps.state, JOURNAL, journal));
    return writing;
  };
  const save = async (next: AttemptJournal) => { journal = next; await persist(); };

  // Settles with the live claim, archiving once the server has confirmed everything.
  const conclude = async (settlement: Settlement): Promise<boolean> => {
    await save({...journal, state: 'settling', settlement});
    const posted = capLeft() > 0 ? await postSettlement(session, journal, claimToken, within(30_000)) : settlement;
    await save({...journal, settlement: posted});
    if (!isSettled(posted)) return false;
    await archiveJournal(deps.state, JOURNAL, new Date(deps.clock.wallMs()));
    await removeJournal(deps.state, JOURNAL);
    return true;
  };
  const refuseStart = async (reason: string): Promise<SuperviseOutcome> => {
    await conclude({reason: 'start_failed', started: false, cgroupEmpty: true, attemptReport: 'skipped', work: 'pending'});
    return {kind: 'refused', reason};
  };

  if ((await readLedger(deps)).includes(dispatch.id)) {
    // Already started here once (its journal was settled or lost): reconcile, never run it again.
    await save(journal);
    await conclude({reason: 'recovered', started: true, cgroupEmpty: true, attemptReport: 'skipped', work: 'pending'});
    return {kind: 'refused', reason: 'dispatch_already_executed'};
  }
  await save(journal);
  if (!(capLeft() > 0)) return refuseStart('no_confirmed_lease');
  // A grant-bound dispatch needs an approved managed launch payload; this supervisor does not fake one.
  if (dispatch.computeGrantId) return refuseStart('compute_grant_dispatch_unsupported');
  const plan = await deps.resolvePlan(workItem);
  if (!plan) return refuseStart('no_plan');
  const workspace = {repositoryId: plan.repositoryId, branch: plan.branch, baseSha: plan.baseSha};

  await recordDispatch(deps, dispatch.id);
  await save({...journal, workspace});
  const attached = await session.call('POST', `/api/v1/work-items/${workItem.id}/execution-attempts`, {
    runtimeId: journal.runtimeId, leaseGeneration: 1, state: 'starting', claimOwner, claimToken, dispatchId: dispatch.id, workspace,
  }, {key: `${journal.runtimeId}:1:starting`, timeoutMs: within(30_000)}).catch(() => null);
  const attempt = attached?.body.attempt as {id?: string; state?: string} | undefined;
  if (attached?.status !== 200 || !attempt?.id || attached.body.replayed === true || attempt.state !== 'starting') {
    // Only a fresh attempt in `starting` is a launch; a replay or an advanced attempt is reconciliation only.
    await conclude({reason: 'start_failed', started: false, cgroupEmpty: true, attemptReport: attempt?.id ? 'pending' : 'skipped', work: 'pending'});
    return {kind: 'refused', reason: attached ? `attach_not_fresh_${attached.status}` : 'attach_unknown'};
  }
  const attemptId = attempt.id;
  await save({...journal, state: 'attached', attemptId});

  // Startup Docker work runs inside the confirmed lease.
  const boundedDocker = (args: string[]) => deps.docker(args, {deadlineMono: cap});
  const must = async (args: string[]) => {
    const result = await boundedDocker(args);
    if (result.code !== 0) throw new SuperviseError(`docker ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim().slice(0, 200) || `exit ${result.code}`}`);
    return result.stdout.trim();
  };
  const runnerBeat = setInterval(() => { void heartbeatRunner().catch(() => undefined); }, RUNNER_HEARTBEAT_MS);

  let sidecar: AttachedProcess | undefined;
  let agent: AttachedProcess | undefined;
  let modelsOpen = false;
  const inputDir = path.join(deps.inputRoot, attemptId);
  const finish = async (reason: StopReason, exitCode?: number, controlId?: string): Promise<SuperviseOutcome> => {
    modelsOpen = false;
    clearInterval(runnerBeat);
    agent?.stdin.end();
    await writing;
    const settled = await settle(deps, journal, reason, controlId);
    sidecar?.kill();
    agent?.kill();
    journal = settled.journal;
    await fs.rm(inputDir, {recursive: true, force: true}).catch(() => undefined);
    const settlement: Settlement = {reason, ...(exitCode === undefined ? {} : {exitCode}), ...(controlId ? {controlId} : {}),
      started: Boolean(sidecar || agent), cgroupEmpty: settled.facts.cgroupEmpty === 'empty', attemptReport: 'pending', work: 'pending'};
    if (settled.facts.held.length > 0) {
      // Held resources block new work; the server is told once they are gone. Keep what it will be told.
      await save({...journal, settlement});
      return {kind: 'finished', reason, exitCode, facts: settled.facts, settled: false};
    }
    const done = await conclude(settlement);
    return {kind: 'finished', reason, exitCode, facts: settled.facts, settled: done};
  };
  const expired = () => capLeft() <= 0;

  try {
    const imageId = await ensureImage(boundedDocker, plan.imageRef);
    const nonce = randomBytes(16).toString('hex');
    await fs.mkdir(inputDir, {recursive: true, mode: 0o755});
    const inputFile = path.join(inputDir, 'input.json');
    await fs.writeFile(inputFile, JSON.stringify({attemptId, workItemId: workItem.id, title: workItem.title, prompt: workItem.prompt,
      acceptanceCriteria: workItem.acceptanceCriteria, writeScope: workItem.writeScope, plan}), {mode: 0o444});

    const labelsOnly = attemptSpecs(deps, journal, attemptId, plan, '', nonce, inputFile).networkLabels;
    const networkId = await must(networkCreateArgs(`sift-a-${journal.runId}`, labelsOnly));
    await save({...journal, networkId});
    const specs = attemptSpecs(deps, journal, attemptId, plan, networkId, nonce, inputFile);
    const sidecarId = await must(sandboxCreateArgs(specs.sidecar));
    await save({...journal, containers: {...journal.containers, sidecar: sidecarId}});
    const agentId = await must(sandboxCreateArgs(specs.agent));
    await save({...journal, state: 'created', containers: {...journal.containers, agent: agentId}});

    const inspectBoth = async (phase: 'created' | 'running') => {
      const inspected = JSON.parse(await must(['container', 'inspect', sidecarId, agentId])) as unknown[];
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
    if (expired()) return await finish('lease_lost');
    sidecar = deps.attach(['start', '--attach', '--interactive', sidecarId]);
    serveSidecarFrames(sidecar.stdout, sidecar.stdin, attemptRelayHandler({fetch: deps.fetch, diagnosticNonce: nonce}, {
      apiUrl: machine.apiUrl, token: session.token, workspaceId, workItemId: workItem.id, attemptId, claimToken,
    }, {
      open: () => modelsOpen && !expired(),
      nextCallId: async () => {
        // Reserve the number before any await, so concurrent calls never share one.
        if (!modelsOpen) throw new SuperviseError('Model calls are closed.');
        const seq = journal.callSeq + 1;
        journal = {...journal, callSeq: seq};
        await persist();
        if (!modelsOpen) throw new SuperviseError('Model calls are closed.');
        return `${attemptId}:${seq}`;
      },
    }));
    agent = deps.attach(['start', '--attach', '--interactive', agentId]);
    await save({...journal, state: 'started'});

    // Readiness: the launcher reached the relay through the sidecar and saw this run's nonce.
    const ready = await readFirstLine(agent.stdout, within(deps.timing?.readyTimeoutMs ?? READY_TIMEOUT_MS));
    // Keep the workload's output flowing; U5b collects it as evidence.
    agent.stdout.resume();
    const running = await inspectBoth('running');
    const [network] = JSON.parse(await must(['network', 'inspect', networkId])) as unknown[];
    running.push(...evaluateNetworkInspect(network, {networkId, labels: specs.networkLabels, containerIds: [sidecarId, agentId]}));
    const cgroups: Record<string, string | null> = {};
    for (const [role, id] of [['sidecar', sidecarId], ['agent', agentId]] as const) {
      const pid = Number(await must(['container', 'inspect', '--format', '{{.State.Pid}}', id]));
      cgroups[role] = Number.isInteger(pid) && pid > 0 ? parseCgroupV2(await deps.readFile(`/proc/${pid}/cgroup`).catch(() => '')) : null;
      if (!isInsideAttemptSlice(cgroups[role], attemptId)) running.push(`${role}:cgroup_membership`);
    }
    await save({...journal, cgroups: {sidecar: cgroups.sidecar ?? undefined, agent: cgroups.agent ?? undefined}});
    if (ready !== READY_LINE) running.push('launcher_not_ready');
    if (expired()) return await finish('lease_lost');
    if (running.length > 0) {
      deps.log(`The attempt did not start as specified: ${running.join(', ')}`);
      return await finish('start_failed');
    }

    if (deps.shutdown?.aborted) return await finish('shutdown');
    if (expired()) return await finish('lease_lost');
    // Positive acknowledgement before any workload or model call. A lost reply is unknown, never failed.
    await save({...journal, state: 'acknowledging'});
    let acknowledged = false;
    for (let attemptNo = 0; attemptNo < ACK_ATTEMPTS && !acknowledged && !expired(); attemptNo++) {
      const ack = await session.call('POST', `/api/v1/work-items/dispatches/${dispatch.id}/ack`,
        {workspaceId, claimToken, state: 'acknowledged'}, {key: `${dispatch.id}:ack`, timeoutMs: within(30_000)}).catch(() => null);
      if (ack?.status === 200) acknowledged = true;
      else if (ack && ack.status >= 400 && ack.status < 500) break;
    }
    if (!acknowledged) return await finish('ack_unknown');
    if (expired()) return await finish('lease_lost');
    await save({...journal, state: 'running'});
    const reported = await session.call('POST', `/api/v1/work-items/${workItem.id}/execution-attempts`, {
      runtimeId: journal.runtimeId, leaseGeneration: 1, state: 'running', claimOwner, claimToken, dispatchId: dispatch.id, workspace,
    }, {key: `${journal.runtimeId}:1:running`, timeoutMs: within(30_000)}).catch(() => null);
    if (reported?.status !== 200 || (reported.body.attempt as {state?: string} | undefined)?.state !== 'running') {
      deps.log(`The server did not confirm the attempt as running (HTTP ${reported?.status ?? 'unknown'}).`);
      return await finish('start_failed');
    }
    if (deps.shutdown?.aborted) return await finish('shutdown');
    if (expired()) return await finish('lease_lost');
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
          {timeoutMs: within(10_000)}).catch(() => null);
        const stop = (controls?.body.controls as Array<{id: string; action: string; state: string}> | undefined)
          ?.find((control) => control.action === 'stop' && control.state === 'pending');
        if (stop) return await finish('stop_control', undefined, stop.id);
      }
      if (deps.clock.monoMs() >= renewAt) {
        const sent = deps.clock.monoMs();
        const renewal = await session.call('POST', `/api/v1/work-items/dispatches/${dispatch.id}/heartbeat`, {
          workspaceId, runnerId: machine.runnerId, consumerId: session.consumerId, workItemId: workItem.id,
          claimOwner, claimToken, deadlineAt: heartbeatDeadlineAt(deps.clock),
        }, {timeoutMs: within(HEARTBEAT_BUDGET_MS)}).catch(() => null);
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
    return finish(expired() ? 'lease_lost' : 'start_failed');
  }
}

/** The shipped sidecar and launcher programs, beside this module in dist. */
export function supervisorAssets(): SuperviseDeps['assets'] {
  return {sidecar: path.join(__dirname, 'relaySidecar.js'), launcher: path.join(__dirname, 'attemptLauncher.js')};
}

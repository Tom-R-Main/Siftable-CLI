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
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {hostname} from 'node:os';
import path from 'node:path';
import {attemptSliceName, cgroupSetupProblem, isInsideAttemptSlice, parseCgroupV2, type ReadFile} from './attemptCgroup.js';
import {captureLog, type EvidenceOutcome, uploadAgentLog} from './attemptEvidence.js';
import {closeRecoveredQuestions, type JournalQuestion, QuestionDesk} from './attemptQuestions.js';
import {GO_LINE, READY_LINE} from './attemptLauncher.js';
import {dockerVersionProblem, evaluateNetworkInspect, evaluateSandboxInspect, networkCreateArgs, sandboxCreateArgs, type SandboxContainerSpec} from './containerSandbox.js';
import {DEADLINE_EXIT, type DeadlineDocker} from './hostDocker.js';
import {type Attach, type AttachedProcess, ensureImage, readFirstLine} from './machineQualify.js';
import {type CleanupFacts, type OutboxEntry, enqueueReceipts, flushReceipts, receiptsForStop} from './cleanupReceiptOutbox.js';
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
  /** The host's IPv4 addresses; none may lie in the attempt network's subnet. */
  hostAddresses: () => string[];
  state: MachineStateOptions;
  log: (line: string) => void;
  assets: {sidecar: string; launcher: string};
  /** Root-owned directory for read-only attempt inputs, outside the supervisor's state and any home. */
  inputRoot: string;
  resolvePlan: (workItem: Record<string, unknown>) => Promise<AttemptPlan | null>;
  /** Tests shorten these; production uses the defaults. */
  timing?: {controlPollMs?: number; readyTimeoutMs?: number; logDrainMs?: number};
  /** Aborted when the service is stopping: the running attempt is stopped and cleaned up before return. */
  shutdown?: AbortSignal;
  /**
   * Operator decision (`--release-unknown-creates`): creates whose result was never known and whose
   * resources are not found by name are treated as never made. Without it they stay held.
   */
  releaseUnknownCreates?: boolean;
  /** Tests substitute a slow or failing journal; production writes through machineState. */
  writeJournal?: (journal: AttemptJournal) => Promise<void>;
}

const writeAttemptJournal = (deps: SuperviseDeps, journal: AttemptJournal) =>
  (deps.writeJournal ? deps.writeJournal(journal) : writeJournal(deps.state, JOURNAL, journal));

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
  /** The workload's evidence (U5b-2b): absent when nothing ran; unacknowledged fails the work. */
  evidence?: EvidenceOutcome;
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
  /** The server's digest of the attempt's frozen input, the task the agent was given. */
  inputSha256?: string;
  /** The writer's questions (Needs you) and how far each got; closed and reconciled at any stop. */
  questions?: JournalQuestion[];
  /** Set once the workload ran: its evidence is owed, so a crash before the log is frozen still fails the work. */
  evidenceOwed?: boolean;
  /** The frozen workload log and how its upload ended; the file is kept on the machine unless acknowledged. */
  evidence?: {path: string; sha256: string; bytes: number} & Partial<EvidenceOutcome>;
  /** The last model call ID handed out; journaled before the call is sent. */
  callSeq: number;
  stop?: {reason: StopReason; controlId?: string; exitCode?: number; facts?: StopFacts};
  settlement?: Settlement;
  /** Creates sent but not yet answered. Their IDs are recorded whenever they resolve; an unresolved one is held. */
  pendingCreates?: Array<'network' | 'sidecar' | 'agent'>;
  /** Every cleanup receipt this attempt has owed, frozen here before it is handed to the outbox. */
  receipts?: CleanupFacts[];
  /** True once `receipts` are durably in the outbox; until then the journal is never archived. */
  receiptsQueued?: boolean;
  /** False when working out this stop's receipts failed; they are worked out again from `stop.facts` before archiving. */
  receiptsDerived?: boolean;
}

/** Dispatches this machine has started an attempt for; none is ever executed twice. */
const LEDGER = 'dispatches-journal.json';
const LEDGER_LIMIT = 500;

export type StopReason = 'stop_control' | 'workload_exited' | 'lease_lost' | 'ack_unknown' | 'start_failed' | 'shutdown' | 'recovered'
  | 'question_timeout';
export type SuperviseOutcome =
  | {kind: 'idle'}
  | {kind: 'held'; held: string[]}
  | {kind: 'refused'; reason: string; conflicts?: string[]}
  | {kind: 'recovered'; settled: boolean; conflicts?: string[]}
  | {kind: 'finished'; reason: StopReason; exitCode?: number; facts: StopFacts; settled: boolean; conflicts?: string[]};

export class SuperviseError extends Error {}

/** Startup was cut short by shutdown or by the confirmed lease running out. */
class Interrupted extends Error {
  constructor(readonly reason: 'shutdown' | 'lease_lost') {
    super(reason);
  }
}

interface ApiResult {status: number; body: Record<string, unknown>}

/** Machine identity and the authenticated API, read once per attempt. */
interface Session {
  machine: MachineRecord;
  token: string;
  workspaceId: string | null;
  consumerId: string;
  call(method: 'GET' | 'POST', route: string, body?: unknown, options?: {key?: string; timeoutMs?: number; signal?: AbortSignal}): Promise<ApiResult>;
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
        method, redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.floor(options.timeoutMs ?? 30_000))), ...(options.signal ? [options.signal] : [])]),
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

/** The fixed name each create used, so an unanswered create can be looked for later. */
function createName(runId: string, role: 'network' | 'sidecar' | 'agent'): string {
  return role === 'network' ? `sift-a-${runId}` : `sift-a-${runId}-${role === 'sidecar' ? 'relay' : 'agent'}`;
}

/**
 * Roles of unanswered creates still unresolved: a resource found under the
 * create's exact name settles it (the label sweep then removes it); one not
 * found stays unknown, because an outstanding request may still finish.
 */
async function unresolvedCreates(deps: SuperviseDeps, journal: AttemptJournal): Promise<Array<'network' | 'sidecar' | 'agent'>> {
  const unresolved: Array<'network' | 'sidecar' | 'agent'> = [];
  for (const role of journal.pendingCreates ?? []) {
    const name = createName(journal.runId, role);
    const found = role === 'network'
      ? await deps.docker(['network', 'ls', '--quiet', '--no-trunc', '--filter', `name=^${name}$`])
      : await deps.docker(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `name=^/${name}$`]);
    if (found.code !== 0 || !found.stdout.trim()) unresolved.push(role);
  }
  return unresolved;
}

/**
 * Every receipt this attempt owes after this stop (U2d-3b): the ones the
 * journal already froze, plus what this stop adds. Keys are numbered from the
 * journal's own record, so the obligation never depends on reading the
 * outbox. A create that never answered counts as held, so `cleaned` is never
 * claimed while a daemon request might still finish. An attempt that was
 * never attached has nothing to report.
 */
async function receiptsOwed(deps: SuperviseDeps, journal: AttemptJournal, facts: StopFacts): Promise<CleanupFacts[]> {
  const carried = journal.receipts ?? [];
  if (!journal.attemptId) return carried;
  const state = await inspectMachineState(deps.state);
  // An attached attempt owes receipts; machine state that cannot say to whom leaves them unresolved, never empty.
  if (state.kind !== 'enrolled') throw new SuperviseError(`The machine state is ${state.kind}; the cleanup receipts cannot be worked out yet`);
  const {machine} = state;
  const unresolved = (journal.pendingCreates ?? []).map((role) => `create:${role}`);
  const held = [...facts.held, ...unresolved];
  const journaled = Object.values(journal.containers).filter(Boolean).length;
  const heldContainers = held.filter((item) => item.startsWith('container:')).length;
  const known: OutboxEntry[] = carried.map((owed) => ({enrollmentId: machine.enrollmentId, facts: owed, status: 'pending', sends: 0}));
  const fresh = receiptsForStop(
    {attemptId: journal.attemptId, workItemId: journal.workItemId, dispatchId: journal.dispatchId,
      orgId: machine.scope.type === 'workspace' ? machine.scope.id : null},
    {cgroupEmpty: facts.cgroupEmpty, resourcesRemoved: facts.resourcesRemoved && unresolved.length === 0, held,
      containersRemoved: facts.cgroupEmpty === 'empty' ? Math.max(0, journaled - heldContainers) : 0},
    known);
  return [...carried, ...fresh];
}

/**
 * Settles a journal's receipt obligation: works out this stop's receipts if
 * that failed earlier, then hands every frozen receipt to the outbox. Returns
 * the journal as written, or null when either step failed; the caller then
 * keeps the journal active, so the same facts and keys are retried instead
 * of being archived away.
 */
async function ensureReceiptsQueued(deps: SuperviseDeps, journal: AttemptJournal): Promise<AttemptJournal | null> {
  let current = journal;
  try {
    if (current.receiptsDerived === false) {
      if (!current.stop?.facts) return null;
      const receipts = await receiptsOwed(deps, current, current.stop.facts);
      current = {...current, receipts, receiptsDerived: true, receiptsQueued: false};
      await writeAttemptJournal(deps, current);
    }
    if (current.receiptsQueued !== false) return current;
    // Worked out and nothing owed (an attempt that was never attached): settled.
    if (!current.receipts?.length) {
      current = {...current, receiptsQueued: true};
      await writeAttemptJournal(deps, current);
      return current;
    }
    const state = await inspectMachineState(deps.state);
    if (state.kind !== 'enrolled') return null;
    await enqueueReceipts(deps.state, state.machine.enrollmentId, current.receipts);
    current = {...current, receiptsQueued: true};
    await writeAttemptJournal(deps, current);
    return current;
  } catch (error) {
    deps.log(`Could not queue the cleanup receipts; the attempt stays journaled until they are: ${(error as Error).message}`);
    return null;
  }
}

/** Sends pending cleanup receipts, a bounded number per cycle. Never throws: they wait for the next cycle. */
async function sendCleanupReceipts(deps: SuperviseDeps): Promise<void> {
  try {
    const state = await inspectMachineState(deps.state);
    if (state.kind !== 'enrolled') return;
    const {machine} = state;
    if (deps.shutdown?.aborted) return;
    await flushReceipts({fetch: deps.fetch, state: deps.state, apiUrl: machine.apiUrl, now: () => new Date(deps.clock.wallMs()),
      workspaceId: machine.scope.type === 'workspace' ? machine.scope.id : null, signal: deps.shutdown, budgetMs: 20_000});
  } catch (error) {
    deps.log(`Could not send cleanup receipts: ${(error as Error).message}`);
  }
}

/** Tears down a journal's run; returns what is still held. Never relaunches. */
async function settle(
  deps: SuperviseDeps, journal: AttemptJournal, reason: StopReason, controlId?: string, pendingWrites: Promise<unknown> = Promise.resolve(),
): Promise<{facts: StopFacts; journal: AttemptJournal}> {
  // The workload's exit code survives a crash and a second sweep: recovery settles with it.
  const exitCode = journal.stop?.exitCode;
  const stop = {reason, ...(controlId ? {controlId} : {}), ...(exitCode === undefined ? {} : {exitCode})};
  let current: AttemptJournal = {...journal, state: 'stopping', stop};
  // The physical stop never waits on the journal, failed or slow: the `stopping` record is written in the
  // background, after any earlier write so an older snapshot cannot land last, and a failure is raised only
  // after kills and removal.
  let journalError: unknown;
  const stoppingWritten = pendingWrites.catch(() => undefined)
    .then(() => writeAttemptJournal(deps, current))
    .catch((error: unknown) => { journalError ??= error; });
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
  // A failure to work out the receipts is an obligation, never an empty list: the frozen ones are kept, and
  // this stop's are worked out again from stop.facts before the journal may be archived.
  let derived = true;
  const receipts = await receiptsOwed(deps, current, facts).catch((error: unknown) => {
    deps.log(`Could not work out the cleanup receipts: ${(error as Error).message}`);
    derived = false;
    return current.receipts ?? [];
  });
  const added = receipts.length > (current.receipts?.length ?? 0);
  current = {...current, receipts, receiptsDerived: derived,
    receiptsQueued: !derived || added ? false : current.receiptsQueued ?? true};
  await stoppingWritten;
  await writeAttemptJournal(deps, current).catch((error: unknown) => { journalError ??= error; });
  if (journalError === undefined) current = await ensureReceiptsQueued(deps, current) ?? current;
  if (journalError !== undefined) {
    throw new SuperviseError(`The attempt was stopped (cgroup ${facts.cgroupEmpty}, resources ${facts.resourcesRemoved ? 'removed' : 'held'}), `
      + `but its journal could not be written: ${(journalError as Error).message}. The earlier journal is kept for the next start.`);
  }
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
/** Evidence upload before settlement: three rounds at most, within this and the confirmed lease. */
const EVIDENCE_BUDGET_MS = 120_000;

function terminalReport(settlement: Settlement): {state: 'ended' | 'interrupted'; endReason?: 'lease_lost' | 'terminated' | 'failed'} {
  // A workload that exited cleanly but whose evidence was never acknowledged ended as failed.
  if (settlement.reason === 'workload_exited' && settlement.evidence?.acknowledged === false) return {state: 'ended', endReason: 'failed'};
  switch (settlement.reason) {
    case 'workload_exited': return settlement.exitCode === 0 ? {state: 'ended'} : {state: 'ended', endReason: 'failed'};
    case 'stop_control': return {state: 'ended', endReason: 'terminated'};
    case 'lease_lost': return {state: 'interrupted', endReason: 'lease_lost'};
    case 'shutdown': return {state: 'interrupted', endReason: 'terminated'};
    default: return {state: 'ended', endReason: 'failed'};
  }
}

/**
 * 200 confirms. 409 is the server's definitive refusal (for example an
 * attempt that was never recorded cannot be ended) and is kept as a surfaced
 * conflict. Everything else, including 401 and 403 from a revoked credential,
 * leaves the item pending: no transition happened on the server.
 */
const settledStatus = (status: number | undefined): 'done' | 'conflict' | 'pending' => {
  if (status === 200) return 'done';
  if (status === 409) return 'conflict';
  return 'pending';
};

const conflictsOf = (settlement: Settlement | undefined): string[] => (settlement
  ? [...(settlement.attemptReport === 'conflict' ? ['attempt_report'] : []), ...(settlement.work === 'conflict' ? ['work_result'] : [])]
  : []);

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
    } else if (settlement.reason === 'workload_exited' && settlement.exitCode === 0 && settlement.evidence?.acknowledged !== false) {
      const manifestDigest = settlement.evidence?.manifestDigest;
      reply = await session.call('POST', `/api/v1/work-items/${journal.workItemId}/review`, {
        workspaceId, claimOwner, claimToken,
        resultSummary: manifestDigest
          ? 'The workload exited 0. Its log is the acknowledged evidence; there is no checkout, patch or verifier result yet.'
          : 'The workload exited 0. The supervisor collected no deliverable; verification and evidence are later units.',
        artifactRefs: [{type: 'worker_run', dispatchId: journal.dispatchId, attemptId: journal.attemptId, exitCode: 0},
          ...(manifestDigest ? [{type: 'evidence_manifest', attemptId: journal.attemptId, manifestDigest}] : [])],
        durableMemory: {decision: 'skip', rationale: 'A supervised run does not infer durable knowledge from process completion'},
      }, options(`${journal.dispatchId}:review`)).catch(() => null);
    } else {
      const failureReason = settlement.reason === 'workload_exited' && settlement.exitCode === 0
        ? 'The workload exited 0, but its evidence upload failed (evidence_upload_failed); the log is kept on the machine.'
        : settlement.reason === 'workload_exited'
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

/**
 * Finishes an evidence upload a crash cut off, under the attempt's own recovered claim and before its
 * settlement is posted. The frozen log must still match its journaled digest; nothing is re-run.
 */
async function resumeEvidence(deps: SuperviseDeps, session: Session, journal: AttemptJournal, claimToken: string,
  deadlineMono: number): Promise<AttemptJournal | 'cancelled'> {
  const frozen = journal.evidence;
  if (!frozen || !journal.settlement || journal.settlement.evidence || !journal.attemptId) return journal;
  const intact = await fs.readFile(frozen.path)
    .then((bytes) => bytes.length === frozen.bytes && createHash('sha256').update(bytes).digest('hex') === frozen.sha256)
    .catch(() => false);
  const outcome: EvidenceOutcome = intact ? await uploadAgentLog({
    call: (method, route, body, options) => session.call(method, route, body, options), fetch: deps.fetch,
    monoMs: () => deps.clock.monoMs(), deadlineMono,
    route: `/api/v1/work-items/${journal.workItemId}/execution-attempts/${journal.attemptId}/evidence-manifest`, claimToken,
    log: {path: frozen.path, sha256: frozen.sha256, bytes: frozen.bytes}, signal: deps.shutdown,
  }) : {acknowledged: false};
  // Shutdown again: still undecided; the journal is left as it was for the next start.
  if (outcome.cancelled) return 'cancelled';
  const next = {...journal, evidence: {...frozen, ...outcome}, settlement: {...journal.settlement, evidence: outcome}};
  await writeAttemptJournal(deps, next);
  if (outcome.acknowledged) await fs.rm(path.dirname(frozen.path), {recursive: true, force: true}).catch(() => undefined);
  return next;
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
    // An unanswered create is settled only by finding its resource by name, or by the operator's explicit release.
    const unknown = deps.releaseUnknownCreates ? [] : await unresolvedCreates(deps, earlier);
    const swept = await settle(deps, {...earlier, pendingCreates: unknown}, reason, earlier.stop?.controlId);
    let {facts, journal} = swept;
    if (unknown.length > 0) {
      facts = {...facts, resourcesRemoved: false, held: [...facts.held, ...unknown.map((role) => `create:${role}`)]};
      journal = {...journal, state: 'held', stop: {...(journal.stop ?? {reason}), facts}};
      await writeAttemptJournal(deps, journal);
    }
    if (facts.held.length > 0) {
      // Physical recovery came first; receipts still go out while resources are held.
      await sendCleanupReceipts(deps);
      return {kind: 'held', held: facts.held};
    }
    // Evidence whose upload had ended is settled as it ended; one cut off mid-upload stays undecided and is
    // finished below under the attempt's own recovered claim.
    // Evidence owed but never frozen (a crash between the exit and the freeze) can never be acknowledged.
    const ended = journal.evidence ? journal.evidence.acknowledged : journal.evidenceOwed ? false : undefined;
    earlier = {...journal, state: 'settling', settlement: {...(journal.settlement ?? {
      reason, ...(journal.stop?.controlId ? {controlId: journal.stop.controlId} : {}),
      ...(journal.stop?.exitCode === undefined ? {} : {exitCode: journal.stop.exitCode}),
      ...(ended === undefined ? {} : {evidence: {acknowledged: ended, ...(journal.evidence?.manifestDigest
        ? {manifestDigest: journal.evidence.manifestDigest} : {})}}),
      started: Boolean(journal.containers.sidecar || journal.containers.agent),
      // The attach may have committed even if its reply was lost: report by the journaled runtime and workspace.
      attemptReport: journal.workspace ? 'pending' : 'skipped', work: 'pending',
    }), cgroupEmpty: facts.cgroupEmpty === 'empty'}};
    await writeAttemptJournal(deps, earlier);
  }

  // Receipts go out every cycle, after any recovery above has stopped what it had to, within a short budget.
  await sendCleanupReceipts(deps);
  const info = await deps.docker(['info', '--format', '{{json .}}']);
  const dockerInfo = info.code === 0 ? JSON.parse(info.stdout || '{}') as Record<string, unknown> : null;
  const setupProblem = dockerInfo ? cgroupSetupProblem(dockerInfo) ?? dockerVersionProblem(dockerInfo) : 'docker_unavailable';
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
  if (consumed.status !== 200) {
    // A 409 means the server holds a dispatch for this runner whose claim this host can no longer present,
    // such as one that expired while the supervisor was down; only the operator can requeue it. Wait and
    // retry instead of exiting, which under systemd is a restart loop. An earlier attempt keeps its journal.
    return {kind: 'refused', reason: consumed.status === 409 ? 'runner_lease_changed' : `consume_http_${consumed.status}`};
  }
  const dispatch = consumed.body.dispatch as {id?: string; workItemId?: string; computeGrantId?: unknown; computeGrantExpiresAt?: unknown} | null;
  const workItem = consumed.body.workItem as ({id?: string; claimToken?: string; claimExpiresAt?: unknown} & Record<string, unknown>) | null;
  const claimed = Boolean(dispatch?.id && workItem?.id && typeof workItem.claimToken === 'string');

  if (earlier) {
    // Settle the earlier attempt with its own recovered claim, or record that the claim is gone.
    let settled = false;
    if (claimed && dispatch?.id === earlier.dispatchId) {
      // Only within the claim the server just confirmed; a missing expiry leaves no time to upload.
      const recoveredCap = initialCaps(deps.clock, {claimExpiresAt: workItem?.claimExpiresAt,
        computeGrantExpiresAt: dispatch?.computeGrantExpiresAt}, sentMono).cap;
      const resumed = await resumeEvidence(deps, session, earlier, workItem?.claimToken as string,
        Math.min(recoveredCap, deps.clock.monoMs() + EVIDENCE_BUDGET_MS));
      if (resumed === 'cancelled') return {kind: 'recovered', settled: false};
      earlier = resumed;
      // The attempt stopped with the restart: its questions are closed and reconciled, never offered again.
      const pending = earlier;
      if (pending.questions?.length && !await closeRecoveredQuestions(pending.questions, (questions) => writeAttemptJournal(deps,
        earlier = {...pending, questions}), () => deps.clock.monoMs(), (method, route, body, options) => session.call(method, route, body,
        {...options, signal: deps.shutdown}), pending.workItemId, {runtimeId: pending.runtimeId, leaseGeneration: 1,
        claimOwner: `mobile-runner:${machine.runnerId}`, claimToken: workItem?.claimToken as string},
        Math.min(30_000, recoveredCap - deps.clock.monoMs()))) return {kind: 'recovered', settled: false};
      const settlement = await postSettlement(session, earlier, workItem?.claimToken as string, 30_000);
      earlier = {...earlier, settlement};
      settled = isSettled(settlement);
      await writeAttemptJournal(deps, earlier);
      if (!settled) return {kind: 'recovered', settled: false};
    }
    const ready = await ensureReceiptsQueued(deps, earlier);
    if (!ready) return {kind: 'recovered', settled: false};
    earlier = ready;
    await archiveJournal(deps.state, JOURNAL, new Date(deps.clock.wallMs()));
    await removeJournal(deps.state, JOURNAL);
    const conflicts = conflictsOf(earlier.settlement);
    if (!claimed || dispatch?.id === earlier.dispatchId) return {kind: 'recovered', settled, ...(conflicts.length ? {conflicts} : {})};
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
    // A failed write is returned to its caller but never poisons the writes queued after it.
    const next = writing.catch(() => undefined).then(() => writeAttemptJournal(deps, journal));
    writing = next;
    return next;
  };
  const save = async (next: AttemptJournal) => { journal = next; await persist(); };

  // Settles with the live claim, archiving once the server has confirmed everything.
  const conclude = async (settlement: Settlement, budgetMs = 30_000): Promise<boolean> => {
    await save({...journal, state: 'settling', settlement});
    const posted = capLeft() > 0 ? await postSettlement(session, journal, claimToken, within(budgetMs)) : settlement;
    await save({...journal, settlement: posted});
    if (!isSettled(posted)) return false;
    const ready = await ensureReceiptsQueued(deps, journal);
    if (!ready) return false;
    journal = ready;
    await archiveJournal(deps.state, JOURNAL, new Date(deps.clock.wallMs()));
    await removeJournal(deps.state, JOURNAL);
    return true;
  };
  const refuseStart = async (reason: string): Promise<SuperviseOutcome> => {
    const conflicts = (): string[] => conflictsOf(journal.settlement);
    await conclude({reason: 'start_failed', started: false, cgroupEmpty: true, attemptReport: 'skipped', work: 'pending'});
    return {kind: 'refused', reason, ...(conflicts().length ? {conflicts: conflicts()} : {})};
  };

  if ((await readLedger(deps)).includes(dispatch.id)) {
    // Already started here once (its journal was settled or lost): reconcile, never run it again.
    await save(journal);
    await conclude({reason: 'recovered', started: true, cgroupEmpty: true, attemptReport: 'skipped', work: 'pending'});
    const conflicts = conflictsOf(journal.settlement);
    return {kind: 'refused', reason: 'dispatch_already_executed', ...(conflicts.length ? {conflicts} : {})};
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
    // Whatever the reply, the attach may have committed; the terminal report is keyed by runtime, not by attempt ID.
    await conclude({reason: 'start_failed', started: false, cgroupEmpty: true, attemptReport: 'pending', work: 'pending'});
    const conflicts = conflictsOf(journal.settlement);
    return {kind: 'refused', reason: attached ? `attach_not_fresh_${attached.status}` : 'attach_unknown', ...(conflicts.length ? {conflicts} : {})};
  }
  const attemptId = attempt.id;
  await save({...journal, state: 'attached', attemptId});

  // One lifetime signal: aborted by shutdown or when the confirmed lease runs out. Every startup await races it.
  const life = new AbortController();
  const onShutdown = () => life.abort('shutdown');
  if (deps.shutdown?.aborted) life.abort('shutdown');
  deps.shutdown?.addEventListener('abort', onShutdown, {once: true});
  let capTimer = setTimeout(() => life.abort('lease_lost'), Math.max(0, Math.floor(capLeft())));
  const rearmCap = () => {
    clearTimeout(capTimer);
    capTimer = setTimeout(() => life.abort('lease_lost'), Math.max(0, Math.floor(capLeft())));
  };
  const guard = <T>(work: Promise<T>): Promise<T> => Promise.race([work, new Promise<never>((_, reject) => {
    const interrupt = () => reject(new Interrupted(life.signal.reason === 'shutdown' ? 'shutdown' : 'lease_lost'));
    if (life.signal.aborted) interrupt();
    else life.signal.addEventListener('abort', interrupt, {once: true});
  })]);

  // Startup Docker work runs inside the confirmed lease.
  const boundedDocker = (args: string[]) => deps.docker(args, {deadlineMono: cap});
  const must = async (args: string[]) => {
    const result = await guard(boundedDocker(args));
    if (result.code !== 0) throw new SuperviseError(`docker ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim().slice(0, 200) || `exit ${result.code}`}`);
    return result.stdout.trim();
  };
  // A create is journaled before it is sent, and its ID is recorded whenever it answers, even after an interruption,
  // so teardown sees it. One cut off by the deadline may still complete in the daemon, so it stays pending.
  const inflight = new Set<Promise<unknown>>();
  let finished = false;
  const create = async (role: 'network' | 'sidecar' | 'agent', args: string[]) => {
    await save({...journal, pendingCreates: [...(journal.pendingCreates ?? []), role]});
    const recorded = boundedDocker(args).then(async (created) => {
      // After this run has finished its journal belongs to recovery, which looks for the resource by name.
      if (finished) return created;
      const id = created.code === 0 ? created.stdout.trim() : '';
      const pendingCreates = created.code === DEADLINE_EXIT ? journal.pendingCreates : (journal.pendingCreates ?? []).filter((r) => r !== role);
      journal = role === 'network'
        ? {...journal, pendingCreates, ...(id ? {networkId: id} : {})}
        : {...journal, pendingCreates, containers: {...journal.containers, ...(id ? {[role]: id} : {})}};
      await persist();
      return created;
    });
    inflight.add(recorded);
    void recorded.finally(() => inflight.delete(recorded));
    const result = await guard(recorded);
    if (result.code !== 0) throw new SuperviseError(`docker ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim().slice(0, 200) || `exit ${result.code}`}`);
    return result.stdout.trim();
  };
  const runnerBeat = setInterval(() => { void heartbeatRunner().catch(() => undefined); }, RUNNER_HEARTBEAT_MS);

  let sidecar: AttachedProcess | undefined;
  let agent: AttachedProcess | undefined;
  let agentLog: ReturnType<typeof captureLog> | undefined;
  // During the run every question call is bounded by the confirmed lease and dies with the attempt's lifetime.
  const call = (method: 'GET' | 'POST', route: string, body?: unknown, options?: {key?: string; timeoutMs?: number}) =>
    session.call(method, route, body, {...options, timeoutMs: within(options?.timeoutMs ?? 10_000), signal: life.signal});
  // Closing runs after the lifetime ends, within its own budget.
  const closeCall = (method: 'GET' | 'POST', route: string, body?: unknown, options?: {key?: string; timeoutMs?: number}) =>
    session.call(method, route, body, options);
  const credential = {runtimeId: journal.runtimeId, leaseGeneration: 1, claimOwner: `mobile-runner:${machine.runnerId}`, claimToken};
  const desk = new QuestionDesk(journal.questions ?? [], (questions) => save({...journal, questions}), () => deps.clock.monoMs());
  let modelsOpen = false;
  const inputDir = path.join(deps.inputRoot, attemptId);
  const finish = async (reason: StopReason, exitCode?: number, controlId?: string): Promise<SuperviseOutcome> => {
    modelsOpen = false;
    clearInterval(runnerBeat);
    clearTimeout(capTimer);
    deps.shutdown?.removeEventListener('abort', onShutdown);
    if (!life.signal.aborted) life.abort('finished');
    agent?.stdin.end();
    if (exitCode !== undefined) journal = {...journal, stop: {reason, ...(controlId ? {controlId} : {}), exitCode}};
    // Known containers are killed at once, before waiting on creates in flight or on any journal write.
    const killBy = deps.clock.monoMs() + STOP_BUDGET_MS;
    for (const id of [journal.containers.agent, journal.containers.sidecar]) {
      if (id) await deps.docker(['container', 'kill', '--signal', 'KILL', id], {deadlineMono: killBy});
    }
    // Then wait, within the stop budget, for creates still in flight, so their IDs are torn down too.
    await Promise.race([Promise.allSettled([...inflight]), sleep(Math.max(0, killBy - deps.clock.monoMs()))]);
    finished = true;
    const settled = await settle(deps, journal, reason, controlId, writing);
    // The killed container closes its attach stream: the log is frozen at that end, before the attach client is killed.
    const frozenLog = agentLog ? await agentLog.close(deps.timing?.logDrainMs).catch((error: unknown) => {
      deps.log(`The attempt's log was not captured whole: ${(error as Error).message}`);
      return undefined;
    }) : undefined;
    sidecar?.kill();
    agent?.kill();
    journal = settled.journal;
    const unresolved = journal.pendingCreates ?? [];
    if (unresolved.length > 0) {
      // A create that never answered may still finish in the daemon: one empty sweep proves nothing. Hold until the next start.
      const facts = {...settled.facts, resourcesRemoved: false, held: [...settled.facts.held, ...unresolved.map((role) => `create:${role}`)]};
      settled.facts = facts;
      await save({...journal, state: 'held', stop: {reason, ...(controlId ? {controlId} : {}), facts}});
    }
    // Leaves the attempt unsettled, its state as the stop wrote it so the next start sweeps again, then settles it there.
    const keepUnsettled = async (outcome?: EvidenceOutcome): Promise<SuperviseOutcome> => {
      await save({...journal, settlement: {reason, ...(exitCode === undefined ? {} : {exitCode}), ...(controlId ? {controlId} : {}),
        started: true, cgroupEmpty: settled.facts.cgroupEmpty === 'empty', attemptReport: 'pending', work: 'pending',
        ...(outcome && !outcome.cancelled ? {evidence: outcome} : {})}});
      return {kind: 'finished', reason, exitCode, facts: settled.facts, settled: false};
    };
    // Evidence, once every process has stopped and while the attempt's own claim still holds: settlement comes after.
    let evidence: EvidenceOutcome | undefined;
    if (agentLog) {
      const log = frozenLog;
      if (log) await save({...journal, evidence: log});
      const uploadable = log && settled.facts.cgroupEmpty === 'empty' && reason !== 'shutdown' && reason !== 'lease_lost' && capLeft() > 0;
      evidence = uploadable ? await uploadAgentLog({call: (method, route, body, options) => session.call(method, route, body, options),
        fetch: deps.fetch, monoMs: () => deps.clock.monoMs(), deadlineMono: Math.min(cap, deps.clock.monoMs() + EVIDENCE_BUDGET_MS),
        route: `/api/v1/work-items/${workItem.id}/execution-attempts/${attemptId}/evidence-manifest`, claimToken, log,
        signal: deps.shutdown}) : {acknowledged: false};
      // Shutdown arrived mid-upload: nothing is decided or posted; the next start finishes it under the recovered claim.
      if (evidence.cancelled) return keepUnsettled();
      if (journal.evidence) await save({...journal, evidence: {...journal.evidence, ...evidence}});
      if (!evidence.acknowledged) deps.log(`The attempt's evidence was not acknowledged; its log is kept at ${inputDir}.`);
    }
    // Questions are closed while the claim holds: received answers recorded delivered, unconfirmed ones failed.
    // 5 s at shutdown (the unit's stop timeout), else 30 s, never past the claim. Anything left unrecorded keeps the
    // attempt unsettled; the next start reconciles under the same claim before settling.
    const closeBudget = Math.min(deps.shutdown?.aborted ? 5_000 : 30_000, capLeft());
    if (!await desk.close(closeCall, journal.workItemId, credential, closeBudget)) return keepUnsettled(evidence);
    // An unacknowledged log stays on the machine for the operator; nothing else is kept.
    if (!evidence || evidence.acknowledged) await fs.rm(inputDir, {recursive: true, force: true}).catch(() => undefined);
    const settlement: Settlement = {reason, ...(exitCode === undefined ? {} : {exitCode}), ...(controlId ? {controlId} : {}),
      started: Boolean(sidecar || agent), cgroupEmpty: settled.facts.cgroupEmpty === 'empty', attemptReport: 'pending', work: 'pending',
      ...(evidence ? {evidence} : {})};
    if (settled.facts.held.length > 0) {
      // Held resources block new work; the server is told once they are gone. Keep what it will be told.
      await save({...journal, settlement});
      return {kind: 'finished', reason, exitCode, facts: settled.facts, settled: false};
    }
    // During shutdown the unit's stop timeout bounds everything; settlement gets 10 s and the rest waits for the next start.
    const done = await conclude(settlement, reason === 'shutdown' ? 10_000 : 30_000);
    if (reason !== 'shutdown') await sendCleanupReceipts(deps);
    const conflicts = conflictsOf(journal.settlement);
    return {kind: 'finished', reason, exitCode, facts: settled.facts, settled: done, ...(conflicts.length ? {conflicts} : {})};
  };
  const expired = () => capLeft() <= 0;

  try {
    // The frozen input: the server derives the task from the work item once per attempt and returns the same one on
    // every later request. The agent gets exactly that, never the consume body. Its digest is the server's, over
    // Postgres's rendering of the payload, so it is recorded as given.
    const accepted = await guard(session.call('POST', `/api/v1/work-items/${workItem.id}/execution-attempts/${attemptId}/input`,
      {claimToken}, {timeoutMs: within(30_000), signal: life.signal}).catch(() => null));
    const input = accepted?.body as {payloadSha256?: unknown; task?: unknown} | undefined;
    if (accepted?.status !== 200 || typeof input?.payloadSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.payloadSha256)
      || !input.task || typeof input.task !== 'object') {
      deps.log(`The server did not return the attempt's input (HTTP ${accepted?.status ?? 'unknown'}).`);
      return await finish('start_failed');
    }
    await save({...journal, inputSha256: input.payloadSha256});
    const imageId = await guard(ensureImage(boundedDocker, plan.imageRef));
    const nonce = randomBytes(16).toString('hex');
    await fs.mkdir(inputDir, {recursive: true, mode: 0o755});
    const inputFile = path.join(inputDir, 'input.json');
    await fs.writeFile(inputFile, JSON.stringify({version: 1, attemptId, workItemId: workItem.id,
      inputSha256: input.payloadSha256, task: input.task, plan}), {mode: 0o444});

    const labelsOnly = attemptSpecs(deps, journal, attemptId, plan, '', nonce, inputFile).networkLabels;
    const networkId = await create('network', networkCreateArgs(`sift-a-${journal.runId}`, labelsOnly));
    const specs = attemptSpecs(deps, journal, attemptId, plan, networkId, nonce, inputFile);
    const sidecarId = await create('sidecar', sandboxCreateArgs(specs.sidecar));
    const agentId = await create('agent', sandboxCreateArgs(specs.agent));
    await save({...journal, state: 'created'});

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
      questions: desk,
    }));
    agent = deps.attach(['start', '--attach', '--interactive', agentId]);
    await save({...journal, state: 'started'});

    // Readiness: the launcher reached the relay through the sidecar and saw this run's nonce.
    const ready = await guard(readFirstLine(agent.stdout, within(deps.timing?.readyTimeoutMs ?? READY_TIMEOUT_MS)));
    // The workload's output (stdout and stderr, merged by the launcher) is the attempt's log.
    agentLog = captureLog(inputDir, agent.stdout);
    await save({...journal, evidenceOwed: true});
    const running = await inspectBoth('running');
    const [network] = JSON.parse(await must(['network', 'inspect', networkId])) as unknown[];
    running.push(...evaluateNetworkInspect(network, {networkId, labels: specs.networkLabels, containerIds: [sidecarId, agentId],
      hostAddresses: deps.hostAddresses()}));
    const cgroups: Record<string, string | null> = {};
    for (const [role, id] of [['sidecar', sidecarId], ['agent', agentId]] as const) {
      const pid = Number(await must(['container', 'inspect', '--format', '{{.State.Pid}}', id]));
      cgroups[role] = Number.isInteger(pid) && pid > 0 ? parseCgroupV2(await guard(deps.readFile(`/proc/${pid}/cgroup`).catch(() => ''))) : null;
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
        {workspaceId, claimToken, state: 'acknowledged'}, {key: `${dispatch.id}:ack`, timeoutMs: within(30_000), signal: life.signal}).catch(() => null);
      if (life.signal.aborted) break;
      if (ack?.status === 200) acknowledged = true;
      else if (ack && ack.status >= 400 && ack.status < 500) break;
    }
    if (deps.shutdown?.aborted) return await finish('shutdown');
    if (!acknowledged) return await finish(expired() ? 'lease_lost' : 'ack_unknown');
    if (expired()) return await finish('lease_lost');
    await save({...journal, state: 'running'});
    const reported = await session.call('POST', `/api/v1/work-items/${workItem.id}/execution-attempts`, {
      runtimeId: journal.runtimeId, leaseGeneration: 1, state: 'running', claimOwner, claimToken, dispatchId: dispatch.id, workspace,
    }, {key: `${journal.runtimeId}:1:running`, timeoutMs: within(30_000), signal: life.signal}).catch(() => null);
    if (deps.shutdown?.aborted) return await finish('shutdown');
    if (expired()) return await finish('lease_lost');
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
          {timeoutMs: within(10_000), signal: life.signal}).catch(() => null);
        const stop = (controls?.body.controls as Array<{id: string; action: string; state: string}> | undefined)
          ?.find((control) => control.action === 'stop' && control.state === 'pending');
        if (stop) return await finish('stop_control', undefined, stop.id);
        if (await guard(desk.tick(call, journal.workItemId, credential))) return await finish('question_timeout');
      }
      if (deps.clock.monoMs() >= renewAt) {
        const sent = deps.clock.monoMs();
        const renewal = await session.call('POST', `/api/v1/work-items/dispatches/${dispatch.id}/heartbeat`, {
          workspaceId, runnerId: machine.runnerId, consumerId: session.consumerId, workItemId: workItem.id,
          claimOwner, claimToken, deadlineAt: heartbeatDeadlineAt(deps.clock),
        }, {timeoutMs: within(HEARTBEAT_BUDGET_MS), signal: life.signal}).catch(() => null);
        if (life.signal.aborted) return await finish(deps.shutdown?.aborted ? 'shutdown' : 'lease_lost');
        if (renewal?.status === 200) {
          cap = renewedCap(deps.clock, (renewal.body.authority as {claimExpiresAt?: unknown} | undefined)?.claimExpiresAt, sent, grantCap);
          rearmCap();
        } else if (renewal && (renewal.status === 403 || renewal.status === 409)) {
          return await finish('lease_lost');
        }
        // Anything else leaves the confirmed cap where it was.
        renewAt = deps.clock.monoMs() + nextRenewalDelay(cap, deps.clock.monoMs());
      }
    }
  } catch (error) {
    if (error instanceof Interrupted) return finish(error.reason);
    deps.log(`The attempt failed: ${(error as Error).message}`);
    return finish(expired() ? 'lease_lost' : 'start_failed');
  }
}

/** The shipped sidecar and launcher programs, beside this module in dist. */
export function supervisorAssets(): SuperviseDeps['assets'] {
  return {sidecar: path.join(__dirname, 'relaySidecar.js'), launcher: path.join(__dirname, 'attemptLauncher.js')};
}

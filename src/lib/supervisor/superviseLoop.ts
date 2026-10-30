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
import {checkoutPlanProblem} from './attemptCheckout.js';
import {conflictsOf, postSettlement, type Session} from './attemptReport.js';
import {captureLog, type EvidenceOutcome, type FrozenArtifact, uploadAgentLog} from './attemptEvidence.js';
import {resumeEvidence, resumeVerification, saveInstallOutput} from './attemptRecovery.js';
import {type BaseVerification, freezeVerifierLog, type RunRecord, type TestPlan, VERIFIER_LOG_CONTENT_TYPE, verifyBase, VerifyFailed,
  verifyResult} from './attemptVerify.js';
import {buildSubmissions, pinOf, sendSubmissions, stepResults, testPlanProblem, type VerificationJournal} from './attemptVerifyRecords.js';
import type {AttemptFsRecord, AttemptFsSystem} from './attemptFilesystem.js';
import {checkAttemptVolume, freezePatch, installDependencies, prepareWorkspace, releaseWorkspace, type WorkspaceContext, WorkspaceRefused,
  writerVolumes} from './attemptWorkspace.js';
import {closeRecoveredQuestions, type JournalQuestion, QuestionDesk} from './attemptQuestions.js';
import {GO_LINE, READY_LINE} from './attemptLauncher.js';
import {dockerVersionProblem, evaluateNetworkInspect, evaluateSandboxInspect, networkCreateArgs, sandboxCreateArgs, type SandboxContainerSpec,
  type SandboxVolume} from './containerSandbox.js';
import {type CreateRole, ensureReceiptsQueued, JOURNAL, NETWORK_ROLES, POST_STOP_ROLES, rederiveReceipts, sendCleanupReceipts, settle, SuperviseError,
  unresolvedCreates, writeAttemptJournal} from './attemptSettle.js';
import {DEADLINE_EXIT, type DeadlineDocker} from './hostDocker.js';
import {type Attach, type AttachedProcess, ensureImage, readFirstLine} from './machineQualify.js';
import type {CleanupFacts} from './cleanupReceiptOutbox.js';
import {archiveJournal, inspectMachineState, type MachineStateOptions, readCredential, readJournal, removeJournal, writeJournal} from './machineState.js';
import {attemptRelayHandler} from './modelRelayHandler.js';
import {DIAGNOSTIC_PATH, MODEL_PATHS, SIDECAR_PORT} from './relaySidecar.js';
import {serveSidecarFrames} from './sidecarBridge.js';
import {STOP_BUDGET_MS, type StopFacts} from './stopAttempt.js';
import {heartbeatDeadlineAt, HEARTBEAT_BUDGET_MS, initialCaps, nextRenewalDelay, renewedCap, type SupervisorClock} from './superviseAuthority.js';

export {JOURNAL, SuperviseError} from './attemptSettle.js';
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
  /** The checkout (U5b-2c): a public GitHub repository at baseSha, and the directories the writer may change. */
  repositoryUrl?: string;
  writeScope?: string[];
  /** Install the checkout's npm dependencies behind the registry-only proxy before the writer starts. */
  install?: {manager: 'npm'};
  /** Verification (U3-1): the test command, the selector for the failing test, and the test files to freeze. */
  test?: TestPlan;
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
  assets: {sidecar: string; launcher: string; checkoutHelper?: string; registryProxy?: string; junitReport?: string};
  /** Where attempt filesystems live and how they are made (U5b-2c); a checkout plan is refused without it. */
  attemptFs?: {system: AttemptFsSystem; root: string};
  /** Root-owned directory for read-only attempt inputs, outside the supervisor's state and any home. */
  inputRoot: string;
  resolvePlan: (workItem: Record<string, unknown>) => Promise<AttemptPlan | null>;
  /** Tests shorten these; production uses the defaults. */
  timing?: {controlPollMs?: number; readyTimeoutMs?: number; logDrainMs?: number; prepareDrainMs?: number};
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
  containers: Partial<Record<'sidecar' | 'agent' | 'checkout' | 'patch' | 'proxy' | 'install' | 'verify-checkout' | 'tree-check' | 'report'
    | 'verifier' | 'result-commit' | 'review-relay' | 'reviewer', string>>;
  /** The helpers' own networks (checkout bridge, install network, proxy egress, review); the run-label sweep removes them too. */
  helperNetworks?: Partial<Record<'fetch' | 'install-net' | 'egress' | 'review-net', string>>;
  /** The attempt's own filesystem (U5b-2c): kept, with its volumes, when the evidence was not acknowledged. */
  fs?: AttemptFsRecord;
  /** The write scope's patch, frozen beside the log for the evidence manifest. */
  patch?: FrozenArtifact;
  /** Set while the checkout is being prepared; a stop that could not wait for it to end leaves it set, and the workspace held. */
  preparing?: boolean;
  /**
   * A failed dependency install's output: `owed` from the moment the install fails until a copy is saved beside the
   * attempt's input (`saved`). While owed, neither finish nor recovery releases the filesystem that holds it.
   */
  installOutput?: 'owed' | 'saved';
  cgroups?: {sidecar?: string; agent?: string};
  /** The workspace the attempt was attached with; terminal reports repeat it. */
  workspace?: {repositoryId: string; branch: string; baseSha: string};
  /** The server's digest of the attempt's frozen input, the task the agent was given. */
  inputSha256?: string;
  /** The writer's questions (Needs you) and how far each got; closed and reconciled at any stop. */
  questions?: JournalQuestion[];
  /** Set once the workload ran: its evidence is owed, so a crash before the log is frozen still fails the work. */
  evidenceOwed?: boolean;
  /**
   * The frozen workload log and how its upload ended; the file is kept on the machine unless acknowledged. When
   * verification stopped the start, no workload ran and the verifier log is the evidence (`kind`).
   */
  evidence?: {path: string; sha256: string; bytes: number; kind?: 'verifier_log'} & Partial<EvidenceOutcome>;
  /** Verification (U3-1): the pinned plan, the outcome once known, and each step's record without the claim token. */
  verification?: VerificationJournal;
  /** The verifier log, frozen beside the log and patch for the evidence manifest. */
  verifierLog?: FrozenArtifact;
  /** The last model call ID handed out; journaled before the call is sent. */
  callSeq: number;
  stop?: {reason: StopReason; controlId?: string; exitCode?: number; facts?: StopFacts};
  settlement?: Settlement;
  /** Creates sent but not yet answered. Their IDs are recorded whenever they resolve; an unresolved one is held. */
  pendingCreates?: CreateRole[];
  /** Every cleanup receipt this attempt has owed, frozen here before it is handed to the outbox. */
  receipts?: CleanupFacts[];
  /** True once `receipts` are durably in the outbox; until then the journal is never archived. */
  receiptsQueued?: boolean;
  /** How many of `receipts` earlier stops owed; re-deriving this stop's receipts keeps exactly those. */
  receiptsCarried?: number;
  /** False when working out this stop's receipts failed; they are worked out again from `stop.facts` before archiving. */
  receiptsDerived?: boolean;
}

/** Dispatches this machine has started an attempt for; none is ever executed twice. */
const LEDGER = 'dispatches-journal.json';
const LEDGER_LIMIT = 500;

export type StopReason = 'stop_control' | 'workload_exited' | 'lease_lost' | 'ack_unknown' | 'start_failed' | 'shutdown' | 'recovered'
  | 'question_timeout' | 'verification_failed';
export type SuperviseOutcome =
  | {kind: 'idle'}
  | {kind: 'held'; held: string[]}
  | {kind: 'refused'; reason: string; conflicts?: string[]}
  | {kind: 'recovered'; settled: boolean; conflicts?: string[]}
  | {kind: 'finished'; reason: StopReason; exitCode?: number; facts: StopFacts; settled: boolean; conflicts?: string[]};


/** Startup was cut short by shutdown or by the confirmed lease running out. */
class Interrupted extends Error {
  constructor(readonly reason: 'shutdown' | 'lease_lost') {
    super(reason);
  }
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

function attemptSpecs(deps: SuperviseDeps, journal: AttemptJournal, attemptId: string, plan: AttemptPlan, networkId: string, nonce: string, inputFile: string,
  workspace?: SandboxVolume[]) {
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
    // With a checkout, /workspace is the repository: read-only except the write scope. Without one, empty scratch.
    tmpfs: workspace ? ['/tmp'] : ['/tmp', '/workspace'], ...(workspace ? {volumes: workspace, workdir: '/workspace'} : {}),
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
/** Teardown waits this long for a checkout being prepared to stop at its next step; past it the workspace is held. */
const PREPARE_DRAIN_MS = 45_000;
/**
 * Checkout preparations still running in this process, by run. A journal left `preparing` stays held while its run is
 * here. After a restart nothing is: the unit's KillMode=mixed kills the whole cgroup, children included, on any stop.
 */
const preparations = new Set<string>();
/** Evidence upload before settlement: three rounds at most, within this and the confirmed lease. */
const EVIDENCE_BUDGET_MS = 120_000;


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
  // A checkout preparation an earlier stop could not wait out may still be allocating or creating: nothing is torn down under it.
  if (earlier?.preparing && preparations.has(earlier.runId)) return {kind: 'held', held: ['workspace:preparing']};
  if (earlier?.preparing) earlier = {...earlier, preparing: false};
  if (earlier && earlier.state !== 'settling') {
    const reason = earlier.stop?.reason ?? 'recovered';
    // An unanswered create is settled only by finding its resource by name, or by the operator's explicit release.
    const unknown = deps.releaseUnknownCreates ? [] : await unresolvedCreates(deps, earlier);
    const swept = await settle(deps, {...earlier, pendingCreates: unknown}, reason, earlier.stop?.controlId, undefined,
      Boolean(earlier.fs && earlier.fs.state !== 'released'));
    let {facts, journal} = swept;
    if (unknown.length > 0) {
      facts = {...facts, resourcesRemoved: false, held: [...facts.held, ...unknown.map((role) => `create:${role}`)]};
      journal = {...journal, state: 'held', stop: {...(journal.stop ?? {reason}), facts}};
      await writeAttemptJournal(deps, journal);
    }
    if (facts.held.length > 0) {
      // Physical recovery came first; receipts still go out while resources are held.
      await ensureReceiptsQueued(deps, journal);
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
      // Verification records are sent before the work is reported; one still pending leaves the attempt for the next start.
      const verified = await resumeVerification(deps, session, resumed, workItem?.claimToken as string);
      if (verified === 'pending') return {kind: 'recovered', settled: false};
      earlier = verified;
      // A failed install's output a crash left unsaved is copied from the filesystem that still holds it, if it can be.
      if (earlier.installOutput === 'owed' && earlier.attemptId) {
        earlier = await saveInstallOutput(deps, earlier, path.join(deps.inputRoot, earlier.attemptId));
      }
      // Its filesystem goes once nothing on it is owed; otherwise it stays for the operator, recorded in the archive.
      const owed = (earlier.evidenceOwed && !earlier.settlement?.evidence?.acknowledged) || earlier.installOutput === 'owed';
      if (earlier.fs && earlier.fs.state !== 'released' && deps.attemptFs && !owed) {
        const held = await releaseWorkspace((args) => deps.docker(args), deps.attemptFs.system,
          {runId: earlier.runId, attemptId: earlier.attemptId ?? ''}, earlier.fs);
        if (held.length > 0) {
          // The deferred receipts still say cleaned; a release that could not be shown complete makes them cleanup_failed.
          const prior = earlier.stop?.facts ?? {processesStopped: true, cgroupEmpty: 'empty' as const, resourcesRemoved: true, held: []};
          const facts = {...prior, resourcesRemoved: false, held: [...prior.held, ...held]};
          earlier = {...earlier, state: 'held', stop: {...(earlier.stop ?? {reason: 'recovered' as const}), facts}};
          earlier = await rederiveReceipts(deps, earlier, facts);
          await writeAttemptJournal(deps, earlier);
          await ensureReceiptsQueued(deps, earlier);
          return {kind: 'held', held};
        }
        earlier = {...earlier, fs: {...earlier.fs, state: 'released'}};
        await writeAttemptJournal(deps, earlier);
      }
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
  const checkout = plan.repositoryUrl === undefined && plan.writeScope === undefined ? undefined
    : {repositoryUrl: plan.repositoryUrl as string, baseSha: plan.baseSha, writeScope: plan.writeScope as string[]};
  if (checkout && (checkoutPlanProblem(checkout) || !deps.attemptFs || !deps.assets.checkoutHelper)) return refuseStart('plan_invalid');
  // Dependencies need a checkout, npm, the proxy program, and no write scope over the installed node_modules.
  if (plan.install !== undefined && (!checkout || plan.install?.manager !== 'npm' || !deps.assets.registryProxy
    || checkout.writeScope.some((scope) => scope.split('/')[0] === 'node_modules'))) return refuseStart('plan_invalid');
  // Verification needs the checkout, its installed dependencies and the report reader; the work item's verification
  // plan is pinned now, before the attach, so a plan without its three steps refuses with nothing run.
  if (plan.test !== undefined && (testPlanProblem(plan.test) || !checkout || !plan.install || !deps.assets.junitReport)) return refuseStart('plan_invalid');
  const pin = plan.test ? pinOf(await session.call('GET', `/api/v1/work-items/${workItem.id}/verification-plan`, undefined,
    {timeoutMs: within(15_000)}).then((reply) => (reply.status === 200 ? reply.body : undefined), () => undefined)) : undefined;
  if (plan.test && !pin) return refuseStart('plan_invalid');
  const workspace = {repositoryId: plan.repositoryId, branch: plan.branch, baseSha: plan.baseSha};

  await recordDispatch(deps, dispatch.id);
  await save({...journal, workspace, ...(pin ? {verification: {pin}} : {})});
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
  const create = async (role: CreateRole, args: string[]) => {
    await save({...journal, pendingCreates: [...(journal.pendingCreates ?? []), role]});
    const recorded = boundedDocker(args).then(async (created) => {
      // After this run has finished its journal belongs to recovery, which looks for the resource by name.
      if (finished) return created;
      const id = created.code === 0 ? created.stdout.trim() : '';
      const pendingCreates = created.code === DEADLINE_EXIT ? journal.pendingCreates : (journal.pendingCreates ?? []).filter((r) => r !== role);
      journal = role === 'volume' ? {...journal, pendingCreates}
        : role === 'network' ? {...journal, pendingCreates, ...(id ? {networkId: id} : {})}
        : NETWORK_ROLES.has(role) ? {...journal, pendingCreates, helperNetworks: {...journal.helperNetworks, ...(id ? {[role]: id} : {})}}
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
  let helperImageId: string | undefined;
  // Helpers made after the run has finished (the patch) still journal their requests and IDs, so a crash leaves them to the sweep.
  const helperCreate = async (role: CreateRole, args: string[]) => {
    await save({...journal, pendingCreates: [...(journal.pendingCreates ?? []), role]});
    const created = await deps.docker(args, {deadlineMono: deps.clock.monoMs() + STOP_BUDGET_MS});
    const id = created.code === 0 ? created.stdout.trim() : '';
    await save({...journal, containers: {...journal.containers, ...(id ? {[role]: id} : {})},
      pendingCreates: created.code === DEADLINE_EXIT ? journal.pendingCreates : (journal.pendingCreates ?? []).filter((r) => r !== role)});
    if (!id) throw new SuperviseError(`docker container create failed: ${created.stderr.trim().slice(0, 200) || `exit ${created.code}`}`);
    return id;
  };
  // A checkout being prepared, and anything a helper left that could not be shown removed.
  let preparing: Promise<void> | undefined;
  const helperHeld: string[] = [];
  // A failed dependency install's output: kept beside the attempt's input before its filesystem is released.
  let installFailure: Buffer | undefined;
  // Verification (U3-1): the base run's result, or the failure that stopped the start before any writer existed.
  let baseVerified: BaseVerification | undefined;
  let verifyFailure: VerifyFailed | undefined;
  const workspaceContext = (make: WorkspaceContext['create'], deadlineMono: () => number, signal?: AbortSignal): WorkspaceContext | undefined =>
    (checkout && deps.attemptFs && deps.assets.checkoutHelper && helperImageId ? {
      runId: journal.runId, attemptId, imageRef: plan.imageRef, imageId: helperImageId, slice: attemptSliceName(attemptId), checkout,
      helperAsset: deps.assets.checkoutHelper, proxyAsset: deps.assets.registryProxy, hostAddresses: deps.hostAddresses(),
      docker: (args) => deps.docker(args, {deadlineMono: deadlineMono()}), attach: deps.attach,
      create: make, fsSystem: deps.attemptFs.system, attemptRoot: deps.attemptFs.root, persistFs: (record) => save({...journal, fs: record}),
      signal, held: (item) => { helperHeld.push(item); },
    } : undefined);
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
    // A checkout still being prepared stops at its next step; teardown waits for it, so nothing is made or journaled after.
    // One that does not stop in time leaves the workspace unknown: held, never released or archived.
    const prepareUnknown = preparing ? !await Promise.race([preparing.then(() => true), sleep(deps.timing?.prepareDrainMs ?? PREPARE_DRAIN_MS).then(() => false)]) : false;
    if (preparing && !prepareUnknown) journal = {...journal, preparing: false};
    finished = true;
    // With an attempt filesystem, this stop's receipts wait until the evidence has decided whether it is kept.
    const settled = await settle(deps, journal, reason, controlId, writing, Boolean(journal.fs));
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
        started: Boolean(sidecar || agent), cgroupEmpty: settled.facts.cgroupEmpty === 'empty', attemptReport: 'pending', work: 'pending',
        ...(outcome && !outcome.cancelled ? {evidence: outcome} : {})}});
      return {kind: 'finished', reason, exitCode, facts: settled.facts, settled: false};
    };
    // Evidence, once every process has stopped and while the attempt's own claim still holds: settlement comes after.
    let evidence: EvidenceOutcome | undefined;
    // Verification stopped the start: no workload ran, and the verifier log with the base run is the evidence.
    if (agentLog || verifyFailure) {
      const log = agentLog ? frozenLog : undefined;
      if (log) await save({...journal, evidence: log});
      const clean = settled.facts.cgroupEmpty === 'empty' && reason !== 'shutdown' && reason !== 'lease_lost' && capLeft() > 0;
      const uploadable = (log || verifyFailure) && clean;
      // With a checkout the patch is evidence too, built once every writer process has stopped; without it the evidence fails.
      const helpers = uploadable && journal.fs && !prepareUnknown
        ? workspaceContext(helperCreate, () => Math.min(cap, deps.clock.monoMs() + STOP_BUDGET_MS)) : undefined;
      const patch = log && helpers && journal.fs ? await freezePatch(helpers, journal.fs, inputDir).catch((error: unknown) => {
        deps.log(`The patch was not built: ${(error as Error).message}`);
        return undefined;
      }) : undefined;
      if (patch) await save({...journal, patch});
      // The result is verified only after a clean exit 0 with its patch; the verifier log is evidence either way.
      let verifierLog: FrozenArtifact | undefined;
      if (journal.verification && (baseVerified || verifyFailure)) {
        let runs: RunRecord[] = baseVerified ? [baseVerified.run] : [];
        let outcome = 'not_run';
        let failure: VerifyFailed | undefined = verifyFailure;
        const base = baseVerified;
        const verifying = !failure && base && patch && journal.fs && plan.test && deps.assets.junitReport && reason === 'workload_exited'
          && exitCode === 0 ? workspaceContext(helperCreate, () => deps.clock.monoMs() + STOP_BUDGET_MS) : undefined;
        if (verifying && base && patch && journal.fs && plan.test && deps.assets.junitReport) {
          // Verification ends at the confirmed claim or at shutdown: no run starts after either, and a running one is
          // killed. Stopping and removing its containers has its own budget, so an expired claim cannot leave them behind.
          const verifyLife = new AbortController();
          const stopAt = setTimeout(() => verifyLife.abort(), Math.max(0, capLeft()));
          const onShutdown = () => verifyLife.abort();
          if (deps.shutdown?.aborted) verifyLife.abort();
          else deps.shutdown?.addEventListener('abort', onShutdown, {once: true});
          runs = await verifyResult({...verifying, signal: verifyLife.signal, record: journal.fs, test: plan.test, reportAsset: deps.assets.junitReport,
            dependencies: Boolean(plan.install)}, base, patch).catch((error: unknown) => {
            failure = error instanceof VerifyFailed ? error : new VerifyFailed('verify_failed', (error as Error).message, [base.run]);
            return failure.runs;
          }).finally(() => {
            clearTimeout(stopAt);
            deps.shutdown?.removeEventListener('abort', onShutdown);
          });
          outcome = 'passed';
        }
        if (failure) {
          runs = failure.runs;
          outcome = failure.code === 'interrupted' ? 'verification_interrupted' : failure.code;
        }
        verifierLog = await freezeVerifierLog(inputDir, {runs, frozen: baseVerified?.frozen ?? [], outcome});
        const submissions = buildSubmissions({pin: journal.verification.pin, executionAttemptId: attemptId, environmentLabel: `sift-machine:${machine.runnerId}`,
          claimOwner, ranAt: new Date(deps.clock.wallMs()).toISOString(), results: stepResults(runs, failure?.step, !plan.test?.selector)});
        await save({...journal, verifierLog, verification: {...journal.verification, outcome, ...(failure ? {detail: failure.detail} : {}), submissions},
          // With no workload log, the verifier log is what is owed and resumed after a restart.
          ...(log ? {} : {evidence: {path: verifierLog.path, sha256: verifierLog.sha256, bytes: verifierLog.bytes, kind: 'verifier_log' as const},
            evidenceOwed: true})});
      }
      const primary = log ?? (verifierLog && !agentLog ? verifierLog : undefined);
      evidence = uploadable && primary && (!log || !journal.fs || patch) ? await uploadAgentLog({call: (method, route, body, options) => session.call(method, route, body, options),
        fetch: deps.fetch, monoMs: () => deps.clock.monoMs(), deadlineMono: Math.min(cap, deps.clock.monoMs() + EVIDENCE_BUDGET_MS),
        route: `/api/v1/work-items/${workItem.id}/execution-attempts/${attemptId}/evidence-manifest`, claimToken, log: primary,
        ...(log ? {} : {logKind: 'verifier_log' as const, logContentType: VERIFIER_LOG_CONTENT_TYPE}),
        also: [...(patch ? [patch] : []), ...(log && verifierLog ? [verifierLog] : [])], signal: deps.shutdown}) : {acknowledged: false};
      // Shutdown arrived mid-upload: nothing is decided or posted; the next start finishes it under the recovered claim.
      if (evidence.cancelled) return keepUnsettled();
      if (journal.evidence) await save({...journal, evidence: {...journal.evidence, ...evidence}});
      if (!evidence.acknowledged) deps.log(`The attempt's evidence was not acknowledged; its log is kept at ${inputDir}.`);
      // Each verification step is recorded once its evidence is acknowledged, before the work is reported.
      const records = journal.verification?.submissions;
      if (evidence.acknowledged && evidence.manifestDigest && records?.length) {
        const sent = await sendSubmissions((route, body, key) => session.call('POST', route, body, {key, timeoutMs: 30_000}), journal.workItemId, records,
          claimToken, evidence.manifestDigest, (next) => save({...journal, verification: {...journal.verification as VerificationJournal, submissions: next}}));
        if (sent.some((entry) => entry.state === 'pending')) return keepUnsettled(evidence);
      }
    }
    // A failed install's output is the only account of the failure: the filesystem holding it goes only once it is saved.
    if (journal.installOutput === 'owed') journal = await saveInstallOutput(deps, journal, inputDir, installFailure);
    // The attempt filesystem goes once nothing on it is owed: the evidence was acknowledged, or the workload never ran.
    let releaseHeld: string[] = [];
    // A create that never answered (the volume above all) may still finish in the daemon: nothing is released under it.
    const createsSettled = (journal.pendingCreates ?? []).length === 0;
    if (journal.fs && journal.fs.state !== 'released' && deps.attemptFs && !prepareUnknown && createsSettled && journal.installOutput !== 'owed'
      && (!journal.evidenceOwed || evidence?.acknowledged)) {
      releaseHeld = await releaseWorkspace((args) => deps.docker(args, {deadlineMono: deps.clock.monoMs() + STOP_BUDGET_MS}),
        deps.attemptFs.system, {runId: journal.runId, attemptId}, journal.fs);
      if (releaseHeld.length === 0) await save({...journal, fs: {...journal.fs, state: 'released'}});
    } else if (journal.fs && journal.fs.state !== 'released') {
      deps.log(`The attempt's filesystem is kept for recovery at ${journal.fs.image}.`);
    }
    // A helper left behind, a workspace whose preparation never ended, or a release that could not be shown complete is
    // held; this stop's receipts, still unqueued while the filesystem exists, are worked out again from the final facts.
    // A post-stop create (the patch, a verification or review helper) that never answered may still finish in the daemon:
    // held until the next start finds it by name.
    const latePending = (journal.pendingCreates ?? []).filter((role) => POST_STOP_ROLES.has(role)).map((role) => `create:${role}`);
    const lateHeld = [...helperHeld, ...latePending, ...(prepareUnknown ? ['workspace:preparing'] : []), ...releaseHeld];
    if (lateHeld.length > 0) {
      settled.facts = {...settled.facts, resourcesRemoved: false, held: [...settled.facts.held, ...lateHeld]};
      await save(await rederiveReceipts(deps, journal, settled.facts));
      // Durable: the next start sees the hold in the journal, not only in this return value.
      await save({...journal, state: 'held', stop: {...(journal.stop ?? {reason}), facts: settled.facts}});
    }
    // Questions are closed while the claim holds: received answers recorded delivered, unconfirmed ones failed.
    // 5 s at shutdown (the unit's stop timeout), else 30 s, never past the claim. Anything left unrecorded keeps the
    // attempt unsettled; the next start reconciles under the same claim before settling.
    const closeBudget = Math.min(deps.shutdown?.aborted ? 5_000 : 30_000, capLeft());
    if (!await desk.close(closeCall, journal.workItemId, credential, closeBudget)) return keepUnsettled(evidence);
    // An unacknowledged log stays on the machine for the operator; nothing else is kept.
    if ((!evidence || evidence.acknowledged) && !journal.installOutput) await fs.rm(inputDir, {recursive: true, force: true}).catch(() => undefined);
    const settlement: Settlement = {reason, ...(exitCode === undefined ? {} : {exitCode}), ...(controlId ? {controlId} : {}),
      started: Boolean(sidecar || agent), cgroupEmpty: settled.facts.cgroupEmpty === 'empty', attemptReport: 'pending', work: 'pending',
      ...(evidence ? {evidence} : {})};
    if (settled.facts.held.length > 0) {
      // Held resources block new work; the server is told once they are gone. Keep what it will be told.
      await save({...journal, settlement});
      journal = await ensureReceiptsQueued(deps, journal) ?? journal;
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

    // The checkout comes first: the writer's mounts name its volumes. A refusal ends the start before any writer exists.
    // The writer's mounts. Not `workspace`: that name is the attach workspace every attempt report carries.
    let writerMounts: SandboxVolume[] | undefined;
    let installLog: Buffer | undefined;
    if (checkout) {
      helperImageId = imageId;
      const helpers = workspaceContext((role, args) => create(role, args), () => cap);
      if (!helpers) return await finish('start_failed');
      await save({...journal, preparing: true});
      const runId = journal.runId;
      preparations.add(runId);
      const lifetime = {...helpers, signal: life.signal};
      // Preparation is the checkout and, when planned, the dependency install: one lifetime, waited out as one.
      const prepared = prepareWorkspace(lifetime).then(async (record) => {
        if (plan.install) {
          installLog = await installDependencies(lifetime, record).catch(async (error: unknown) => {
            // Any refusal that carries npm's output (a failure, a timeout) owes it; one from admission, without output, does not.
            if (error instanceof WorkspaceRefused && error.log !== undefined) {
              installFailure = error.log;
              // Durable before anything else happens: a crash from here on still finds the output owed.
              await save({...journal, installOutput: 'owed'});
            }
            throw error;
          });
        }
        if (plan.test && deps.assets.junitReport) {
          // Owed before the first test runs: a crash from here on keeps the attempt filesystem, with its reports, held.
          await save({...journal, evidenceOwed: true});
          baseVerified = await verifyBase({...lifetime, record, test: plan.test, reportAsset: deps.assets.junitReport,
            dependencies: Boolean(plan.install)}).catch((error: unknown) => {
            // A stop mid-run is an interruption, not a verification result. The outcome is journaled only with the
            // frozen verifier log and its records, in one write (finish), never before them.
            if (error instanceof VerifyFailed && error.code !== 'interrupted') verifyFailure = error;
            throw error;
          });
        }
      });
      preparing = prepared.then(() => undefined, () => undefined).finally(() => preparations.delete(runId));
      await guard(prepared);
      await save({...journal, preparing: false});
      // The writer's handoff, like every helper's: the volume is still exactly ours before its container is made.
      if (journal.fs) await guard(checkAttemptVolume(helpers, journal.fs));
      writerMounts = writerVolumes(journal.runId, checkout.writeScope, Boolean(plan.install));
    }
    const labelsOnly = attemptSpecs(deps, journal, attemptId, plan, '', nonce, inputFile).networkLabels;
    const networkId = await create('network', networkCreateArgs(`sift-a-${journal.runId}`, labelsOnly));
    const specs = attemptSpecs(deps, journal, attemptId, plan, networkId, nonce, inputFile, writerMounts);
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
    agentLog = captureLog(inputDir, agent.stdout, installLog?.length
      ? Buffer.concat([Buffer.from('[sift: dependency install]\n'), installLog, Buffer.from('\n[sift: workload]\n')]) : undefined);
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
    if (verifyFailure) return finish('verification_failed');
    deps.log(`The attempt failed: ${(error as Error).message}`);
    return finish(expired() ? 'lease_lost' : 'start_failed');
  }
}

/** The shipped sidecar and launcher programs, beside this module in dist. */
export function supervisorAssets(): SuperviseDeps['assets'] {
  return {sidecar: path.join(__dirname, 'relaySidecar.js'), launcher: path.join(__dirname, 'attemptLauncher.js'),
    checkoutHelper: path.join(__dirname, 'checkoutHelper.js'), registryProxy: path.join(__dirname, 'registryProxy.js'),
    junitReport: path.join(__dirname, 'junitReport.js')};
}

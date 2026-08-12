import {randomUUID} from "node:crypto";
import {hostname} from "node:os";
import type {
  ChildSessionLaunch,
  ChildSessionController,
  ChildSessionRecord,
  SpawnChildResult,
} from "./childSessionController";
import type {
  ActiveChildSessionRecoveryRecord,
  ChildSessionRecoveryRecord,
  ChildSessionRunLock,
  ChildSessionStore,
  SafeChildSessionRecoveryRecord,
} from "./childSessionStore";
import {
  evaluateChildAdmission,
  type ChildAdmission,
  type MergeMasterAccessMode,
  type MergeMasterWorkIdentity,
} from "./mergeMaster";

type ApiResponse = {
  data?: unknown;
  error?: string;
  statusCode?: number;
};

export interface WorkRunClient {
  getWorkItem(workItemId: string): Promise<ApiResponse>;
  getWorkVerificationPlan(workItemId: string): Promise<ApiResponse>;
  claimWorkItem(input: {
    workItemId: string;
    claimOwner: string;
    leaseSeconds: number;
  }): Promise<ApiResponse>;
  transitionWorkItem(
    workItemId: string,
    action: string,
    input: {claimOwner: string; claimToken: string; leaseSeconds?: number},
    request?: {signal?: AbortSignal},
  ): Promise<ApiResponse>;
}

export interface WorkRunControllerOptions {
  client: WorkRunClient;
  childController: Pick<
    ChildSessionController,
    "resolveLaunch" | "spawnOrAdoptChild" | "adoptChild" | "abandonChild" | "teardownChild"
  >;
  store: ChildSessionStore;
  cwd?: string;
  baseBranch?: string;
  leaseSeconds?: number;
  ownerFactory?: () => string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  now?: () => number;
  onLeaseFailure?: (failure: {runId: string; reason: string}) => void;
  evaluateAdmission?: (candidate: {
    accessMode: MergeMasterAccessMode;
    writeScope: string[];
  }) => ChildAdmission;
}

export interface CompensationResult {
  attempted: Array<"metadata" | "worktree" | "lease">;
  failures: Array<{step: "metadata" | "worktree" | "lease"; reason: string}>;
}

export type StartContractedWorkResult =
  | {ok: true; run: SafeChildSessionRecoveryRecord}
  | {
      ok: false;
      stage: "load_work_item" | "load_plan" | "admission" | "claim" | "spawn" | "persist" | "start";
      reason: string;
      blockedBy?: number;
      sharedScope?: string[];
      compensation: CompensationResult;
    };

export interface WorkRunRecoveryResult {
  recovered: SafeChildSessionRecoveryRecord[];
  failed: Array<{
    runId?: string;
    reason: string;
    compensation?: CompensationResult;
  }>;
}

export interface WorkRunController {
  startContractedWork(workItemId: string): Promise<StartContractedWorkResult>;
  recoverWorkRuns(): Promise<WorkRunRecoveryResult>;
  shutdown(input?: {preserveRuns?: boolean}): Promise<void>;
}

type WorkRunStage =
  | "load_work_item"
  | "load_plan"
  | "admission"
  | "claim"
  | "spawn"
  | "persist"
  | "start";

class WorkRunError extends Error {
  constructor(
    readonly stage: WorkRunStage,
    message: string,
    readonly retryable = false,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "WorkRunError";
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function responseData(
  response: ApiResponse,
  stage: WorkRunError["stage"],
  label: string,
): Record<string, unknown> {
  if (
    (typeof response.statusCode === "number" && (response.statusCode < 200 || response.statusCode >= 300))
    || response.error
  ) {
    const status = typeof response.statusCode === "number" ? ` (${response.statusCode})` : "";
    const retryable = response.statusCode === 0
      || response.statusCode === undefined
      || response.statusCode === 429
      || response.statusCode >= 500;
    throw new WorkRunError(stage, `${label} failed${status}`, retryable, response.statusCode);
  }
  const data = object(response.data);
  if (!data) throw new WorkRunError(stage, `${label} returned no data`, true);
  return data;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return undefined;
  return [...value] as string[];
}

function parseWorkIdentity(
  requestedWorkItemId: string,
  response: ApiResponse,
): {identity: MergeMasterWorkIdentity; accessMode: MergeMasterAccessMode} {
  const data = responseData(response, "load_work_item", "load work item");
  const workItem = object(data.workItem);
  if (!workItem) throw new WorkRunError("load_work_item", "load work item returned an invalid item");
  if (workItem.id !== requestedWorkItemId) {
    throw new WorkRunError("load_work_item", "loaded work item did not match the requested id");
  }
  if (typeof workItem.title !== "string" || workItem.title.trim() === "") {
    throw new WorkRunError("load_work_item", "loaded work item has no authoritative title");
  }

  const summary = object(workItem.contractSummary);
  if (!summary || summary.classification !== "bounded") {
    throw new WorkRunError("load_work_item", "work item is not a bounded contract");
  }
  if (summary.profile !== "coding" && summary.profile !== "read_only") {
    throw new WorkRunError("load_work_item", "bounded work item has an unsupported profile");
  }

  const scope = object(workItem.writeScope);
  const include = stringArray(scope?.include);
  const exclude = stringArray(scope?.exclude);
  if (!include || !exclude) {
    throw new WorkRunError("load_work_item", "work item has an invalid normalized write scope");
  }

  const contract: MergeMasterWorkIdentity["contract"] = {
    classification: "bounded",
    profile: summary.profile,
  };
  if (summary.version !== undefined) {
    if (
      typeof summary.version !== "number"
      || !Number.isInteger(summary.version)
      || summary.version < 1
    ) {
      throw new WorkRunError("load_work_item", "bounded work item has an invalid contract version");
    }
    contract.version = summary.version;
  }

  return {
    identity: {
      workItemId: requestedWorkItemId,
      title: workItem.title,
      contract,
      plan: {planId: "", planVersion: 0, state: "active"},
      writeScope: {include, exclude},
    },
    accessMode: summary.profile === "coding" ? "read_write" : "read_only",
  };
}

function attachPlan(
  identity: MergeMasterWorkIdentity,
  response: ApiResponse,
): MergeMasterWorkIdentity {
  const data = responseData(response, "load_plan", "load verification plan");
  const plan = object(data.plan);
  if (
    !plan
    || typeof plan.id !== "string"
    || plan.id.length === 0
    || plan.workItemId !== identity.workItemId
    || typeof plan.version !== "number"
    || !Number.isInteger(plan.version)
    || plan.version < 1
    || plan.state !== "active"
  ) {
    throw new WorkRunError("load_plan", "work item has no matching active verification plan");
  }
  return {
    ...identity,
    plan: {planId: plan.id, planVersion: plan.version, state: "active"},
  };
}

function claimToken(
  requestedWorkItemId: string,
  response: ApiResponse,
): string {
  const data = responseData(response, "claim", "claim work item");
  const workItem = object(data.workItem);
  if (
    !workItem
    || workItem.id !== requestedWorkItemId
    || typeof workItem.claimToken !== "string"
    || workItem.claimToken.length === 0
  ) {
    throw new WorkRunError("claim", "claim work item returned no matching opaque lease");
  }
  return workItem.claimToken;
}

function assertTransition(
  requestedWorkItemId: string,
  response: ApiResponse,
  stage: "start" | "persist",
  label: string,
  expectedStatus?: string,
): void {
  const data = responseData(response, stage, label);
  const workItem = object(data.workItem);
  if (!workItem || workItem.id !== requestedWorkItemId) {
    throw new WorkRunError(stage, `${label} returned a different work item`, true);
  }
  if (expectedStatus !== undefined && workItem.status !== expectedStatus) {
    throw new WorkRunError(stage, `${label} did not confirm ${expectedStatus}`, true);
  }
}

async function startOrConfirmRunning(input: {
  client: WorkRunClient;
  workItemId: string;
  claimOwner: string;
  claimToken: string;
  leaseSeconds: number;
  label: string;
  timeoutMs: number;
}): Promise<void> {
  let startError: unknown;
  try {
    assertTransition(
      input.workItemId,
      await withDeadline(
        (signal) => input.client.transitionWorkItem(input.workItemId, "start", {
            claimOwner: input.claimOwner,
            claimToken: input.claimToken,
            leaseSeconds: input.leaseSeconds,
          }, {signal}),
        input.timeoutMs,
        `${input.label} timed out`,
      ),
      "start",
      input.label,
      "running",
    );
    return;
  } catch (error) {
    startError = error;
  }

  try {
    assertTransition(
      input.workItemId,
      await withDeadline(
        (signal) => input.client.transitionWorkItem(input.workItemId, "heartbeat", {
            claimOwner: input.claimOwner,
            claimToken: input.claimToken,
            leaseSeconds: input.leaseSeconds,
          }, {signal}),
        input.timeoutMs,
        `${input.label} confirmation timed out`,
      ),
      "start",
      `${input.label} confirmation`,
      "running",
    );
  } catch {
    throw startError;
  }
}

async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new WorkRunError("start", message, true));
        }, Math.max(1, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeRecord(record: ChildSessionRecoveryRecord): SafeChildSessionRecoveryRecord {
  const {credentials: _credentials, ...safe} = record;
  return safe;
}

function errorReason(error: unknown, secrets: string[] = []): string {
  let reason = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) reason = reason.split(secret).join("[REDACTED]");
  }
  return reason;
}

function stringArraysMatch(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function workIdentitiesMatch(
  left: MergeMasterWorkIdentity,
  right: MergeMasterWorkIdentity,
): boolean {
  return left.workItemId === right.workItemId
    && left.title === right.title
    && left.contract.classification === right.contract.classification
    && left.contract.profile === right.contract.profile
    && left.contract.version === right.contract.version
    && left.plan.planId === right.plan.planId
    && left.plan.planVersion === right.plan.planVersion
    && left.plan.state === right.plan.state
    && stringArraysMatch(left.writeScope.include, right.writeScope.include)
    && stringArraysMatch(left.writeScope.exclude, right.writeScope.exclude);
}

function identityMatches(record: ActiveChildSessionRecoveryRecord): boolean {
  const expectedAccessMode: MergeMasterAccessMode = record.work.contract.profile === "coding"
    ? "read_write"
    : "read_only";
  return record.session.work !== undefined
    && workIdentitiesMatch(record.session.work, record.work)
    && record.session.work.workItemId === record.work.workItemId
    && record.session.title === record.work.title
    && record.session.accessMode === expectedAccessMode
    && stringArraysMatch(record.session.writeScope, record.work.writeScope.include)
    && record.launch.repoRoot === record.session.repoRoot
    && record.launch.baseBranch === record.session.baseBranch
    && record.launch.baseCommit === record.session.baseCommit
    && record.launch.branch === record.session.branch
    && record.launch.worktreePath === record.session.worktreePath
    && record.launch.conversationKey === record.session.conversationKey
    && record.launch.accessMode === record.session.accessMode
    && stringArraysMatch(record.launch.writeScope, record.session.writeScope)
    && record.work.contract.classification === "bounded"
    && record.work.plan.state === "active";
}

export function createWorkRunController(
  options: WorkRunControllerOptions,
): WorkRunController {
  const leaseSeconds = options.leaseSeconds ?? 1800;
  const leaseMs = leaseSeconds * 1_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs
    ?? Math.max(10_000, Math.floor(leaseMs / 3));
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs
    ?? Math.max(1_000, Math.floor(leaseMs / 6));
  const now = options.now ?? Date.now;
  const makeOwner = options.ownerFactory
    ?? (() => `sift-tui:${hostname()}:${process.pid}:${randomUUID()}`);
  const admit = options.evaluateAdmission ?? evaluateChildAdmission;

  type ActiveRun = {
    record: ActiveChildSessionRecoveryRecord;
    lock: ChildSessionRunLock;
    leaseExpiresAtMs: number;
    timer?: ReturnType<typeof setTimeout>;
    heartbeatRunning: boolean;
  };
  const activeRuns = new Map<string, ActiveRun>();

  function noCompensation(): CompensationResult {
    return {attempted: [], failures: []};
  }

  function retryable(error: unknown): boolean {
    return error instanceof WorkRunError && error.retryable;
  }

  async function releaseLease(record: ChildSessionRecoveryRecord): Promise<void> {
    let transitionError: unknown;
    try {
      const response = await withDeadline(
        (signal) => options.client.transitionWorkItem(record.work.workItemId, "release", {
          claimOwner: record.credentials.claimOwner,
          claimToken: record.credentials.claimToken,
        }, {signal}),
        heartbeatTimeoutMs,
        "release work item timed out",
      );
      const data = responseData(response, "start", "release work item");
      const workItem = object(data.workItem);
      if (!workItem || workItem.id !== record.work.workItemId || workItem.status !== "queued") {
        throw new WorkRunError("start", "release work item did not confirm queued", true);
      }
      return;
    } catch (error) {
      transitionError = error;
    }

    try {
      const data = responseData(
        await withDeadline(
          () => options.client.getWorkItem(record.work.workItemId),
          heartbeatTimeoutMs,
          "confirm released work item timed out",
        ),
        "start",
        "confirm released work item",
      );
      const workItem = object(data.workItem);
      if (workItem?.id === record.work.workItemId && workItem.status === "queued") return;
    } catch {
      // Preserve the transition failure, which is the primary operation.
    }
    throw transitionError;
  }

  async function resumeCleanup(
    record: Extract<ChildSessionRecoveryRecord, {phase: "cleanup_pending"}>,
  ): Promise<CompensationResult> {
    const result: CompensationResult = {attempted: ["metadata"], failures: []};
    const secrets = [record.credentials.claimOwner, record.credentials.claimToken];
    let pending = record;

    if (pending.cleanup.worktree) {
      result.attempted.push("worktree");
      if (!pending.session) {
        pending = {...pending, cleanup: {...pending.cleanup, worktree: false}};
      } else {
        const removed = options.childController.teardownChild(pending.session);
        if (!removed.ok) {
          result.failures.push({
            step: "worktree",
            reason: errorReason(removed.reason ?? "cleanup failed", secrets),
          });
          return result;
        }
        pending = {...pending, cleanup: {...pending.cleanup, worktree: false}};
      }
      try {
        await options.store.put(pending);
      } catch (error) {
        result.failures.push({step: "metadata", reason: errorReason(error, secrets)});
        return result;
      }
    }

    if (pending.cleanup.lease) {
      result.attempted.push("lease");
      try {
        await releaseLease(pending);
      } catch (error) {
        result.failures.push({step: "lease", reason: errorReason(error, secrets)});
        return result;
      }
      pending = {...pending, cleanup: {...pending.cleanup, lease: false}};
      try {
        await options.store.put(pending);
      } catch (error) {
        result.failures.push({step: "metadata", reason: errorReason(error, secrets)});
        return result;
      }
    }

    try {
      await options.store.remove(pending.runId);
    } catch (error) {
      result.failures.push({step: "metadata", reason: errorReason(error, secrets)});
    }
    return result;
  }

  async function compensate(
    record: ChildSessionRecoveryRecord,
    input: {session?: ChildSessionRecord; worktreeCleanupFailure?: string} = {},
  ): Promise<CompensationResult> {
    const pending: Extract<ChildSessionRecoveryRecord, {phase: "cleanup_pending"}> = {
      ...record,
      phase: "cleanup_pending",
      session: input.session ?? record.session,
      cleanup: {
        worktree: Boolean(input.session ?? record.session),
        lease: true,
      },
    };
    const secrets = [record.credentials.claimOwner, record.credentials.claimToken];
    try {
      await options.store.put(pending);
    } catch (error) {
      return {
        attempted: ["metadata"],
        failures: [{step: "metadata", reason: errorReason(error, secrets)}],
      };
    }
    if (input.worktreeCleanupFailure) {
      return {
        attempted: ["metadata", "worktree"],
        failures: [{
          step: "worktree",
          reason: errorReason(input.worktreeCleanupFailure, secrets),
        }],
      };
    }
    return await resumeCleanup(pending);
  }

  async function quarantine(
    record: ActiveChildSessionRecoveryRecord,
    lock: ChildSessionRunLock,
    reason: string,
  ): Promise<void> {
    const active = activeRuns.get(record.runId);
    if (active?.timer) clearTimeout(active.timer);
    activeRuns.delete(record.runId);
    const redactedReason = errorReason(reason, [
      record.credentials.claimOwner,
      record.credentials.claimToken,
    ]);
    try {
      await options.store.put({
        ...record,
        phase: "quarantined",
        quarantineReason: redactedReason,
      });
    } catch (error) {
      options.onLeaseFailure?.({
        runId: record.runId,
        reason: `${redactedReason}; quarantine persistence failed: ${errorReason(error)}`,
      });
      // Keep the lock held. Without a durable quarantine marker, allowing a
      // second process to recover this run would violate single ownership.
      return;
    }
    options.childController.abandonChild(record.session.sessionId);
    await lock.release();
    options.onLeaseFailure?.({runId: record.runId, reason: redactedReason});
  }

  async function heartbeatOnce(active: ActiveRun): Promise<void> {
    const remainingMs = active.leaseExpiresAtMs - now();
    const timeoutMs = Math.max(1, Math.min(heartbeatTimeoutMs, remainingMs - 1_000));
    if (remainingMs <= 1_000) {
      throw new WorkRunError("start", "lease expired before heartbeat could start");
    }
    assertTransition(
      active.record.work.workItemId,
      await withDeadline(
        (signal) => options.client.transitionWorkItem(active.record.work.workItemId, "heartbeat", {
            claimOwner: active.record.credentials.claimOwner,
            claimToken: active.record.credentials.claimToken,
            leaseSeconds,
          }, {signal}),
        timeoutMs,
        "lease heartbeat timed out",
      ),
      "start",
      "lease heartbeat",
      "running",
    );
    active.leaseExpiresAtMs = now() + leaseMs;
    await options.store.put(active.record);
  }

  function maintainLease(
    record: ActiveChildSessionRecoveryRecord,
    lock: ChildSessionRunLock,
  ): void {
    const active: ActiveRun = {
      record,
      lock,
      leaseExpiresAtMs: now() + leaseMs,
      heartbeatRunning: false,
    };
    activeRuns.set(record.runId, active);

    const schedule = (delayMs: number) => {
      active.timer = setTimeout(async () => {
        if (activeRuns.get(record.runId) !== active || active.heartbeatRunning) return;
        active.heartbeatRunning = true;
        try {
          await heartbeatOnce(active);
          active.heartbeatRunning = false;
          schedule(heartbeatIntervalMs);
        } catch (error) {
          active.heartbeatRunning = false;
          const remainingMs = active.leaseExpiresAtMs - now();
          if (retryable(error) && remainingMs > 1_000) {
            schedule(Math.max(100, Math.min(5_000, Math.floor(remainingMs / 4))));
            return;
          }
          await quarantine(record, lock, errorReason(error));
        }
      }, Math.max(1, delayMs));
      active.timer.unref?.();
    };
    schedule(heartbeatIntervalMs);
  }

  async function startContractedWork(workItemId: string): Promise<StartContractedWorkResult> {
    const empty = noCompensation();
    let identity: MergeMasterWorkIdentity;
    let accessMode: MergeMasterAccessMode;
    try {
      const loaded = parseWorkIdentity(
        workItemId,
        await options.client.getWorkItem(workItemId),
      );
      identity = attachPlan(
        loaded.identity,
        await options.client.getWorkVerificationPlan(workItemId),
      );
      accessMode = loaded.accessMode;
    } catch (error) {
      const stage = error instanceof WorkRunError ? error.stage : "load_work_item";
      return {ok: false, stage, reason: errorReason(error), compensation: empty};
    }

    const admission = admit({accessMode, writeScope: identity.writeScope.include});
    if (admission.admit === false) {
      return {
        ok: false,
        stage: "admission",
        reason: admission.reason,
        blockedBy: admission.conflictSessionId,
        sharedScope: admission.sharedScope,
        compensation: empty,
      };
    }

    let launch: ChildSessionLaunch;
    try {
      launch = options.childController.resolveLaunch({
        title: identity.title,
        accessMode,
        writeScope: identity.writeScope.include,
        cwd: options.cwd,
        baseBranch: options.baseBranch,
        work: identity,
      });
    } catch (error) {
      return {ok: false, stage: "spawn", reason: errorReason(error), compensation: empty};
    }
    const runId = options.store.runIdFor(launch.repoRoot, workItemId);
    const lock = await options.store.acquire(runId);
    if (!lock) {
      return {
        ok: false,
        stage: "persist",
        reason: "work session is already owned by another process",
        compensation: empty,
      };
    }

    try {
      if (await options.store.get(runId)) {
        await lock.release();
        return {
          ok: false,
          stage: "persist",
          reason: "work session already exists; recover or clean it before starting again",
          compensation: empty,
        };
      }
    } catch (error) {
      await lock.release();
      return {ok: false, stage: "persist", reason: errorReason(error), compensation: empty};
    }

    const claimOwner = makeOwner();
    let token: string;
    try {
      token = claimToken(
        workItemId,
        await options.client.claimWorkItem({workItemId, claimOwner, leaseSeconds}),
      );
    } catch (error) {
      await lock.release();
      return {
        ok: false,
        stage: "claim",
        reason: errorReason(error, [claimOwner]),
        compensation: empty,
      };
    }

    const claimed: ChildSessionRecoveryRecord = {
      runId,
      phase: "claimed",
      updatedAtMs: 0,
      work: identity,
      launch: {
        repoRoot: launch.repoRoot,
        baseBranch: launch.baseBranch,
        baseCommit: launch.baseCommit,
        seed: launch.seed,
        branch: launch.branch,
        worktreePath: launch.worktreePath,
        conversationKey: launch.conversationKey,
        accessMode,
        writeScope: [...identity.writeScope.include],
      },
      credentials: {claimOwner, claimToken: token},
    };
    try {
      await options.store.putExclusive(claimed);
    } catch (error) {
      const compensation: CompensationResult = {attempted: ["lease"], failures: []};
      try {
        await releaseLease(claimed);
      } catch (releaseError) {
        compensation.failures.push({
          step: "lease",
          reason: errorReason(releaseError, [claimOwner, token]),
        });
      }
      await lock.release();
      return {
        ok: false,
        stage: "persist",
        reason: errorReason(error, [claimOwner, token]),
        compensation,
      };
    }

    let spawned: SpawnChildResult;
    try {
      spawned = options.childController.spawnOrAdoptChild({
        title: identity.title,
        accessMode,
        writeScope: identity.writeScope.include,
        baseBranch: launch.baseBranch,
        cwd: launch.repoRoot,
        work: identity,
      }, launch);
    } catch (error) {
      const cleanup = object(error);
      const compensation = await compensate(claimed, {
        worktreeCleanupFailure: typeof cleanup?.cleanupFailure === "string"
          ? cleanup.cleanupFailure
          : undefined,
      });
      await lock.release();
      return {
        ok: false,
        stage: "spawn",
        reason: errorReason(error, [claimOwner, token]),
        compensation,
      };
    }
    if (spawned.ok === false) {
      const compensation = await compensate(claimed, {
        worktreeCleanupFailure: spawned.cleanupFailure,
      });
      await lock.release();
      return {
        ok: false,
        stage: "spawn",
        reason: spawned.reason,
        blockedBy: spawned.blockedBy,
        sharedScope: spawned.sharedScope,
        compensation,
      };
    }

    let record: ActiveChildSessionRecoveryRecord = {
      ...claimed,
      phase: "spawned",
      session: spawned.session,
    };
    try {
      await options.store.put(record);
    } catch (error) {
      const compensation = await compensate(claimed, {session: spawned.session});
      await lock.release();
      return {
        ok: false,
        stage: "persist",
        reason: errorReason(error, [claimOwner, token]),
        compensation,
      };
    }

    try {
      await startOrConfirmRunning({
        client: options.client,
        workItemId,
        claimOwner,
        claimToken: token,
        leaseSeconds,
        label: "start work item",
        timeoutMs: heartbeatTimeoutMs,
      });
    } catch (error) {
      if (retryable(error)) {
        await quarantine(record, lock, errorReason(error, [claimOwner, token]));
        return {
          ok: false,
          stage: "start",
          reason: errorReason(error, [claimOwner, token]),
          compensation: empty,
        };
      }
      const compensation = await compensate(record, {session: spawned.session});
      await lock.release();
      return {
        ok: false,
        stage: "start",
        reason: errorReason(error, [claimOwner, token]),
        compensation,
      };
    }

    record = {...record, phase: "started"};
    try {
      await options.store.put(record);
    } catch (error) {
      const compensation = await compensate(record, {session: spawned.session});
      await lock.release();
      return {
        ok: false,
        stage: "persist",
        reason: errorReason(error, [claimOwner, token]),
        compensation,
      };
    }
    maintainLease(record, lock);
    return {ok: true, run: safeRecord(record)};
  }

  async function recoverWorkRuns(): Promise<WorkRunRecoveryResult> {
    let loaded;
    try {
      loaded = await options.store.loadAll();
    } catch (error) {
      return {recovered: [], failed: [{reason: errorReason(error)}]};
    }

    const result: WorkRunRecoveryResult = {
      recovered: [],
      failed: loaded.failures.map((failure) => ({
        runId: failure.runId,
        reason: failure.reason,
      })),
    };

    for (const stored of loaded.records) {
      if (
        options.store.runIdFor(stored.launch.repoRoot, stored.work.workItemId)
        !== stored.runId
      ) {
        result.failed.push({
          runId: stored.runId,
          reason: "stored work-session recovery id does not match its repo and work item",
        });
        continue;
      }
      const lock = await options.store.acquire(stored.runId);
      if (!lock) {
        result.failed.push({
          runId: stored.runId,
          reason: "work session is already owned by another process",
        });
        continue;
      }
      if (stored.phase === "quarantined") {
        result.failed.push({runId: stored.runId, reason: stored.quarantineReason});
        await lock.release();
        continue;
      }
      if (stored.phase === "cleanup_pending") {
        const compensation = await resumeCleanup(stored);
        if (compensation.failures.length > 0) {
          result.failed.push({
            runId: stored.runId,
            reason: "work session cleanup remains pending",
            compensation,
          });
        }
        await lock.release();
        continue;
      }

      let record: ActiveChildSessionRecoveryRecord;
      if (stored.phase === "claimed") {
        const spawned = options.childController.spawnOrAdoptChild({
          title: stored.work.title,
          accessMode: stored.launch.accessMode,
          writeScope: stored.launch.writeScope,
          baseBranch: stored.launch.baseBranch,
          cwd: stored.launch.repoRoot,
          work: stored.work,
        }, stored.launch);
        if (!spawned.ok) {
          const compensation = await compensate(stored, {
            worktreeCleanupFailure: spawned.cleanupFailure,
          });
          result.failed.push({
            runId: stored.runId,
            reason: spawned.reason,
            compensation,
          });
          await lock.release();
          continue;
        }
        record = {...stored, phase: "spawned", session: spawned.session};
        try {
          await options.store.put(record);
        } catch (error) {
          const compensation = await compensate(stored, {session: spawned.session});
          result.failed.push({
            runId: stored.runId,
            reason: errorReason(error),
            compensation,
          });
          await lock.release();
          continue;
        }
      } else {
        record = stored;
        if (!identityMatches(record)) {
          result.failed.push({
            runId: record.runId,
            reason: "stored work identity does not match the child session",
          });
          await lock.release();
          continue;
        }
        let adopted: SpawnChildResult;
        try {
          adopted = options.childController.adoptChild(record.session);
        } catch (error) {
          result.failed.push({runId: record.runId, reason: errorReason(error, [
            record.credentials.claimOwner,
            record.credentials.claimToken,
          ])});
          await lock.release();
          continue;
        }
        if (!adopted.ok) {
          result.failed.push({runId: record.runId, reason: adopted.reason});
          await lock.release();
          continue;
        }
        record = {...record, session: adopted.session};
      }

      try {
        if (record.phase === "started") {
          assertTransition(
            record.work.workItemId,
            await withDeadline(
              (signal) => options.client.transitionWorkItem(record.work.workItemId, "heartbeat", {
                  claimOwner: record.credentials.claimOwner,
                  claimToken: record.credentials.claimToken,
                  leaseSeconds,
                }, {signal}),
              heartbeatTimeoutMs,
              "recover heartbeat timed out",
            ),
            "start",
            "recover heartbeat",
            "running",
          );
        } else {
          await options.store.put(record);
          await startOrConfirmRunning({
            client: options.client,
            workItemId: record.work.workItemId,
            claimOwner: record.credentials.claimOwner,
            claimToken: record.credentials.claimToken,
            leaseSeconds,
            label: "recover start work item",
            timeoutMs: heartbeatTimeoutMs,
          });
          record = {...record, phase: "started"};
        }
        await options.store.put(record);
        result.recovered.push(safeRecord(record));
        maintainLease(record, lock);
      } catch (error) {
        const reason = errorReason(error, [
          record.credentials.claimOwner,
          record.credentials.claimToken,
        ]);
        await quarantine(record, lock, reason);
        result.failed.push({runId: record.runId, reason});
      }
    }
    return result;
  }

  async function shutdown(input: {preserveRuns?: boolean} = {}): Promise<void> {
    for (const active of [...activeRuns.values()]) {
      if (active.timer) clearTimeout(active.timer);
      if (input.preserveRuns) {
        activeRuns.delete(active.record.runId);
        await active.lock.release();
        continue;
      }
      await quarantine(active.record, active.lock, "work-run controller shut down");
    }
  }

  return {startContractedWork, recoverWorkRuns, shutdown};
}

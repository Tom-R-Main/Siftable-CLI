import {randomUUID} from "node:crypto";
import {hostname} from "node:os";
import type {
  ChildSessionController,
  ChildSessionRecord,
  SpawnChildResult,
} from "./childSessionController";
import type {
  ChildSessionRecoveryRecord,
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
  ): Promise<ApiResponse>;
}

export interface WorkRunControllerOptions {
  client: WorkRunClient;
  childController: Pick<ChildSessionController, "spawnChild" | "adoptChild" | "removeChild">;
  store: ChildSessionStore;
  cwd?: string;
  baseBranch?: string;
  leaseSeconds?: number;
  ownerFactory?: () => string;
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
    throw new WorkRunError(stage, `${label} failed${status}`);
  }
  const data = object(response.data);
  if (!data) throw new WorkRunError(stage, `${label} returned no data`);
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
  if (typeof summary.version === "number") contract.version = summary.version;

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

function isDefinitiveClaimRejection(response: ApiResponse): boolean {
  return typeof response.statusCode === "number"
    && response.statusCode >= 400
    && response.statusCode < 500;
}

function assertTransition(
  requestedWorkItemId: string,
  response: ApiResponse,
  stage: "start" | "persist",
  label: string,
): void {
  const data = responseData(response, stage, label);
  const workItem = object(data.workItem);
  if (!workItem || workItem.id !== requestedWorkItemId) {
    throw new WorkRunError(stage, `${label} returned a different work item`);
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

function identityMatches(record: ChildSessionRecoveryRecord): boolean {
  return record.session.work !== undefined
    && workIdentitiesMatch(record.session.work, record.work)
    && record.session.work.workItemId === record.work.workItemId
    && record.work.contract.classification === "bounded"
    && record.work.plan.state === "active";
}

export function createWorkRunController(
  options: WorkRunControllerOptions,
): WorkRunController {
  const leaseSeconds = options.leaseSeconds ?? 1800;
  const makeOwner = options.ownerFactory
    ?? (() => `sift-tui:${hostname()}:${process.pid}:${randomUUID()}`);
  const admit = options.evaluateAdmission ?? evaluateChildAdmission;

  async function releaseLease(
    workItemId: string,
    claimOwner: string,
    token: string,
  ): Promise<void> {
    const response = await options.client.transitionWorkItem(workItemId, "release", {
      claimOwner,
      claimToken: token,
    });
    const data = responseData(response, "start", "release work item");
    const workItem = object(data.workItem);
    if (!workItem || workItem.id !== workItemId) {
      throw new Error("release work item returned a different work item");
    }
  }

  async function compensate(input: {
    runId?: string;
    sessionId?: number;
    workItemId: string;
    claimOwner: string;
    claimToken: string;
    metadataMayExist: boolean;
  }): Promise<CompensationResult> {
    const result: CompensationResult = {attempted: [], failures: []};
    const secrets = [input.claimOwner, input.claimToken];
    if (input.metadataMayExist && input.runId) {
      result.attempted.push("metadata");
      try {
        await options.store.remove(input.runId);
      } catch (error) {
        result.failures.push({step: "metadata", reason: errorReason(error, secrets)});
      }
    }
    if (input.sessionId !== undefined) {
      result.attempted.push("worktree");
      const removed = options.childController.removeChild(input.sessionId, {
        deleteBranch: true,
        force: true,
      });
      if (!removed.ok) {
        result.failures.push({step: "worktree", reason: errorReason(removed.reason ?? "cleanup failed", secrets)});
      }
    }
    result.attempted.push("lease");
    try {
      await releaseLease(input.workItemId, input.claimOwner, input.claimToken);
    } catch (error) {
      result.failures.push({step: "lease", reason: errorReason(error, secrets)});
    }
    return result;
  }

  async function startContractedWork(workItemId: string): Promise<StartContractedWorkResult> {
    const noCompensation: CompensationResult = {attempted: [], failures: []};
    let identity: MergeMasterWorkIdentity;
    let accessMode: MergeMasterAccessMode;
    try {
      const loaded = parseWorkIdentity(
        workItemId,
        await options.client.getWorkItem(workItemId),
      );
      identity = loaded.identity;
      accessMode = loaded.accessMode;
      identity = attachPlan(
        identity,
        await options.client.getWorkVerificationPlan(workItemId),
      );
    } catch (error) {
      const stage = error instanceof WorkRunError ? error.stage : "load_work_item";
      return {ok: false, stage, reason: errorReason(error), compensation: noCompensation};
    }

    const admission = admit({
      accessMode,
      writeScope: identity.writeScope.include,
    });
    if (admission.admit === false) {
      return {
        ok: false,
        stage: "admission",
        reason: admission.reason,
        blockedBy: admission.conflictSessionId,
        sharedScope: admission.sharedScope,
        compensation: noCompensation,
      };
    }

    const claimOwner = makeOwner();
    let token: string;
    try {
      let lastError: unknown;
      token = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        let response: ApiResponse;
        try {
          response = await options.client.claimWorkItem({
            workItemId,
            claimOwner,
            leaseSeconds,
          });
        } catch (error) {
          lastError = error;
          continue;
        }
        try {
          token = claimToken(workItemId, response);
          break;
        } catch (error) {
          lastError = error;
          if (isDefinitiveClaimRejection(response)) break;
        }
      }
      if (!token) throw lastError ?? new WorkRunError("claim", "claim work item returned no lease");
    } catch (error) {
      return {
        ok: false,
        stage: "claim",
        reason: errorReason(error, [claimOwner]),
        compensation: noCompensation,
      };
    }

    let spawned: SpawnChildResult;
    try {
      spawned = options.childController.spawnChild({
        title: identity.title,
        accessMode,
        writeScope: identity.writeScope.include,
        baseBranch: options.baseBranch,
        cwd: options.cwd,
        work: identity,
      });
    } catch (error) {
      const compensation = await compensate({
        workItemId,
        claimOwner,
        claimToken: token,
        metadataMayExist: false,
      });
      const cleanup = object(error);
      if (cleanup?.worktreeCleanupAttempted === true) {
        compensation.attempted.unshift("worktree");
        if (typeof cleanup.cleanupFailure === "string") {
          compensation.failures.unshift({
            step: "worktree",
            reason: errorReason(cleanup.cleanupFailure, [claimOwner, token]),
          });
        }
      }
      return {
        ok: false,
        stage: "spawn",
        reason: errorReason(error, [claimOwner, token]),
        compensation,
      };
    }
    if (spawned.ok === false) {
      const compensation = await compensate({
        workItemId,
        claimOwner,
        claimToken: token,
        metadataMayExist: false,
      });
      if (spawned.worktreeCleanupAttempted) {
        compensation.attempted.unshift("worktree");
        if (spawned.cleanupFailure) {
          compensation.failures.unshift({
            step: "worktree",
            reason: errorReason(spawned.cleanupFailure, [claimOwner, token]),
          });
        }
      }
      return {
        ok: false,
        stage: "spawn",
        reason: spawned.reason,
        blockedBy: spawned.blockedBy,
        sharedScope: spawned.sharedScope,
        compensation,
      };
    }

    const runId = options.store.runIdFor(spawned.session.repoRoot, workItemId);
    let record: ChildSessionRecoveryRecord = {
      runId,
      phase: "spawned",
      updatedAtMs: 0,
      work: identity,
      session: spawned.session,
      credentials: {claimOwner, claimToken: token},
    };
    try {
      await options.store.put(record);
    } catch (error) {
      const compensation = await compensate({
        runId,
        sessionId: spawned.session.sessionId,
        workItemId,
        claimOwner,
        claimToken: token,
        metadataMayExist: true,
      });
      return {
        ok: false,
        stage: "persist",
        reason: errorReason(error, [claimOwner, token]),
        compensation,
      };
    }

    try {
      assertTransition(
        workItemId,
        await options.client.transitionWorkItem(workItemId, "start", {
          claimOwner,
          claimToken: token,
          leaseSeconds,
        }),
        "start",
        "start work item",
      );
    } catch (error) {
      const compensation = await compensate({
        runId,
        sessionId: spawned.session.sessionId,
        workItemId,
        claimOwner,
        claimToken: token,
        metadataMayExist: true,
      });
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
      const compensation = await compensate({
        runId,
        sessionId: spawned.session.sessionId,
        workItemId,
        claimOwner,
        claimToken: token,
        metadataMayExist: true,
      });
      return {
        ok: false,
        stage: "persist",
        reason: errorReason(error, [claimOwner, token]),
        compensation,
      };
    }
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
    for (const record of loaded.records) {
      const secrets = [record.credentials.claimOwner, record.credentials.claimToken];
      if (!identityMatches(record)) {
        result.failed.push({runId: record.runId, reason: "stored work identity does not match the child session"});
        continue;
      }

      let adopted: SpawnChildResult;
      try {
        adopted = options.childController.adoptChild(record.session);
      } catch (error) {
        result.failed.push({runId: record.runId, reason: errorReason(error, secrets)});
        continue;
      }
      if (adopted.ok === false) {
        result.failed.push({runId: record.runId, reason: adopted.reason});
        continue;
      }
      let recovered: ChildSessionRecoveryRecord = {...record, session: adopted.session};
      if (record.phase === "started") {
        try {
          await options.store.put(recovered);
          result.recovered.push(safeRecord(recovered));
        } catch (error) {
          result.failed.push({runId: record.runId, reason: errorReason(error, secrets)});
        }
        continue;
      }

      try {
        await options.store.put(recovered);
        assertTransition(
          record.work.workItemId,
          await options.client.transitionWorkItem(record.work.workItemId, "start", {
            claimOwner: record.credentials.claimOwner,
            claimToken: record.credentials.claimToken,
            leaseSeconds,
          }),
          "start",
          "recover start work item",
        );
        recovered = {...recovered, phase: "started"};
        await options.store.put(recovered);
        result.recovered.push(safeRecord(recovered));
      } catch (error) {
        const compensation = await compensate({
          runId: record.runId,
          sessionId: adopted.session.sessionId,
          workItemId: record.work.workItemId,
          claimOwner: record.credentials.claimOwner,
          claimToken: record.credentials.claimToken,
          metadataMayExist: true,
        });
        result.failed.push({
          runId: record.runId,
          reason: errorReason(error, secrets),
          compensation,
        });
      }
    }
    return result;
  }

  return {startContractedWork, recoverWorkRuns};
}

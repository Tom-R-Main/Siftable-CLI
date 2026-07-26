import {createHash, randomUUID} from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import type {FileHandle} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import type {ChildSessionRecord} from "./childSessionController";
import type {MergeMasterWorkIdentity} from "./mergeMaster";

export type ChildSessionRecoveryPhase = "spawned" | "started";

export interface ChildSessionRecoveryRecord {
  runId: string;
  phase: ChildSessionRecoveryPhase;
  updatedAtMs: number;
  work: MergeMasterWorkIdentity;
  session: ChildSessionRecord;
  credentials: {
    claimOwner: string;
    claimToken: string;
  };
}

export type SafeChildSessionRecoveryRecord = Omit<ChildSessionRecoveryRecord, "credentials">;

export interface ChildSessionRecoveryLoadFailure {
  /** Non-secret hash derived from the recovery filename. */
  runId: string;
  reason: string;
}

export interface ChildSessionRecoveryLoadResult {
  records: ChildSessionRecoveryRecord[];
  failures: ChildSessionRecoveryLoadFailure[];
}

export interface ChildSessionStore {
  runIdFor(repoRoot: string, workItemId: string): string;
  put(record: ChildSessionRecoveryRecord): Promise<void>;
  remove(runId: string): Promise<void>;
  loadAll(): Promise<ChildSessionRecoveryLoadResult>;
  listSafe(): Promise<SafeChildSessionRecoveryRecord[]>;
}

export interface ChildSessionStoreOptions {
  root?: string;
  now?: () => number;
}

const RUN_ID = /^[a-f0-9]{64}$/;

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error("invalid work-session recovery id");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isWorkIdentity(value: unknown): value is MergeMasterWorkIdentity {
  const identity = object(value);
  const contract = object(identity?.contract);
  const plan = object(identity?.plan);
  const writeScope = object(identity?.writeScope);
  return typeof identity?.workItemId === "string"
    && identity.workItemId.length > 0
    && typeof identity.title === "string"
    && identity.title.length > 0
    && contract?.classification === "bounded"
    && (contract.profile === "coding" || contract.profile === "read_only")
    && (
      contract.version === undefined
      || (
        typeof contract.version === "number"
        && Number.isInteger(contract.version)
        && contract.version >= 1
      )
    )
    && typeof plan?.planId === "string"
    && plan.planId.length > 0
    && typeof plan.planVersion === "number"
    && Number.isInteger(plan.planVersion)
    && plan.planVersion >= 1
    && plan.state === "active"
    && stringArray(writeScope?.include)
    && stringArray(writeScope.exclude);
}

function isChildSessionRecord(value: unknown): value is ChildSessionRecord {
  const session = object(value);
  return typeof session?.sessionId === "number"
    && Number.isInteger(session.sessionId)
    && session.sessionId > 0
    && typeof session.parentSessionId === "number"
    && Number.isInteger(session.parentSessionId)
    && session.parentSessionId > 0
    && typeof session.title === "string"
    && typeof session.repoRoot === "string"
    && session.repoRoot.length > 0
    && typeof session.branch === "string"
    && session.branch.length > 0
    && typeof session.baseBranch === "string"
    && session.baseBranch.length > 0
    && typeof session.worktreePath === "string"
    && session.worktreePath.length > 0
    && typeof session.sessionCwd === "string"
    && session.sessionCwd.length > 0
    && typeof session.baseCommit === "string"
    && typeof session.headCommit === "string"
    && (session.accessMode === "read_only" || session.accessMode === "read_write")
    && stringArray(session.writeScope)
    && typeof session.conversationKey === "string"
    && session.conversationKey.length > 0
    && isWorkIdentity(session.work);
}

function isRecord(value: unknown): value is ChildSessionRecoveryRecord {
  const record = object(value);
  const credentials = object(record?.credentials);
  return typeof record?.runId === "string"
    && RUN_ID.test(record.runId)
    && (record.phase === "spawned" || record.phase === "started")
    && typeof record.updatedAtMs === "number"
    && Number.isFinite(record.updatedAtMs)
    && isWorkIdentity(record.work)
    && isChildSessionRecord(record.session)
    && typeof credentials?.claimOwner === "string"
    && credentials.claimOwner.length > 0
    && typeof credentials.claimToken === "string"
    && credentials.claimToken.length > 0;
}

function safeRecord(record: ChildSessionRecoveryRecord): SafeChildSessionRecoveryRecord {
  const {credentials: _credentials, ...safe} = record;
  return {
    ...safe,
    work: {
      ...safe.work,
      contract: {...safe.work.contract},
      plan: {...safe.work.plan},
      writeScope: {
        include: [...safe.work.writeScope.include],
        exclude: [...safe.work.writeScope.exclude],
      },
    },
    session: {
      ...safe.session,
      writeScope: [...safe.session.writeScope],
      work: safe.session.work
        ? {
            ...safe.session.work,
            contract: {...safe.session.work.contract},
            plan: {...safe.session.work.plan},
            writeScope: {
              include: [...safe.session.work.writeScope.include],
              exclude: [...safe.session.work.writeScope.exclude],
            },
          }
        : undefined,
    },
  };
}

export function createChildSessionStore(
  options: ChildSessionStoreOptions = {},
): ChildSessionStore {
  const root = options.root ?? join(homedir(), ".siftable", "work-sessions");
  const now = options.now ?? Date.now;

  async function ensureRoot(): Promise<void> {
    await mkdir(root, {recursive: true, mode: 0o700});
    await chmod(root, 0o700);
  }

  function recordPath(runId: string): string {
    assertRunId(runId);
    return join(root, `${runId}.json`);
  }

  async function put(record: ChildSessionRecoveryRecord): Promise<void> {
    assertRunId(record.runId);
    await ensureRoot();
    const target = recordPath(record.runId);
    const temporary = join(root, `.${record.runId}.${process.pid}.${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      const persisted = {...record, updatedAtMs: now()};
      await handle.writeFile(JSON.stringify(persisted), {encoding: "utf8"});
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      await chmod(target, 0o600);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temporary, {force: true}).catch(() => undefined);
      throw error;
    }
  }

  async function remove(runId: string): Promise<void> {
    await rm(recordPath(runId), {force: true});
  }

  async function loadAll(): Promise<ChildSessionRecoveryLoadResult> {
    await ensureRoot();
    const names = (await readdir(root))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort();
    const records: ChildSessionRecoveryRecord[] = [];
    const failures: ChildSessionRecoveryLoadFailure[] = [];
    for (const name of names) {
      const fileRunId = name.slice(0, -".json".length);
      try {
        const parsed: unknown = JSON.parse(await readFile(join(root, name), "utf8"));
        if (!isRecord(parsed) || parsed.runId !== fileRunId) {
          failures.push({runId: fileRunId, reason: "invalid work-session recovery record"});
          continue;
        }
        records.push(parsed);
      } catch {
        failures.push({runId: fileRunId, reason: "invalid work-session recovery record"});
      }
    }
    return {records, failures};
  }

  return {
    runIdFor(repoRoot, workItemId) {
      return createHash("sha256").update(repoRoot).update("\0").update(workItemId).digest("hex");
    },
    put,
    remove,
    loadAll,
    async listSafe() {
      return (await loadAll()).records.map(safeRecord);
    },
  };
}

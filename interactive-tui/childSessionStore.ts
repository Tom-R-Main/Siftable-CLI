import {createHash, randomUUID} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import type {FileHandle, Stats} from "node:fs/promises";
import {homedir, hostname} from "node:os";
import {join} from "node:path";
import type {ChildSessionRecord} from "./childSessionController";
import type {MergeMasterAccessMode, MergeMasterWorkIdentity} from "./mergeMaster";

export type ChildSessionRecoveryPhase =
  | "claimed"
  | "spawned"
  | "started"
  | "cleanup_pending"
  | "quarantined";

export interface ChildSessionLaunchRecord {
  repoRoot: string;
  baseBranch: string;
  baseCommit: string;
  seed: string;
  branch: string;
  worktreePath: string;
  conversationKey: string;
  accessMode: MergeMasterAccessMode;
  writeScope: string[];
}

interface ChildSessionRecoveryBase {
  runId: string;
  updatedAtMs: number;
  work: MergeMasterWorkIdentity;
  launch: ChildSessionLaunchRecord;
  credentials: {
    claimOwner: string;
    claimToken: string;
  };
}

export interface ClaimedChildSessionRecoveryRecord extends ChildSessionRecoveryBase {
  phase: "claimed";
  session?: undefined;
}

export interface ActiveChildSessionRecoveryRecord extends ChildSessionRecoveryBase {
  phase: "spawned" | "started";
  session: ChildSessionRecord;
}

export interface CleanupPendingChildSessionRecoveryRecord extends ChildSessionRecoveryBase {
  phase: "cleanup_pending";
  session?: ChildSessionRecord;
  cleanup: {worktree: boolean; lease: boolean};
}

export interface QuarantinedChildSessionRecoveryRecord extends ChildSessionRecoveryBase {
  phase: "quarantined";
  session: ChildSessionRecord;
  quarantineReason: string;
}

export type ChildSessionRecoveryRecord =
  | ClaimedChildSessionRecoveryRecord
  | ActiveChildSessionRecoveryRecord
  | CleanupPendingChildSessionRecoveryRecord
  | QuarantinedChildSessionRecoveryRecord;

type WithoutCredentials<T> = T extends ChildSessionRecoveryRecord
  ? Omit<T, "credentials">
  : never;
export type SafeChildSessionRecoveryRecord = WithoutCredentials<ChildSessionRecoveryRecord>;

export interface ChildSessionRecoveryLoadFailure {
  /** Non-secret hash derived from the recovery filename. */
  runId: string;
  reason: string;
}

export interface ChildSessionRecoveryLoadResult {
  records: ChildSessionRecoveryRecord[];
  failures: ChildSessionRecoveryLoadFailure[];
}

export interface ChildSessionRunLock {
  release(): Promise<void>;
}

export interface ChildSessionStore {
  runIdFor(repoRoot: string, workItemId: string): string;
  put(record: ChildSessionRecoveryRecord): Promise<void>;
  putExclusive(record: ChildSessionRecoveryRecord): Promise<void>;
  get(runId: string): Promise<ChildSessionRecoveryRecord | undefined>;
  remove(runId: string): Promise<void>;
  acquire(runId: string): Promise<ChildSessionRunLock | undefined>;
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

function isLaunchRecord(value: unknown): value is ChildSessionLaunchRecord {
  const launch = object(value);
  return typeof launch?.repoRoot === "string"
    && launch.repoRoot.length > 0
    && typeof launch.baseBranch === "string"
    && launch.baseBranch.length > 0
    && typeof launch.baseCommit === "string"
    && launch.baseCommit.length > 0
    && typeof launch.seed === "string"
    && launch.seed.length > 0
    && typeof launch.branch === "string"
    && launch.branch.length > 0
    && typeof launch.worktreePath === "string"
    && launch.worktreePath.length > 0
    && typeof launch.conversationKey === "string"
    && launch.conversationKey.length > 0
    && (launch.accessMode === "read_only" || launch.accessMode === "read_write")
    && stringArray(launch.writeScope);
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
  const common = typeof record?.runId === "string"
    && RUN_ID.test(record.runId)
    && typeof record.updatedAtMs === "number"
    && Number.isFinite(record.updatedAtMs)
    && isWorkIdentity(record.work)
    && isLaunchRecord(record.launch)
    && typeof credentials?.claimOwner === "string"
    && credentials.claimOwner.length > 0
    && typeof credentials.claimToken === "string"
    && credentials.claimToken.length > 0;
  if (!common) return false;
  if (record.phase === "claimed") return record.session === undefined;
  if (record.phase === "spawned" || record.phase === "started") {
    return isChildSessionRecord(record.session);
  }
  if (record.phase === "quarantined") {
    return isChildSessionRecord(record.session)
      && typeof record.quarantineReason === "string"
      && record.quarantineReason.length > 0;
  }
  const cleanup = object(record.cleanup);
  return record.phase === "cleanup_pending"
    && (record.session === undefined || isChildSessionRecord(record.session))
    && typeof cleanup?.worktree === "boolean"
    && typeof cleanup.lease === "boolean";
}

function cloneWorkIdentity(identity: MergeMasterWorkIdentity): MergeMasterWorkIdentity {
  return {
    ...identity,
    contract: {...identity.contract},
    plan: {...identity.plan},
    writeScope: {
      include: [...identity.writeScope.include],
      exclude: [...identity.writeScope.exclude],
    },
  };
}

function safeRecord(record: ChildSessionRecoveryRecord): SafeChildSessionRecoveryRecord {
  const {credentials: _credentials, ...safe} = record;
  return {
    ...safe,
    work: cloneWorkIdentity(safe.work),
    launch: {...safe.launch, writeScope: [...safe.launch.writeScope]},
    session: safe.session
      ? {
          ...safe.session,
          writeScope: [...safe.session.writeScope],
          work: safe.session.work ? cloneWorkIdentity(safe.session.work) : undefined,
        }
      : undefined,
  } as SafeChildSessionRecoveryRecord;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    try {
      await directory.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EINVAL") throw error;
    }
  } finally {
    await directory.close();
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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

  function lockPath(runId: string): string {
    assertRunId(runId);
    return join(root, `.${runId}.lock`);
  }

  async function writeRecord(
    record: ChildSessionRecoveryRecord,
    exclusive: boolean,
  ): Promise<void> {
    assertRunId(record.runId);
    await ensureRoot();
    const target = recordPath(record.runId);
    if (exclusive) {
      try {
        await lstat(target);
        throw new Error("work-session recovery record already exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const temporary = join(root, `.${record.runId}.${process.pid}.${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      const persisted = {...record, updatedAtMs: now()};
      await handle.writeFile(JSON.stringify(persisted), {encoding: "utf8"});
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (exclusive) {
        try {
          await lstat(target);
          throw new Error("work-session recovery record already exists");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await rename(temporary, target);
      await chmod(target, 0o600);
      await syncDirectory(root);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await rm(temporary, {force: true}).catch(() => undefined);
      throw error;
    }
  }

  async function readRecord(runId: string): Promise<ChildSessionRecoveryRecord | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(recordPath(runId), "utf8"));
      if (!isRecord(parsed) || parsed.runId !== runId) {
        throw new Error("invalid work-session recovery record");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async function acquire(runId: string): Promise<ChildSessionRunLock | undefined> {
    await ensureRoot();
    const path = lockPath(runId);
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(path, "wx", 0o600);
        await handle.writeFile(JSON.stringify({pid: process.pid, host: hostname(), createdAtMs: now()}));
        await handle.sync();
        const owned = await handle.stat();
        await handle.close();
        handle = undefined;
        await syncDirectory(root);
        let released = false;
        return {
          async release() {
            if (released) return;
            released = true;
            try {
              const current = await lstat(path);
              if (sameFile(current, owned)) {
                await rm(path, {force: true});
                await syncDirectory(root);
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          },
        };
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let owned: Stats;
        try {
          owned = await lstat(path);
          const parsed = object(JSON.parse(await readFile(path, "utf8")));
          const stale = parsed?.host === hostname()
            && typeof parsed.pid === "number"
            && !processIsAlive(parsed.pid);
          if (!stale) return undefined;
          const current = await lstat(path);
          if (sameFile(current, owned)) {
            await rm(path, {force: true});
            await syncDirectory(root);
            continue;
          }
        } catch (staleError) {
          if ((staleError as NodeJS.ErrnoException).code === "ENOENT") continue;
          return undefined;
        }
      }
    }
    return undefined;
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
        const parsed = await readRecord(fileRunId);
        if (!parsed) throw new Error("invalid work-session recovery record");
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
    put: (record) => writeRecord(record, false),
    putExclusive: (record) => writeRecord(record, true),
    get: readRecord,
    async remove(runId) {
      await rm(recordPath(runId), {force: true});
      await syncDirectory(root);
    },
    acquire,
    loadAll,
    async listSafe() {
      return (await loadAll()).records.map(safeRecord);
    },
  };
}

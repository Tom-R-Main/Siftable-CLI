/**
 * Durable, per-conversation instructions delivered outside an active agent
 * turn (for example, a parent's send-back request to a reviewed child).
 *
 * Each pending instruction is one fsynced file published with an atomic hard
 * link. Producers never rewrite a shared log, so concurrent senders cannot
 * truncate or interleave one another. Consumers acknowledge an instruction
 * only after projecting its id into the authoritative session journal; until
 * then delivery is intentionally at-least-once.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  linkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SESSION_MAILBOX_SCHEMA_VERSION = "sift.session-mailbox/1" as const;

const SESSION_ID_DOMAIN = "sift-interactive-session-v1\0";
const SAFE_INSTRUCTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SessionMailboxInstruction {
  schemaVersion: typeof SESSION_MAILBOX_SCHEMA_VERSION;
  instructionId: string;
  sessionId: string;
  enqueuedAt: string;
  instruction: string;
}

export interface SessionMailboxOptions {
  /** Test/embedding override. Defaults to the private Siftable mailbox root. */
  rootDir?: string;
  /** Deterministic seams used by focused tests. */
  now?: () => Date;
  idFactory?: () => string;
}

/**
 * Stable, opaque journal identity for one logical TUI conversation. Keep this
 * as the single producer/consumer helper; changing its domain forks history.
 */
export function sessionJournalIdForConversation(conversationKey: string): string {
  assertNonEmptyString(conversationKey, "conversationKey");
  return createHash("sha256")
    .update(`${SESSION_ID_DOMAIN}${conversationKey}`, "utf8")
    .digest("hex");
}

/** Resolve the mailbox root without consulting context-compaction flags. */
export function resolveSessionMailboxRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(
    env.SIFT_SESSION_MAILBOX_ROOT?.trim()
      || join(homedir(), ".siftable", "session-mailbox", "v1"),
  );
}

/** Atomically publish one durable instruction and return its receipt. */
export function enqueueSessionInstruction(
  conversationKey: string,
  instruction: string,
  options: SessionMailboxOptions = {},
): SessionMailboxInstruction {
  const text = instruction.trim();
  assertNonEmptyString(text, "instruction");
  const sessionId = sessionJournalIdForConversation(conversationKey);
  const instructionId = (options.idFactory ?? randomUUID)();
  assertSafeInstructionId(instructionId);
  const now = (options.now ?? (() => new Date()))();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("session mailbox clock must return a valid Date");
  }

  const record: SessionMailboxInstruction = {
    schemaVersion: SESSION_MAILBOX_SCHEMA_VERSION,
    instructionId,
    sessionId,
    enqueuedAt: now.toISOString(),
    instruction: text,
  };
  const pendingDir = ensurePendingDirectory(options.rootDir, sessionId);
  const finalPath = join(pendingDir, `${instructionId}.json`);
  const stagingPath = join(
    pendingDir,
    `.${instructionId}.${process.pid}.${randomUUID()}.tmp`,
  );
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");

  let fd: number | undefined;
  let stagingExists = false;
  try {
    fd = openSync(
      stagingPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    stagingExists = true;
    fchmodSync(fd, 0o600);
    writeAll(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    // A hard link publishes the fully written inode without replacing an
    // existing instruction if an injected/custom id ever collides.
    linkSync(stagingPath, finalPath);
    unlinkSync(stagingPath);
    stagingExists = false;
    fsyncDirectory(pendingDir);
    return record;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (stagingExists) {
      try {
        unlinkSync(stagingPath);
      } catch (error) {
        if (!isErrnoCode(error, "ENOENT")) throw error;
      }
    }
  }
}

/** Read pending instructions in deterministic enqueue order. */
export function listPendingSessionInstructions(
  conversationKey: string,
  options: Pick<SessionMailboxOptions, "rootDir"> = {},
): SessionMailboxInstruction[] {
  const sessionId = sessionJournalIdForConversation(conversationKey);
  const pendingDir = pendingDirectory(options.rootDir, sessionId);
  if (!existsSync(pendingDir)) return [];
  assertPrivateDirectory(pendingDir);

  const records: SessionMailboxInstruction[] = [];
  for (const entry of readdirSync(pendingDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const instructionId = entry.name.slice(0, -".json".length);
    assertSafeInstructionId(instructionId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(pendingDir, entry.name), "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`session mailbox instruction ${instructionId} is corrupt: ${detail}`);
    }
    records.push(validateInstruction(parsed, instructionId, sessionId));
  }

  return records.sort((left, right) => {
    const byTime = left.enqueuedAt.localeCompare(right.enqueuedAt);
    return byTime !== 0
      ? byTime
      : left.instructionId.localeCompare(right.instructionId);
  });
}

/**
 * Remove one delivered instruction. Consumers call this only after the durable
 * session journal records the instruction id, making crash retries dedupable.
 */
export function acknowledgeSessionInstruction(
  conversationKey: string,
  instructionId: string,
  options: Pick<SessionMailboxOptions, "rootDir"> = {},
): boolean {
  assertSafeInstructionId(instructionId);
  const sessionId = sessionJournalIdForConversation(conversationKey);
  const pendingDir = pendingDirectory(options.rootDir, sessionId);
  const path = join(pendingDir, `${instructionId}.json`);
  try {
    unlinkSync(path);
    fsyncDirectory(pendingDir);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return false;
    throw error;
  }
}

function mailboxRoot(rootDir: string | undefined): string {
  return resolve(rootDir?.trim() || resolveSessionMailboxRoot());
}

function pendingDirectory(rootDir: string | undefined, sessionId: string): string {
  return join(mailboxRoot(rootDir), sessionId, "pending");
}

function ensurePendingDirectory(rootDir: string | undefined, sessionId: string): string {
  const root = mailboxRoot(rootDir);
  const conversationDir = join(root, sessionId);
  const pendingDir = join(conversationDir, "pending");
  ensurePrivateDirectory(root);
  ensurePrivateDirectory(conversationDir);
  ensurePrivateDirectory(pendingDir);
  return pendingDir;
}

function ensurePrivateDirectory(path: string): void {
  const existing = lstatIfExists(path);
  if (existing) {
    assertPrivateDirectory(path);
    return;
  }

  const firstCreated = mkdirSync(path, {recursive: true, mode: 0o700});
  if (firstCreated === undefined) {
    // Another producer won the creation race. It must still satisfy the same
    // ownership and permission contract before this process writes beneath it.
    assertPrivateDirectory(path);
    return;
  }

  // A restrictive umask may remove owner bits from the requested mode. Only
  // normalize a directory this process just created; never chmod caller-owned
  // directories supplied through SIFT_SESSION_MAILBOX_ROOT.
  chmodSync(path, 0o700);
  assertPrivateDirectory(path);
  fsyncDirectory(path);
  fsyncCreatedDirectoryChain(resolve(firstCreated), path);
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function fsyncCreatedDirectoryChain(firstCreated: string, leaf: string): void {
  let current = leaf;
  while (true) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`session mailbox path is not beneath its created directory: ${leaf}`);
    }
    fsyncDirectory(parent);
    if (current === firstCreated) return;
    current = parent;
  }
}

function assertPrivateDirectory(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`session mailbox path must be a real directory: ${path}`);
  }
  if ((stats.mode & 0o7777) !== 0o700) {
    throw new Error(`session mailbox directory must have mode 0700: ${path}`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`session mailbox directory must be owned by the current user: ${path}`);
  }
}

function validateInstruction(
  value: unknown,
  expectedInstructionId: string,
  expectedSessionId: string,
): SessionMailboxInstruction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`session mailbox instruction ${expectedInstructionId} is invalid`);
  }
  const record = value as Partial<SessionMailboxInstruction>;
  if (
    record.schemaVersion !== SESSION_MAILBOX_SCHEMA_VERSION
    || record.instructionId !== expectedInstructionId
    || record.sessionId !== expectedSessionId
  ) {
    throw new Error(`session mailbox instruction ${expectedInstructionId} has mismatched identity`);
  }
  assertNonEmptyString(record.instruction, "mailbox instruction");
  if (
    typeof record.enqueuedAt !== "string"
    || !Number.isFinite(new Date(record.enqueuedAt).getTime())
    || new Date(record.enqueuedAt).toISOString() !== record.enqueuedAt
  ) {
    throw new Error(`session mailbox instruction ${expectedInstructionId} has an invalid timestamp`);
  }
  return {
    schemaVersion: SESSION_MAILBOX_SCHEMA_VERSION,
    instructionId: record.instructionId,
    sessionId: record.sessionId,
    enqueuedAt: record.enqueuedAt,
    instruction: record.instruction,
  };
}

function assertSafeInstructionId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_INSTRUCTION_ID.test(value)) {
    throw new Error("session mailbox instruction id must be a path-safe identifier");
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("session mailbox write made no progress");
    offset += written;
  }
}

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

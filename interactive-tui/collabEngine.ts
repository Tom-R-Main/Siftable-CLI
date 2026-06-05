import { existsSync } from "node:fs";

export type CollabBranchStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface CollabClaim {
  branchId: number;
  leaseToken: number;
  leaseExpiresMs: number;
}

export interface CollabBranchSnapshot {
  branchId: number;
  status: CollabBranchStatus;
  role: string;
  focus: string;
  worker: string;
  leaseExpiresMs: number;
  maxToolCalls: number;
  maxElapsedMs: number;
  eventCount: number;
  output: string;
  error: string;
  events: Array<{ eventId: number; atMs: number; type: string; payload: string }>;
}

export interface CollabSessionSnapshot {
  sessionId: number;
  cancelled: boolean;
  root: string;
  cwd: string;
  maxBranches: number;
  branches: CollabBranchSnapshot[];
}

interface CollabBackend {
  reset(): void;
  createSession(root: string, cwd: string, maxBranches: number): number;
  enqueueBranch(sessionId: number, role: string, focus: string, budget: { maxToolCalls?: number; maxElapsedMs?: number }): number;
  claimNextBranch(sessionId: number, worker: string, nowMs: number, leaseMs: number): CollabClaim | null;
  heartbeat(branchId: number, leaseToken: number, nowMs: number, leaseMs: number): number;
  appendEvent(branchId: number, leaseToken: number, type: string, payload: string, nowMs: number): void;
  completeBranch(branchId: number, leaseToken: number, output: string, nowMs: number): void;
  failBranch(branchId: number, leaseToken: number, error: string, nowMs: number): void;
  cancelSession(sessionId: number): void;
  snapshotSession(sessionId: number): CollabSessionSnapshot;
}

type NativeSymbols = {
  sift_collab_reset: () => void;
  sift_collab_create_session: (root: Uint8Array, rootLen: number, cwd: Uint8Array, cwdLen: number, maxBranches: number) => number;
  sift_collab_enqueue_branch: (
    sessionId: number,
    role: Uint8Array,
    roleLen: number,
    focus: Uint8Array,
    focusLen: number,
    maxToolCalls: number,
    maxElapsedMs: number,
  ) => number;
  sift_collab_claim_next_branch: (
    sessionId: number,
    worker: Uint8Array,
    workerLen: number,
    nowMs: number,
    leaseMs: number,
    out: Uint8Array,
  ) => number;
  sift_collab_heartbeat: (branchId: number, leaseToken: number, nowMs: number, leaseMs: number, out: Uint8Array) => number;
  sift_collab_append_event: (
    branchId: number,
    leaseToken: number,
    type: Uint8Array,
    typeLen: number,
    payload: Uint8Array,
    payloadLen: number,
    nowMs: number,
  ) => number;
  sift_collab_complete_branch: (branchId: number, leaseToken: number, output: Uint8Array, outputLen: number, nowMs: number) => number;
  sift_collab_fail_branch: (branchId: number, leaseToken: number, error: Uint8Array, errorLen: number, nowMs: number) => number;
  sift_collab_cancel_session: (sessionId: number) => number;
  sift_collab_snapshot_session: (sessionId: number, out: Uint8Array, outCap: number, written: Uint32Array, needed: Uint32Array) => number;
};

const STATUS_OK = 0;
const STATUS_NOT_FOUND = 2;
const STATUS_OUTPUT_TOO_SMALL = 6;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let backend: CollabBackend | undefined;
const sessionRegistry: number[] = [];

export function resetCollabEngineForTests(): void {
  const active = backend;
  active?.reset();
  nativeSymbols()?.sift_collab_reset();
  backend = undefined;
  sessionRegistry.length = 0;
}

export function createCollabSession(input: { root: string; cwd?: string; maxBranches?: number }): number {
  const sessionId = getBackend().createSession(input.root, input.cwd ?? input.root, input.maxBranches ?? 16);
  sessionRegistry.push(sessionId);
  return sessionId;
}

export function enqueueCollabBranch(
  sessionId: number,
  input: { role: string; focus?: string; maxToolCalls?: number; maxElapsedMs?: number },
): number {
  return getBackend().enqueueBranch(sessionId, input.role, input.focus ?? input.role, {
    maxToolCalls: input.maxToolCalls,
    maxElapsedMs: input.maxElapsedMs,
  });
}

export function claimNextCollabBranch(
  sessionId: number,
  input: { worker: string; nowMs?: number; leaseMs?: number },
): CollabClaim | null {
  return getBackend().claimNextBranch(sessionId, input.worker, input.nowMs ?? Date.now(), input.leaseMs ?? 30_000);
}

export function heartbeatCollabBranch(
  branchId: number,
  input: { leaseToken: number; nowMs?: number; leaseMs?: number },
): number {
  return getBackend().heartbeat(branchId, input.leaseToken, input.nowMs ?? Date.now(), input.leaseMs ?? 30_000);
}

export function appendCollabEvent(
  branchId: number,
  input: { leaseToken: number; type: string; payload?: string; nowMs?: number },
): void {
  getBackend().appendEvent(branchId, input.leaseToken, input.type, input.payload ?? "", input.nowMs ?? Date.now());
}

export function completeCollabBranch(
  branchId: number,
  input: { leaseToken: number; output?: string; nowMs?: number },
): void {
  getBackend().completeBranch(branchId, input.leaseToken, input.output ?? "", input.nowMs ?? Date.now());
}

export function failCollabBranch(
  branchId: number,
  input: { leaseToken: number; error: string; nowMs?: number },
): void {
  getBackend().failBranch(branchId, input.leaseToken, input.error, input.nowMs ?? Date.now());
}

export function cancelCollabSession(sessionId: number): void {
  getBackend().cancelSession(sessionId);
}

export function snapshotCollabSession(sessionId: number): CollabSessionSnapshot {
  return getBackend().snapshotSession(sessionId);
}

export function listCollabSessions(input: { limit?: number } = {}): CollabSessionSnapshot[] {
  const limit = input.limit ?? 20;
  const ids = [...sessionRegistry].slice(-limit).reverse();
  const snapshots: CollabSessionSnapshot[] = [];
  for (const id of ids) {
    try {
      snapshots.push(snapshotCollabSession(id));
    } catch {
      // Session IDs are process-local diagnostics; skip stale native/fallback ids.
    }
  }
  return snapshots;
}

function getBackend(): CollabBackend {
  if (backend) return backend;
  const native = nativeSymbols();
  backend = native ? new NativeCollabBackend(native) : new InMemoryCollabBackend();
  return backend;
}

let native: NativeSymbols | null | undefined;

function nativeSymbols(): NativeSymbols | null {
  if (native !== undefined) return native;
  if (typeof Bun === "undefined" || process.env.SIFT_NO_NATIVE === "1") {
    native = null;
    return native;
  }
  const { default: nativeLibraryPath } = require("./native/collab_engine") as { default: string };
  if (!existsSync(nativeLibraryPath)) {
    native = null;
    return native;
  }
  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
  const lib = dlopen(nativeLibraryPath, {
    sift_collab_reset: {},
    sift_collab_create_session: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32],
      returns: FFIType.u32,
    },
    sift_collab_enqueue_branch: {
      args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32],
      returns: FFIType.u32,
    },
    sift_collab_claim_next_branch: {
      args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.u32, FFIType.ptr],
      returns: FFIType.u32,
    },
    sift_collab_heartbeat: {
      args: [FFIType.u32, FFIType.u32, FFIType.u64, FFIType.u32, FFIType.ptr],
      returns: FFIType.u32,
    },
    sift_collab_append_event: {
      args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u64],
      returns: FFIType.u32,
    },
    sift_collab_complete_branch: {
      args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u64],
      returns: FFIType.u32,
    },
    sift_collab_fail_branch: {
      args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u64],
      returns: FFIType.u32,
    },
    sift_collab_cancel_session: { args: [FFIType.u32], returns: FFIType.u32 },
    sift_collab_snapshot_session: {
      args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.u32,
    },
  });
  native = lib.symbols as NativeSymbols;
  return native;
}

class NativeCollabBackend implements CollabBackend {
  constructor(private readonly symbols: NativeSymbols) {}

  reset(): void {
    this.symbols.sift_collab_reset();
  }

  createSession(root: string, cwd: string, maxBranches: number): number {
    const rootBytes = bytes(root);
    const cwdBytes = bytes(cwd);
    const id = this.symbols.sift_collab_create_session(rootBytes, rootBytes.length, cwdBytes, cwdBytes.length, maxBranches);
    if (!id) throw new Error("collab createSession failed");
    return id;
  }

  enqueueBranch(sessionId: number, role: string, focus: string, budget: { maxToolCalls?: number; maxElapsedMs?: number }): number {
    const roleBytes = bytes(role);
    const focusBytes = bytes(focus);
    const id = this.symbols.sift_collab_enqueue_branch(
      sessionId,
      roleBytes,
      roleBytes.length,
      focusBytes,
      focusBytes.length,
      budget.maxToolCalls ?? 0,
      budget.maxElapsedMs ?? 0,
    );
    if (!id) throw new Error("collab enqueueBranch failed");
    return id;
  }

  claimNextBranch(sessionId: number, worker: string, nowMs: number, leaseMs: number): CollabClaim | null {
    const out = new Uint8Array(16);
    const workerBytes = bytes(worker);
    const status = this.symbols.sift_collab_claim_next_branch(sessionId, workerBytes, workerBytes.length, nowMs, leaseMs, out);
    if (status === STATUS_NOT_FOUND) return null;
    assertStatus(status, "claimNextBranch");
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    return {
      branchId: view.getUint32(0, true),
      leaseToken: view.getUint32(4, true),
      leaseExpiresMs: Number(view.getBigUint64(8, true)),
    };
  }

  heartbeat(branchId: number, leaseToken: number, nowMs: number, leaseMs: number): number {
    const out = new Uint8Array(8);
    assertStatus(this.symbols.sift_collab_heartbeat(branchId, leaseToken, nowMs, leaseMs, out), "heartbeat");
    return Number(new DataView(out.buffer, out.byteOffset, out.byteLength).getBigUint64(0, true));
  }

  appendEvent(branchId: number, leaseToken: number, type: string, payload: string, nowMs: number): void {
    const typeBytes = bytes(type);
    const payloadBytes = bytes(payload);
    assertStatus(
      this.symbols.sift_collab_append_event(branchId, leaseToken, typeBytes, typeBytes.length, payloadBytes, payloadBytes.length, nowMs),
      "appendEvent",
    );
  }

  completeBranch(branchId: number, leaseToken: number, output: string, nowMs: number): void {
    const outputBytes = bytes(output);
    assertStatus(this.symbols.sift_collab_complete_branch(branchId, leaseToken, outputBytes, outputBytes.length, nowMs), "completeBranch");
  }

  failBranch(branchId: number, leaseToken: number, error: string, nowMs: number): void {
    const errorBytes = bytes(error);
    assertStatus(this.symbols.sift_collab_fail_branch(branchId, leaseToken, errorBytes, errorBytes.length, nowMs), "failBranch");
  }

  cancelSession(sessionId: number): void {
    assertStatus(this.symbols.sift_collab_cancel_session(sessionId), "cancelSession");
  }

  snapshotSession(sessionId: number): CollabSessionSnapshot {
    let cap = 16 * 1024;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const out = new Uint8Array(cap);
      const written = new Uint32Array(1);
      const needed = new Uint32Array(1);
      const status = this.symbols.sift_collab_snapshot_session(sessionId, out, out.length, written, needed);
      if (status === STATUS_OUTPUT_TOO_SMALL) {
        cap = Math.max(cap * 2, needed[0] + 1024);
        continue;
      }
      assertStatus(status, "snapshotSession");
      return JSON.parse(decoder.decode(out.slice(0, written[0]))) as CollabSessionSnapshot;
    }
    throw new Error("collab snapshotSession failed: output too small");
  }
}

class InMemoryCollabBackend implements CollabBackend {
  private sessions = new Map<number, CollabSessionSnapshot>();
  private nextSessionId = 1;
  private nextBranchId = 1;
  private nextEventId = 1;
  private nextLeaseToken = 1000;

  reset(): void {
    this.sessions.clear();
    this.nextSessionId = 1;
    this.nextBranchId = 1;
    this.nextEventId = 1;
    this.nextLeaseToken = 1000;
  }

  createSession(root: string, cwd: string, maxBranches: number): number {
    if (maxBranches <= 0) throw new Error("collab createSession failed: maxBranches must be > 0");
    const id = this.nextSessionId++;
    this.sessions.set(id, { sessionId: id, cancelled: false, root, cwd, maxBranches, branches: [] });
    return id;
  }

  enqueueBranch(sessionId: number, role: string, focus: string, budget: { maxToolCalls?: number; maxElapsedMs?: number }): number {
    const session = this.session(sessionId);
    if (session.cancelled || session.branches.length >= session.maxBranches) throw new Error("collab enqueueBranch failed");
    const id = this.nextBranchId++;
    session.branches.push({
      branchId: id,
      status: "pending",
      role,
      focus,
      worker: "",
      leaseExpiresMs: 0,
      maxToolCalls: budget.maxToolCalls ?? 0,
      maxElapsedMs: budget.maxElapsedMs ?? 0,
      eventCount: 0,
      output: "",
      error: "",
      events: [],
    });
    return id;
  }

  claimNextBranch(sessionId: number, worker: string, nowMs: number, leaseMs: number): CollabClaim | null {
    const session = this.session(sessionId);
    if (session.cancelled || leaseMs <= 0) throw new Error("collab claimNextBranch failed");
    const branch = session.branches.find((item) =>
      item.status === "pending" || (item.status === "running" && item.leaseExpiresMs < nowMs));
    if (!branch) return null;
    branch.status = "running";
    branch.worker = worker;
    branch.leaseExpiresMs = nowMs + leaseMs;
    const leaseToken = ++this.nextLeaseToken;
    (branch as CollabBranchSnapshot & { leaseToken?: number }).leaseToken = leaseToken;
    return { branchId: branch.branchId, leaseToken, leaseExpiresMs: branch.leaseExpiresMs };
  }

  heartbeat(branchId: number, leaseToken: number, nowMs: number, leaseMs: number): number {
    const branch = this.leasedBranch(branchId, leaseToken, nowMs);
    branch.leaseExpiresMs = nowMs + leaseMs;
    return branch.leaseExpiresMs;
  }

  appendEvent(branchId: number, leaseToken: number, type: string, payload: string, nowMs: number): void {
    const branch = this.leasedBranch(branchId, leaseToken, nowMs);
    branch.events.push({ eventId: this.nextEventId++, atMs: nowMs, type, payload });
    branch.eventCount = branch.events.length;
  }

  completeBranch(branchId: number, leaseToken: number, output: string, nowMs: number): void {
    const branch = this.leasedBranch(branchId, leaseToken, nowMs);
    branch.output = output;
    branch.status = "completed";
    branch.leaseExpiresMs = 0;
    delete (branch as CollabBranchSnapshot & { leaseToken?: number }).leaseToken;
  }

  failBranch(branchId: number, leaseToken: number, error: string, nowMs: number): void {
    const branch = this.leasedBranch(branchId, leaseToken, nowMs);
    branch.error = error;
    branch.status = "failed";
    branch.leaseExpiresMs = 0;
    delete (branch as CollabBranchSnapshot & { leaseToken?: number }).leaseToken;
  }

  cancelSession(sessionId: number): void {
    const session = this.session(sessionId);
    session.cancelled = true;
    for (const branch of session.branches) {
      if (branch.status === "pending" || branch.status === "running") {
        branch.status = "cancelled";
        branch.leaseExpiresMs = 0;
      }
    }
  }

  snapshotSession(sessionId: number): CollabSessionSnapshot {
    return JSON.parse(JSON.stringify(this.session(sessionId))) as CollabSessionSnapshot;
  }

  private session(sessionId: number): CollabSessionSnapshot {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`collab session not found: ${sessionId}`);
    return session;
  }

  private branch(branchId: number): CollabBranchSnapshot & { leaseToken?: number } {
    for (const session of this.sessions.values()) {
      const branch = session.branches.find((item) => item.branchId === branchId);
      if (branch) return branch as CollabBranchSnapshot & { leaseToken?: number };
    }
    throw new Error(`collab branch not found: ${branchId}`);
  }

  private leasedBranch(branchId: number, leaseToken: number, nowMs: number): CollabBranchSnapshot & { leaseToken?: number } {
    const branch = this.branch(branchId);
    if (branch.status !== "running") throw new Error(`collab branch not running: ${branchId}`);
    if (branch.leaseToken !== leaseToken || branch.leaseExpiresMs < nowMs) {
      throw new Error(`collab stale lease: ${branchId}`);
    }
    return branch;
  }
}

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function assertStatus(status: number, action: string): void {
  if (status === STATUS_OK) return;
  throw new Error(`collab ${action} failed: status ${status}`);
}

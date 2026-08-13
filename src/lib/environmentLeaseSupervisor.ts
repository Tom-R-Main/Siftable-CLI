import {fork, type ChildProcess} from 'node:child_process';
import {createPrivateKey, type KeyObject} from 'node:crypto';
import {
  adoptEnvironmentLeaseManager,
  cleanupEnvironmentLeaseArtifact,
  readEnvironmentLeaseRecord,
  removeEnvironmentLeaseRecord,
  type EnvironmentLeaseCleanupReason,
  type EnvironmentLeaseRecord,
} from './environmentLease.js';
import {
  createEnvironmentLeaseCleanupProofBinding,
  signMaterializationRunnerProof,
} from './localMaterializer.js';

interface EnvironmentLeaseSupervisorConfig {
  runtimeRoot: string;
  leaseId: string;
  expiresAt: string;
  consumerPid: number | null;
  apiUrl: string;
  token: string;
  workspaceId: string | null;
  contextContractVersion: 0 | 1;
  runnerFingerprint: string;
  materializerDigest: string;
  privateKeyPem: Buffer;
  producerPid: number;
}

type SupervisorMessage =
  | {type: 'armed'}
  | {type: 'completed'; record: EnvironmentLeaseRecord}
  | {type: 'failed'; code: string};

export interface EnvironmentLeaseSupervisor {
  armed: Promise<void>;
  completed: Promise<EnvironmentLeaseRecord>;
  cleanup(reason: EnvironmentLeaseCleanupReason): void;
  dispose(): void;
}

export function registerEnvironmentLeaseSupervisorSignalCleanup(
  supervisor: EnvironmentLeaseSupervisor,
): () => void {
  let handling = false;
  const handlers = new Map<NodeJS.Signals, () => void>();
  const dispose = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    handlers.clear();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      if (handling) return;
      handling = true;
      supervisor.cleanup('signal');
      void supervisor.completed.then(
        () => {
          dispose();
          process.kill(process.pid, signal);
        },
        () => {
          handling = false;
        },
      );
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return dispose;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function request(
  config: EnvironmentLeaseSupervisorConfig,
  pathname: string,
  options: {method?: 'GET' | 'POST'; body?: unknown; timeoutMilliseconds?: number} = {},
): Promise<Response> {
  return fetch(`${config.apiUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      ...(config.workspaceId ? {'X-Workspace-Id': config.workspaceId} : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMilliseconds ?? 2_000),
  });
}

async function leaseWasRevoked(config: EnvironmentLeaseSupervisorConfig): Promise<boolean> {
  try {
    const remaining = Date.parse(config.expiresAt) - Date.now();
    if (remaining <= 0) return false;
    const response = await request(
      config,
      `/api/v1/vault/materializations/leases/${encodeURIComponent(config.leaseId)}`
        + `?surface=cli&contextContractVersion=${config.contextContractVersion}`,
      {timeoutMilliseconds: Math.max(1, Math.min(1_000, remaining))},
    );
    if (!response.ok) return false;
    const body = await response.json() as {lease?: {lifecycle?: string}};
    return body.lease?.lifecycle === 'revoked';
  } catch {
    return false;
  }
}

async function attestCleanup(
  config: EnvironmentLeaseSupervisorConfig,
  privateKey: KeyObject,
  record: EnvironmentLeaseRecord,
): Promise<boolean> {
  if (!record.cleanupAttemptId || !record.cleanupReason || record.cleanupState === 'pending') return false;
  const proofTimestamp = new Date().toISOString();
  const proofBinding = createEnvironmentLeaseCleanupProofBinding({
    leaseId: record.leaseId,
    attemptId: record.cleanupAttemptId,
    state: record.cleanupState,
    reason: record.cleanupReason,
    runnerFingerprint: config.runnerFingerprint,
    materializerDigest: config.materializerDigest,
    proofTimestamp,
  });
  try {
    const response = await request(
      config,
      `/api/v1/vault/materializations/leases/${encodeURIComponent(config.leaseId)}/cleanup`,
      {
        method: 'POST',
        body: {
          surface: 'cli',
          contextContractVersion: config.contextContractVersion,
          attemptId: record.cleanupAttemptId,
          state: record.cleanupState,
          reason: record.cleanupReason,
          runnerFingerprint: config.runnerFingerprint,
          materializerDigest: config.materializerDigest,
          proofTimestamp,
          proof: signMaterializationRunnerProof(proofBinding, privateKey),
        },
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function supervise(config: EnvironmentLeaseSupervisorConfig): Promise<EnvironmentLeaseRecord> {
  const privateKeyPem = Buffer.from(config.privateKeyPem);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } finally {
    privateKeyPem.fill(0);
    config.privateKeyPem.fill(0);
  }
  const initial = await readEnvironmentLeaseRecord(config.runtimeRoot, config.leaseId);
  if (!initial
    || initial.runnerFingerprint !== config.runnerFingerprint
    || initial.materializerDigest !== config.materializerDigest
    || initial.expiresAt !== config.expiresAt) {
    throw new Error('lease_supervisor_binding_invalid');
  }
  await adoptEnvironmentLeaseManager({
    runtimeRoot: config.runtimeRoot,
    leaseId: config.leaseId,
    managerPid: process.pid,
  });
  process.send?.({type: 'armed'} satisfies SupervisorMessage);
  let requestedReason: EnvironmentLeaseCleanupReason | null = null;
  process.on('message', message => {
    if (message && typeof message === 'object'
      && (message as {type?: string}).type === 'cleanup') {
      requestedReason = (message as {reason: EnvironmentLeaseCleanupReason}).reason;
    }
  });
  let reason: EnvironmentLeaseCleanupReason;
  while (true) {
    if (requestedReason) {
      reason = requestedReason;
      break;
    }
    const current = await readEnvironmentLeaseRecord(config.runtimeRoot, config.leaseId);
    if (!current) throw new Error('lease_supervisor_record_missing');
    if (current.artifactState === 'preparing' && !processIsAlive(config.producerPid)) {
      reason = 'crash_recovery';
      break;
    }
    if (current.artifactState === 'ready'
      && config.consumerPid && !processIsAlive(config.consumerPid)) {
      reason = 'normal_exit';
      break;
    }
    if (Date.now() >= Date.parse(config.expiresAt)) {
      reason = 'timeout';
      break;
    }
    if (await leaseWasRevoked(config)) {
      reason = 'revoke';
      break;
    }
    await new Promise(resolve => setTimeout(
      resolve,
      Math.max(1, Math.min(1_000, Date.parse(config.expiresAt) - Date.now())),
    ));
  }
  const record = await cleanupEnvironmentLeaseArtifact({
    runtimeRoot: config.runtimeRoot,
    leaseId: config.leaseId,
    reason,
  });
  if (await attestCleanup(config, privateKey, record)
    && record.cleanupState === 'confirmed') {
    await removeEnvironmentLeaseRecord(config.runtimeRoot, config.leaseId);
  }
  return record;
}

function runChild(): void {
  const setupTimer = setTimeout(() => process.exit(1), 5_000);
  process.once('message', message => {
    clearTimeout(setupTimer);
    const config = message as EnvironmentLeaseSupervisorConfig;
    void supervise(config).then(
      record => {
        process.send?.({type: 'completed', record} satisfies SupervisorMessage);
        process.disconnect?.();
      },
      error => {
        process.send?.({
          type: 'failed',
          code: error instanceof Error ? error.message : 'lease_supervisor_failed',
        } satisfies SupervisorMessage);
        process.disconnect?.();
      },
    );
  });
}

export function startEnvironmentLeaseSupervisor(input: {
  runtimeRoot: string;
  leaseId: string;
  expiresAt: string;
  consumerPid?: number;
  apiUrl: string;
  token: string;
  workspaceId: string | null;
  contextContractVersion: 0 | 1;
  runnerFingerprint: string;
  materializerDigest: string;
  privateKey: KeyObject;
  forkProcess?: (modulePath: string, args: string[], options: Parameters<typeof fork>[2]) => ChildProcess;
}): EnvironmentLeaseSupervisor {
  const spawn = input.forkProcess ?? fork;
  const child = spawn(__filename, ['--sift-environment-lease-supervisor'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
  });
  child.unref();
  let resolveArmed!: () => void;
  let rejectArmed!: (error: Error) => void;
  let resolveCompleted!: (record: EnvironmentLeaseRecord) => void;
  let rejectCompleted!: (error: Error) => void;
  const armed = new Promise<void>((resolve, reject) => {
    resolveArmed = resolve;
    rejectArmed = reject;
  });
  const completed = new Promise<EnvironmentLeaseRecord>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  void completed.catch(() => undefined);
  const fail = (code: string) => {
    const error = new Error(code);
    rejectArmed(error);
    rejectCompleted(error);
  };
  child.on('message', message => {
    const typed = message as SupervisorMessage;
    if (typed.type === 'armed') resolveArmed();
    if (typed.type === 'completed') resolveCompleted(typed.record);
    if (typed.type === 'failed') fail(typed.code);
  });
  child.once('error', error => fail(error.message));
  child.once('exit', code => {
    if (code && code !== 0) fail('lease_supervisor_exited');
  });
  const privateKeyPem = Buffer.from(input.privateKey.export({type: 'pkcs8', format: 'pem'}));
  child.send({
    runtimeRoot: input.runtimeRoot,
    leaseId: input.leaseId,
    expiresAt: input.expiresAt,
    consumerPid: input.consumerPid ?? null,
    apiUrl: input.apiUrl,
    token: input.token,
    workspaceId: input.workspaceId,
    contextContractVersion: input.contextContractVersion,
    runnerFingerprint: input.runnerFingerprint,
    materializerDigest: input.materializerDigest,
    privateKeyPem,
    producerPid: process.pid,
  } satisfies EnvironmentLeaseSupervisorConfig, error => {
    privateKeyPem.fill(0);
    if (error) fail('lease_supervisor_setup_failed');
  });
  return {
    armed,
    completed,
    cleanup: reason => child.send({type: 'cleanup', reason}),
    dispose: () => child.removeAllListeners(),
  };
}

if (process.send && process.argv[2] === '--sift-environment-lease-supervisor') runChild();

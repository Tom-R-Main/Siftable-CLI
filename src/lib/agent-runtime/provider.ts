import {createHash} from 'node:crypto';
import {spawn, type ChildProcess} from 'node:child_process';
import {
  AGENT_WORKSPACE_RUNTIME_LIMITS,
  AGENT_WORKSPACE_RUNTIME_VERSION,
  canTransitionAgentWorkspaceRuntime,
  validateProviderRuntime,
  type AgentWorkspaceArtifactV1,
  type AgentWorkspaceAttachInputV1,
  type AgentWorkspaceCheckpointInputV1,
  type AgentWorkspaceCheckpointV1,
  type AgentWorkspaceEndpointV1,
  type AgentWorkspaceExecInputV1,
  type AgentWorkspaceExecResultV1,
  type AgentWorkspaceExposePortInputV1,
  type AgentWorkspaceHeartbeatInputV1,
  type AgentWorkspaceOperationContextV1,
  type AgentWorkspacePreflightInputV1,
  type AgentWorkspacePreflightResultV1,
  type AgentWorkspaceProvisionInputV1,
  type AgentWorkspacePublishEvidenceInputV1,
  type AgentWorkspaceRuntimeProviderV1,
  type AgentWorkspaceRuntimeState,
  type AgentWorkspaceRuntimeV1,
  type AgentWorkspaceTerminateInputV1,
} from './contract.js';

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SECRETISH_REFERENCE = /(api[_-]?key|credential|password|private[_-]?key|secret|token)/i;
const MAX_CAPTURE_BYTES = 256 * 1024;
const LOCAL_EXEC_ENV_KEYS = ['CI', 'LANG', 'LC_ALL', 'PATH', 'TEMP', 'TMP', 'TMPDIR'] as const;

export type AgentWorkspaceProviderErrorCode =
  | 'command_failed'
  | 'idempotency_conflict'
  | 'invalid_input'
  | 'invalid_state'
  | 'lease_expired'
  | 'lease_mismatch'
  | 'not_found'
  | 'preflight_failed'
  | 'unsafe_reference'
  | 'unsupported_environment';

export class AgentWorkspaceProviderError extends Error {
  constructor(readonly code: AgentWorkspaceProviderErrorCode, message: string) {
    super(message);
    this.name = 'AgentWorkspaceProviderError';
  }
}

export interface AgentWorkspaceProviderOptions {
  now?: () => Date;
}

export interface LocalWorkspaceHandle {
  repositoryRoot: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
  headSha: string;
  recovered: boolean;
}

/**
 * Narrow adapter implemented by the existing guarded worktree service. Keeping
 * this interface inside src avoids making the published CLI build import files
 * outside its TypeScript root.
 */
export interface LocalWorkspaceDriver {
  preflight(input: AgentWorkspacePreflightInputV1): Promise<AgentWorkspacePreflightResultV1>;
  provision(input: AgentWorkspaceProvisionInputV1): Promise<LocalWorkspaceHandle>;
  currentHead(handle: LocalWorkspaceHandle): Promise<string>;
  terminate(handle: LocalWorkspaceHandle): Promise<void>;
}

interface IdempotencyRecord<T> {
  fingerprint: string;
  promise: Promise<T>;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function opaqueId(prefix: string, value: unknown): string {
  return `${prefix}:${fingerprint(value).slice(0, 24)}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertReference(value: string, field: string): void {
  if (!REFERENCE.test(value) || SECRETISH_REFERENCE.test(value)) {
    throw new AgentWorkspaceProviderError(
      'unsafe_reference',
      `${field} must be an opaque, non-secret reference.`,
    );
  }
}

function assertIdentifier(value: string, field: string): void {
  if (!REFERENCE.test(value)) {
    throw new AgentWorkspaceProviderError('invalid_input', `${field} must be a stable opaque identifier.`);
  }
}

function localExecutionEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    LOCAL_EXEC_ENV_KEYS.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
  );
}

function appendBounded(target: Buffer[], chunk: Buffer | string, state: {bytes: number}): void {
  if (state.bytes >= MAX_CAPTURE_BYTES) return;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = MAX_CAPTURE_BYTES - state.bytes;
  target.push(bytes.subarray(0, remaining));
  state.bytes += Math.min(bytes.length, remaining);
}

export interface BoundedCommandResult {
  exitCode: number;
  timedOut: boolean;
  stdout: Buffer;
  stderr: Buffer;
}

function signalCommandTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    if (signal === 'SIGKILL') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.unref();
      return;
    }
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** Run argv directly (never through a shell) with bounded output and timeout. */
export async function runBoundedCommand(
  argv: readonly string[],
  cwd: string,
  timeoutSeconds: number,
): Promise<BoundedCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      detached: process.platform !== 'win32',
      env: localExecutionEnvironment(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutState = {bytes: 0};
    const stderrState = {bytes: 0};
    let timedOut = false;
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      signalCommandTree(child, 'SIGTERM');
      forceKill = setTimeout(() => signalCommandTree(child, 'SIGKILL'), 1_000);
      forceKill.unref();
    }, timeoutSeconds * 1000);
    timeout.unref();

    child.stdout?.on('data', chunk => appendBounded(stdout, chunk, stdoutState));
    child.stderr?.on('data', chunk => appendBounded(stderr, chunk, stderrState));
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(new AgentWorkspaceProviderError('command_failed', `Unable to start command: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolve({
        exitCode: timedOut ? 124 : (code ?? (signal ? 128 : 1)),
        timedOut,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

/**
 * Deterministic in-memory implementation of AgentWorkspaceRuntimeV1. The local
 * provider extends it only at the resource boundary; lifecycle, lease,
 * idempotency, artifact, and reference behavior stays identical in both.
 */
export class FakeAgentWorkspaceRuntimeProvider implements AgentWorkspaceRuntimeProviderV1 {
  protected readonly runtimes = new Map<string, AgentWorkspaceRuntimeV1>();
  protected readonly runtimeByWorkItem = new Map<string, string>();
  protected readonly histories = new Map<string, AgentWorkspaceRuntimeState[]>();
  protected readonly artifacts = new Map<string, Buffer>();
  private readonly idempotency = new Map<string, IdempotencyRecord<unknown>>();
  private readonly nowFn: () => Date;

  constructor(options: AgentWorkspaceProviderOptions = {}) {
    this.nowFn = options.now ?? (() => new Date());
  }

  async preflight(input: AgentWorkspacePreflightInputV1): Promise<AgentWorkspacePreflightResultV1> {
    const checks = {
      provider: input.template.provider === 'fake',
      leaseGeneration: Number.isSafeInteger(input.context.leaseGeneration)
        && input.context.leaseGeneration > 0,
      workItem: input.context.workItemId.length > 0,
    };
    const ok = Object.values(checks).every(Boolean);
    return {ok, checks, reasonCode: ok ? null : 'fake_provider_preflight_failed'};
  }

  async provision(input: AgentWorkspaceProvisionInputV1): Promise<AgentWorkspaceRuntimeV1> {
    return await this.mutate('provision', input.context, input, async () => {
      this.assertContextBinding(input.context, input.binding.workItemId);
      const existingId = this.runtimeByWorkItem.get(input.binding.workItemId);
      if (existingId) return this.read(existingId);
      const preflight = await this.preflight({template: input.template, context: input.context});
      if (!preflight.ok) {
        throw new AgentWorkspaceProviderError('preflight_failed', preflight.reasonCode ?? 'Provider preflight failed.');
      }
      const createdAt = this.now();
      if (Date.parse(input.ttl.expiresAt) <= Date.parse(createdAt)) {
        throw new AgentWorkspaceProviderError('invalid_input', 'Workspace TTL must be in the future.');
      }
      const runtimeId = opaqueId('runtime', {
        workItemId: input.binding.workItemId,
        provider: input.template.provider,
        templateDigest: input.template.templateDigest,
      });
      const runtime: AgentWorkspaceRuntimeV1 = {
        version: AGENT_WORKSPACE_RUNTIME_VERSION,
        runtimeId,
        state: 'requested',
        binding: clone(input.binding),
        template: clone(input.template),
        lease: {
          ownerFingerprint: opaqueId('owner', {
            workItemId: input.context.workItemId,
            generation: input.context.leaseGeneration,
          }),
          generation: input.context.leaseGeneration,
          heartbeatAt: createdAt,
          expiresAt: input.ttl.expiresAt,
        },
        ttl: clone(input.ttl),
        endpoints: [],
        checkpoints: [],
        artifacts: [],
        metrics: [],
        failure: null,
        createdAt,
        updatedAt: createdAt,
      };
      this.runtimes.set(runtimeId, runtime);
      this.runtimeByWorkItem.set(input.binding.workItemId, runtimeId);
      this.histories.set(runtimeId, ['requested']);
      try {
        this.transition(runtime, 'provisioning');
        await this.provisionResource(input, runtime);
        this.transition(runtime, 'ready');
        return this.read(runtimeId);
      } catch (error) {
        await this.rollbackProvisionResource(runtime).catch(() => undefined);
        this.runtimes.delete(runtimeId);
        if (this.runtimeByWorkItem.get(input.binding.workItemId) === runtimeId) {
          this.runtimeByWorkItem.delete(input.binding.workItemId);
        }
        this.histories.delete(runtimeId);
        throw error;
      }
    });
  }

  async attach(input: AgentWorkspaceAttachInputV1): Promise<AgentWorkspaceEndpointV1> {
    return await this.mutate('attach', input.context, input, async () => {
      const runtime = this.requireMutableRuntime(input.runtimeId, input.context);
      const id = opaqueId('endpoint', {runtimeId: input.runtimeId, kind: input.endpointKind});
      const existing = runtime.endpoints.find(endpoint => endpoint.id === id);
      if (existing) return clone(existing);
      if (runtime.endpoints.length >= AGENT_WORKSPACE_RUNTIME_LIMITS.maxEndpoints) {
        throw new AgentWorkspaceProviderError('invalid_state', 'Endpoint limit reached.');
      }
      const endpoint: AgentWorkspaceEndpointV1 = {
        id,
        kind: input.endpointKind,
        connectionRef: this.connectionRef(runtime, input.endpointKind),
        expiresAt: runtime.ttl.expiresAt,
      };
      assertReference(endpoint.connectionRef, 'connectionRef');
      runtime.endpoints.push(endpoint);
      this.touch(runtime);
      return clone(endpoint);
    });
  }

  async exec(input: AgentWorkspaceExecInputV1): Promise<AgentWorkspaceExecResultV1> {
    return await this.mutate('exec', input.context, input, async () => {
      const runtime = this.requireMutableRuntime(input.runtimeId, input.context);
      this.assertExecInput(input);
      this.transition(runtime, 'active');
      const startedAt = this.now();
      try {
        const command = await this.executeCommand(runtime, input);
        const endedAt = this.now();
        const logCount = Number(command.stdout.length > 0) + Number(command.stderr.length > 0);
        if (runtime.artifacts.length + logCount > AGENT_WORKSPACE_RUNTIME_LIMITS.maxArtifacts) {
          throw new AgentWorkspaceProviderError('invalid_state', 'Artifact limit reached.');
        }
        const stdoutArtifactRef = this.captureLog(runtime, command.stdout, 'stdout', startedAt);
        const stderrArtifactRef = this.captureLog(runtime, command.stderr, 'stderr', startedAt);
        this.transition(runtime, 'ready');
        return {
          exitCode: command.exitCode,
          timedOut: command.timedOut,
          startedAt,
          endedAt,
          stdoutArtifactRef,
          stderrArtifactRef,
        };
      } catch (error) {
        this.transition(runtime, 'interrupted');
        throw error;
      }
    });
  }

  async exposePort(input: AgentWorkspaceExposePortInputV1): Promise<AgentWorkspaceEndpointV1> {
    return await this.mutate('exposePort', input.context, input, async () => {
      const runtime = this.requireMutableRuntime(input.runtimeId, input.context);
      if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) {
        throw new AgentWorkspaceProviderError('invalid_input', 'Port must be an integer from 1 to 65535.');
      }
      const id = opaqueId('endpoint', {
        runtimeId: runtime.runtimeId,
        port: input.port,
        protocol: input.protocol,
        kind: input.endpointKind,
      });
      const existing = runtime.endpoints.find(endpoint => endpoint.id === id);
      if (existing) return clone(existing);
      if (runtime.endpoints.length >= AGENT_WORKSPACE_RUNTIME_LIMITS.maxEndpoints) {
        throw new AgentWorkspaceProviderError('invalid_state', 'Endpoint limit reached.');
      }
      const endpoint: AgentWorkspaceEndpointV1 = {
        id,
        kind: input.endpointKind,
        connectionRef: opaqueId('port', {runtimeId: runtime.runtimeId, port: input.port, protocol: input.protocol}),
        expiresAt: runtime.ttl.expiresAt,
      };
      runtime.endpoints.push(endpoint);
      this.touch(runtime);
      return clone(endpoint);
    });
  }

  async checkpoint(input: AgentWorkspaceCheckpointInputV1): Promise<AgentWorkspaceCheckpointV1> {
    return await this.mutate('checkpoint', input.context, input, async () => {
      const runtime = this.requireMutableRuntime(input.runtimeId, input.context);
      if (runtime.checkpoints.length >= AGENT_WORKSPACE_RUNTIME_LIMITS.maxCheckpoints) {
        throw new AgentWorkspaceProviderError('invalid_state', 'Checkpoint limit reached.');
      }
      if (runtime.artifacts.length >= AGENT_WORKSPACE_RUNTIME_LIMITS.maxArtifacts) {
        throw new AgentWorkspaceProviderError('invalid_state', 'Artifact limit reached.');
      }
      const headSha = await this.checkpointHead(runtime, input.headSha);
      if (headSha !== input.headSha) {
        throw new AgentWorkspaceProviderError('invalid_input', 'Checkpoint head does not match the workspace HEAD.');
      }
      const createdAt = this.now();
      const checkpoint: AgentWorkspaceCheckpointV1 = {
        id: opaqueId('checkpoint', {runtimeId: runtime.runtimeId, headSha, count: runtime.checkpoints.length}),
        createdAt,
        headSha,
        artifactRef: opaqueId('checkpoint-ref', {runtimeId: runtime.runtimeId, headSha}),
        digest: digest(`${runtime.runtimeId}:${headSha}`),
      };
      runtime.checkpoints.push(checkpoint);
      runtime.artifacts.push({
        kind: 'checkpoint',
        ref: checkpoint.artifactRef,
        digest: checkpoint.digest,
        createdAt,
      });
      this.touch(runtime);
      return clone(checkpoint);
    });
  }

  async heartbeat(input: AgentWorkspaceHeartbeatInputV1): Promise<AgentWorkspaceRuntimeV1> {
    return await this.mutate('heartbeat', input.context, input, async () => {
      const runtime = this.requireRuntime(input.runtimeId);
      this.assertLease(runtime, input.context);
      if (!['ready', 'active', 'interrupted'].includes(runtime.state)) {
        throw new AgentWorkspaceProviderError('invalid_state', `Runtime cannot heartbeat while ${runtime.state}.`);
      }
      const heartbeatAt = this.now();
      if (Date.parse(input.leaseExpiresAt) <= Date.parse(heartbeatAt)
        || Date.parse(input.leaseExpiresAt) > Date.parse(runtime.ttl.expiresAt)) {
        throw new AgentWorkspaceProviderError(
          'invalid_input',
          'Lease expiry must be after the heartbeat and no later than the workspace TTL.',
        );
      }
      runtime.lease.heartbeatAt = heartbeatAt;
      runtime.lease.expiresAt = input.leaseExpiresAt;
      if (runtime.state === 'interrupted') this.transition(runtime, 'ready');
      else this.touch(runtime);
      return this.read(runtime.runtimeId);
    });
  }

  async terminate(input: AgentWorkspaceTerminateInputV1): Promise<AgentWorkspaceRuntimeV1> {
    return await this.mutate('terminate', input.context, input, async () => {
      const runtime = this.requireRuntime(input.runtimeId);
      this.assertLease(runtime, input.context, true);
      if (runtime.state === 'terminated') return this.read(runtime.runtimeId);
      await this.terminateResource(runtime);
      if (runtime.state === 'failed') runtime.failure = null;
      this.transition(runtime, 'terminating');
      this.transition(runtime, 'terminated');
      return this.read(runtime.runtimeId);
    });
  }

  async publishEvidence(input: AgentWorkspacePublishEvidenceInputV1): Promise<AgentWorkspaceArtifactV1[]> {
    return await this.mutate('publishEvidence', input.context, input, async () => {
      const runtime = this.requireMutableRuntime(input.runtimeId, input.context);
      if (input.verification.planId !== runtime.binding.verification.planId
        || input.verification.planVersion !== runtime.binding.verification.planVersion) {
        throw new AgentWorkspaceProviderError('invalid_input', 'Verification identity does not match the workspace binding.');
      }
      if (runtime.artifacts.length + input.artifacts.length + 1 > AGENT_WORKSPACE_RUNTIME_LIMITS.maxArtifacts) {
        throw new AgentWorkspaceProviderError('invalid_state', 'Artifact limit reached.');
      }
      for (const artifact of input.artifacts) assertReference(artifact.ref, 'artifact.ref');
      runtime.artifacts.push(...clone(input.artifacts));
      const receipt: AgentWorkspaceArtifactV1 = {
        kind: 'publish_receipt',
        ref: opaqueId('publish', {
          runtimeId: runtime.runtimeId,
          plan: input.verification,
          step: input.verificationStepId,
          attempt: input.attemptId,
          artifacts: input.artifacts.map(artifact => artifact.digest),
        }),
        digest: digest(JSON.stringify(input.artifacts.map(artifact => artifact.digest))),
        createdAt: this.now(),
      };
      runtime.artifacts.push(receipt);
      this.touch(runtime);
      return clone([...input.artifacts, receipt]);
    });
  }

  read(runtimeId: string): AgentWorkspaceRuntimeV1 {
    return clone(this.requireRuntime(runtimeId));
  }

  stateHistory(runtimeId: string): AgentWorkspaceRuntimeState[] {
    const history = this.histories.get(runtimeId);
    if (!history) throw new AgentWorkspaceProviderError('not_found', `Runtime not found: ${runtimeId}`);
    return [...history];
  }

  readArtifact(ref: string): Buffer | undefined {
    const value = this.artifacts.get(ref);
    return value ? Buffer.from(value) : undefined;
  }

  /** Deterministic fault injection for lifecycle and recovery tests. */
  interrupt(runtimeId: string): AgentWorkspaceRuntimeV1 {
    const runtime = this.requireRuntime(runtimeId);
    this.transition(runtime, 'interrupted');
    return this.read(runtimeId);
  }

  /** Deterministic terminal failure injection for provider conformance tests. */
  fail(runtimeId: string, code = 'injected_failure'): AgentWorkspaceRuntimeV1 {
    const runtime = this.requireRuntime(runtimeId);
    runtime.failure = {code, message: 'Injected provider failure.', retryable: false, failedAt: this.now()};
    this.transition(runtime, 'failed');
    return this.read(runtimeId);
  }

  protected async provisionResource(
    _input: AgentWorkspaceProvisionInputV1,
    _runtime: AgentWorkspaceRuntimeV1,
  ): Promise<void> {}

  protected async rollbackProvisionResource(_runtime: AgentWorkspaceRuntimeV1): Promise<void> {}

  protected async terminateResource(_runtime: AgentWorkspaceRuntimeV1): Promise<void> {}

  protected async checkpointHead(_runtime: AgentWorkspaceRuntimeV1, requestedHead: string): Promise<string> {
    return requestedHead;
  }

  protected connectionRef(runtime: AgentWorkspaceRuntimeV1, kind: string): string {
    return opaqueId('fake-endpoint', {runtimeId: runtime.runtimeId, kind});
  }

  protected async executeCommand(
    _runtime: AgentWorkspaceRuntimeV1,
    input: AgentWorkspaceExecInputV1,
  ): Promise<BoundedCommandResult> {
    const stdout = Buffer.from(`fake:${input.argv.join(' ')}\n`);
    return {exitCode: 0, timedOut: false, stdout, stderr: Buffer.alloc(0)};
  }

  protected requireRuntime(runtimeId: string): AgentWorkspaceRuntimeV1 {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) throw new AgentWorkspaceProviderError('not_found', `Runtime not found: ${runtimeId}`);
    return runtime;
  }

  protected now(): string {
    return this.nowFn().toISOString();
  }

  protected hydrate(runtime: AgentWorkspaceRuntimeV1, history: AgentWorkspaceRuntimeState[]): void {
    this.validate(runtime);
    this.runtimes.set(runtime.runtimeId, clone(runtime));
    this.runtimeByWorkItem.set(runtime.binding.workItemId, runtime.runtimeId);
    this.histories.set(runtime.runtimeId, [...history]);
  }

  private requireMutableRuntime(
    runtimeId: string,
    context: AgentWorkspaceOperationContextV1,
  ): AgentWorkspaceRuntimeV1 {
    const runtime = this.requireRuntime(runtimeId);
    this.assertLease(runtime, context);
    if (!['ready', 'active', 'interrupted'].includes(runtime.state)) {
      throw new AgentWorkspaceProviderError('invalid_state', `Runtime is not mutable while ${runtime.state}.`);
    }
    return runtime;
  }

  private assertContextBinding(context: AgentWorkspaceOperationContextV1, workItemId: string): void {
    if (context.workItemId !== workItemId || context.leaseGeneration < 1) {
      throw new AgentWorkspaceProviderError('lease_mismatch', 'Operation context does not match the work item lease.');
    }
  }

  private assertLease(
    runtime: AgentWorkspaceRuntimeV1,
    context: AgentWorkspaceOperationContextV1,
    permitExpired = false,
  ): void {
    this.assertContextBinding(context, runtime.binding.workItemId);
    if (context.leaseGeneration !== runtime.lease.generation) {
      throw new AgentWorkspaceProviderError('lease_mismatch', 'Lease generation does not own this workspace.');
    }
    if (!permitExpired && Date.parse(runtime.lease.expiresAt) <= Date.parse(this.now())) {
      if (['provisioning', 'ready', 'active'].includes(runtime.state)) this.transition(runtime, 'interrupted');
      throw new AgentWorkspaceProviderError('lease_expired', 'Workspace lease has expired.');
    }
  }

  private assertExecInput(input: AgentWorkspaceExecInputV1): void {
    if (input.cwdRef !== 'workspace') {
      throw new AgentWorkspaceProviderError('invalid_input', 'Only the bounded workspace cwdRef is supported.');
    }
    if (input.environmentContractRef !== null) {
      throw new AgentWorkspaceProviderError(
        'unsupported_environment',
        'Local execution does not materialize environment contracts or secrets.',
      );
    }
    if (input.argv.length === 0 || input.argv.length > AGENT_WORKSPACE_RUNTIME_LIMITS.maxArgvEntries
      || input.argv.some(arg => arg.length === 0 || arg.length > AGENT_WORKSPACE_RUNTIME_LIMITS.maxArgLength)) {
      throw new AgentWorkspaceProviderError('invalid_input', 'argv is empty or exceeds the V1 bounds.');
    }
    if (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds < 1
      || input.timeoutSeconds > AGENT_WORKSPACE_RUNTIME_LIMITS.maxTimeoutSeconds) {
      throw new AgentWorkspaceProviderError('invalid_input', 'timeoutSeconds exceeds the V1 bounds.');
    }
  }

  private captureLog(
    runtime: AgentWorkspaceRuntimeV1,
    bytes: Buffer,
    stream: 'stdout' | 'stderr',
    createdAt: string,
  ): string | null {
    if (bytes.length === 0) return null;
    const ref = opaqueId('log', {runtimeId: runtime.runtimeId, stream, digest: digest(bytes)});
    this.artifacts.set(ref, Buffer.from(bytes));
    runtime.artifacts.push({kind: 'log', ref, digest: digest(bytes), createdAt});
    return ref;
  }

  private transition(runtime: AgentWorkspaceRuntimeV1, state: AgentWorkspaceRuntimeState): void {
    if (runtime.state === state) return;
    if (!canTransitionAgentWorkspaceRuntime(runtime.state, state)) {
      throw new AgentWorkspaceProviderError(
        'invalid_state',
        `Invalid workspace runtime transition: ${runtime.state} -> ${state}.`,
      );
    }
    runtime.state = state;
    runtime.updatedAt = this.now();
    this.histories.get(runtime.runtimeId)?.push(state);
    this.validate(runtime);
  }

  private touch(runtime: AgentWorkspaceRuntimeV1): void {
    runtime.updatedAt = this.now();
    this.validate(runtime);
  }

  private validate(runtime: AgentWorkspaceRuntimeV1): void {
    const violations = validateProviderRuntime(runtime);
    if (violations.length > 0) {
      throw new AgentWorkspaceProviderError(
        'invalid_state',
        `Provider produced an invalid runtime: ${violations.join(', ')}`,
      );
    }
  }

  private async mutate<T>(
    operation: string,
    context: AgentWorkspaceOperationContextV1,
    input: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = context.idempotencyKey;
    assertIdentifier(key, 'idempotencyKey');
    const inputFingerprint = fingerprint({operation, input});
    const existing = this.idempotency.get(key) as IdempotencyRecord<T> | undefined;
    if (existing) {
      if (existing.fingerprint !== inputFingerprint) {
        throw new AgentWorkspaceProviderError(
          'idempotency_conflict',
          'Idempotency key was already used with a different operation or payload.',
        );
      }
      return clone(await existing.promise);
    }
    const promise = action();
    this.idempotency.set(key, {fingerprint: inputFingerprint, promise});
    try {
      return clone(await promise);
    } catch (error) {
      this.idempotency.delete(key);
      throw error;
    }
  }
}

export interface LocalWorktreeProviderOptions extends AgentWorkspaceProviderOptions {
  driver: LocalWorkspaceDriver;
}

export class LocalWorktreeAgentWorkspaceRuntimeProvider extends FakeAgentWorkspaceRuntimeProvider {
  private readonly driver: LocalWorkspaceDriver;
  private readonly handles = new Map<string, LocalWorkspaceHandle>();

  constructor(options: LocalWorktreeProviderOptions) {
    super(options);
    this.driver = options.driver;
  }

  override async preflight(input: AgentWorkspacePreflightInputV1): Promise<AgentWorkspacePreflightResultV1> {
    if (input.template.provider !== 'local-worktree') {
      return {
        ok: false,
        checks: {provider: false},
        reasonCode: 'unsupported_provider',
      };
    }
    return await this.driver.preflight(input);
  }

  protected override async provisionResource(
    input: AgentWorkspaceProvisionInputV1,
    runtime: AgentWorkspaceRuntimeV1,
  ): Promise<void> {
    const handle = await this.driver.provision(input);
    this.handles.set(runtime.runtimeId, handle);
    if (handle.baseSha !== input.binding.baseSha || handle.branch !== input.binding.branch) {
      throw new AgentWorkspaceProviderError('invalid_state', 'Worktree driver returned a mismatched binding.');
    }
  }

  protected override async terminateResource(runtime: AgentWorkspaceRuntimeV1): Promise<void> {
    const handle = this.handles.get(runtime.runtimeId);
    if (!handle) throw new AgentWorkspaceProviderError('invalid_state', 'Local workspace handle is unavailable.');
    await this.driver.terminate(handle);
    this.handles.delete(runtime.runtimeId);
  }

  protected override async rollbackProvisionResource(runtime: AgentWorkspaceRuntimeV1): Promise<void> {
    const handle = this.handles.get(runtime.runtimeId);
    if (!handle) return;
    try {
      await this.driver.terminate(handle);
    } finally {
      this.handles.delete(runtime.runtimeId);
    }
  }

  protected override async checkpointHead(runtime: AgentWorkspaceRuntimeV1): Promise<string> {
    const handle = this.handles.get(runtime.runtimeId);
    if (!handle) throw new AgentWorkspaceProviderError('invalid_state', 'Local workspace handle is unavailable.');
    return await this.driver.currentHead(handle);
  }

  protected override connectionRef(runtime: AgentWorkspaceRuntimeV1, kind: string): string {
    return opaqueId('local-endpoint', {runtimeId: runtime.runtimeId, kind});
  }

  protected override async executeCommand(
    runtime: AgentWorkspaceRuntimeV1,
    input: AgentWorkspaceExecInputV1,
  ): Promise<BoundedCommandResult> {
    const handle = this.handles.get(runtime.runtimeId);
    if (!handle) throw new AgentWorkspaceProviderError('invalid_state', 'Local workspace handle is unavailable.');
    return await runBoundedCommand(input.argv, handle.worktreePath, input.timeoutSeconds);
  }
}

export const AGENT_WORKSPACE_RUNTIME_VERSION = 1 as const;

export const AGENT_WORKSPACE_RUNTIME_STATES = [
  'requested',
  'provisioning',
  'ready',
  'active',
  'interrupted',
  'terminating',
  'terminated',
  'failed',
] as const;

export const AGENT_WORKSPACE_RUNTIME_LIMITS = {
  maxBytes: 128_000,
  maxStringLength: 2_000,
  maxEndpoints: 20,
  maxCheckpoints: 50,
  maxArtifacts: 200,
  maxMetrics: 500,
  maxArgvEntries: 200,
  maxArgLength: 4_000,
  maxTimeoutSeconds: 86_400,
} as const;

export type AgentWorkspaceRuntimeState = (typeof AGENT_WORKSPACE_RUNTIME_STATES)[number];
export type AgentWorkspaceEndpointKind = 't3' | 'terminal' | 'preview' | 'mcp';
export type AgentWorkspaceArtifactKind =
  | 'checkpoint'
  | 'verification'
  | 'browser_trace'
  | 'screenshot'
  | 'video'
  | 'log'
  | 'publish_receipt';

export interface AgentWorkspaceVerificationIdentityV1 {
  planId: string;
  planVersion: number;
}

export interface AgentWorkspaceBindingV1 {
  workItemId: string;
  workContractVersion: 1;
  verification: AgentWorkspaceVerificationIdentityV1;
  repositoryId: string;
  repository: string;
  baseRef: string;
  baseSha: string;
  branch: string;
}

export interface AgentWorkspaceTemplateV1 {
  templateId: string;
  templateDigest: string;
  provider: string;
  region: string;
  resourceClass: string;
}

export interface AgentWorkspaceEndpointV1 {
  id: string;
  kind: AgentWorkspaceEndpointKind;
  connectionRef: string;
  expiresAt: string | null;
}

export interface AgentWorkspaceCheckpointV1 {
  id: string;
  createdAt: string;
  headSha: string;
  artifactRef: string;
  digest: string;
}

export interface AgentWorkspaceArtifactV1 {
  kind: AgentWorkspaceArtifactKind;
  ref: string;
  digest: string;
  createdAt: string;
}

export interface AgentWorkspaceRuntimeV1 {
  version: typeof AGENT_WORKSPACE_RUNTIME_VERSION;
  runtimeId: string;
  state: AgentWorkspaceRuntimeState;
  binding: AgentWorkspaceBindingV1;
  template: AgentWorkspaceTemplateV1;
  lease: {
    ownerFingerprint: string;
    generation: number;
    heartbeatAt: string;
    expiresAt: string;
  };
  ttl: {
    expiresAt: string;
    terminationGraceSeconds: number;
  };
  endpoints: AgentWorkspaceEndpointV1[];
  checkpoints: AgentWorkspaceCheckpointV1[];
  artifacts: AgentWorkspaceArtifactV1[];
  metrics: Array<{
    capturedAt: string;
    cpuPercent: number;
    memoryBytes: number;
    diskBytes: number;
  }>;
  failure: {
    code: string;
    message: string;
    retryable: boolean;
    failedAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentWorkspaceOperationContextV1 {
  operationId: string;
  idempotencyKey: string;
  workItemId: string;
  leaseGeneration: number;
}

export interface AgentWorkspacePreflightInputV1 {
  template: AgentWorkspaceTemplateV1;
  context: AgentWorkspaceOperationContextV1;
}

export interface AgentWorkspacePreflightResultV1 {
  ok: boolean;
  checks: Record<string, boolean>;
  reasonCode: string | null;
}

export interface AgentWorkspaceProvisionInputV1 {
  binding: AgentWorkspaceBindingV1;
  template: AgentWorkspaceTemplateV1;
  ttl: AgentWorkspaceRuntimeV1['ttl'];
  context: AgentWorkspaceOperationContextV1;
}

export interface AgentWorkspaceAttachInputV1 {
  runtimeId: string;
  endpointKind: AgentWorkspaceEndpointKind;
  context: AgentWorkspaceOperationContextV1;
}

export interface AgentWorkspaceExecInputV1 {
  runtimeId: string;
  argv: string[];
  cwdRef: string;
  environmentContractRef: string | null;
  timeoutSeconds: number;
  context: AgentWorkspaceOperationContextV1;
}

export interface AgentWorkspaceExecResultV1 {
  exitCode: number;
  timedOut: boolean;
  startedAt: string;
  endedAt: string;
  stdoutArtifactRef: string | null;
  stderrArtifactRef: string | null;
}

export interface AgentWorkspaceExposePortInputV1 {
  runtimeId: string;
  port: number;
  protocol: 'http' | 'https' | 'tcp';
  endpointKind: AgentWorkspaceEndpointKind;
  context: AgentWorkspaceOperationContextV1;
}

export interface AgentWorkspaceCheckpointInputV1 {
  runtimeId: string;
  headSha: string;
  context: AgentWorkspaceOperationContextV1;
}

export interface AgentWorkspaceHeartbeatInputV1 {
  runtimeId: string;
  leaseExpiresAt: string;
  context: AgentWorkspaceOperationContextV1;
}

export interface AgentWorkspaceTerminateInputV1 {
  runtimeId: string;
  reasonCode: string;
  context: AgentWorkspaceOperationContextV1;
}

export interface AgentWorkspacePublishEvidenceInputV1 {
  runtimeId: string;
  verification: AgentWorkspaceVerificationIdentityV1;
  verificationStepId: string;
  attemptId: string;
  artifacts: AgentWorkspaceArtifactV1[];
  context: AgentWorkspaceOperationContextV1;
}

export interface AgentWorkspaceRuntimeProviderV1 {
  preflight(input: AgentWorkspacePreflightInputV1): Promise<AgentWorkspacePreflightResultV1>;
  provision(input: AgentWorkspaceProvisionInputV1): Promise<AgentWorkspaceRuntimeV1>;
  attach(input: AgentWorkspaceAttachInputV1): Promise<AgentWorkspaceEndpointV1>;
  exec(input: AgentWorkspaceExecInputV1): Promise<AgentWorkspaceExecResultV1>;
  exposePort(input: AgentWorkspaceExposePortInputV1): Promise<AgentWorkspaceEndpointV1>;
  checkpoint(input: AgentWorkspaceCheckpointInputV1): Promise<AgentWorkspaceCheckpointV1>;
  heartbeat(input: AgentWorkspaceHeartbeatInputV1): Promise<AgentWorkspaceRuntimeV1>;
  terminate(input: AgentWorkspaceTerminateInputV1): Promise<AgentWorkspaceRuntimeV1>;
  publishEvidence(input: AgentWorkspacePublishEvidenceInputV1): Promise<AgentWorkspaceArtifactV1[]>;
}

const TRANSITIONS: Record<AgentWorkspaceRuntimeState, readonly AgentWorkspaceRuntimeState[]> = {
  requested: ['provisioning', 'terminating', 'failed'],
  provisioning: ['ready', 'interrupted', 'terminating', 'failed'],
  ready: ['active', 'interrupted', 'terminating', 'failed'],
  active: ['ready', 'interrupted', 'terminating', 'failed'],
  interrupted: ['provisioning', 'ready', 'terminating', 'failed'],
  terminating: ['terminated', 'failed'],
  terminated: [],
  failed: ['terminating'],
};

export function canTransitionAgentWorkspaceRuntime(
  from: AgentWorkspaceRuntimeState,
  to: AgentWorkspaceRuntimeState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function validateProviderRuntime(runtime: AgentWorkspaceRuntimeV1): string[] {
  const violations: string[] = [];
  const serialized = JSON.stringify(runtime);
  if (Buffer.byteLength(serialized) > AGENT_WORKSPACE_RUNTIME_LIMITS.maxBytes) violations.push('runtime:too_large');
  if (runtime.version !== AGENT_WORKSPACE_RUNTIME_VERSION) violations.push('version:unsupported');
  if (!AGENT_WORKSPACE_RUNTIME_STATES.includes(runtime.state)) violations.push('state:unsupported');
  if (runtime.endpoints.length > AGENT_WORKSPACE_RUNTIME_LIMITS.maxEndpoints) violations.push('endpoints:too_many');
  if (runtime.checkpoints.length > AGENT_WORKSPACE_RUNTIME_LIMITS.maxCheckpoints) violations.push('checkpoints:too_many');
  if (runtime.artifacts.length > AGENT_WORKSPACE_RUNTIME_LIMITS.maxArtifacts) violations.push('artifacts:too_many');
  if (runtime.metrics.length > AGENT_WORKSPACE_RUNTIME_LIMITS.maxMetrics) violations.push('metrics:too_many');
  if (new Set(runtime.endpoints.map(item => item.id)).size !== runtime.endpoints.length) violations.push('endpoints:duplicate_id');
  if (new Set(runtime.checkpoints.map(item => item.id)).size !== runtime.checkpoints.length) violations.push('checkpoints:duplicate_id');
  if ((runtime.state === 'failed') !== (runtime.failure !== null)) violations.push('failure:state_mismatch');
  if (Date.parse(runtime.createdAt) > Date.parse(runtime.updatedAt)) violations.push('updatedAt:invalid_order');
  if (Date.parse(runtime.createdAt) >= Date.parse(runtime.ttl.expiresAt)) violations.push('ttl.expiresAt:invalid_order');
  return violations;
}

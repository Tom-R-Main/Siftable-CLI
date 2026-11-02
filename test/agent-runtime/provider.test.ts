import type {
  AgentWorkspaceArtifactV1,
  AgentWorkspaceOperationContextV1,
  AgentWorkspaceProvisionInputV1,
  AgentWorkspaceRuntimeV1,
} from '@execufunction/shared';
import {
  AGENT_WORKSPACE_RUNTIME_LIMITS as SHARED_RUNTIME_LIMITS,
  AGENT_WORKSPACE_RUNTIME_STATES as SHARED_RUNTIME_STATES,
  AGENT_WORKSPACE_RUNTIME_VERSION as SHARED_RUNTIME_VERSION,
  canTransitionAgentWorkspaceRuntime as sharedCanTransition,
} from '@execufunction/shared';
import {
  AgentWorkspaceProviderError,
  FakeAgentWorkspaceRuntimeProvider,
} from '../../src/lib/agent-runtime';
import {
  AGENT_WORKSPACE_RUNTIME_LIMITS,
  AGENT_WORKSPACE_RUNTIME_STATES,
  AGENT_WORKSPACE_RUNTIME_VERSION,
  canTransitionAgentWorkspaceRuntime,
} from '../../src/lib/agent-runtime/contract';

const BASE_SHA = 'a'.repeat(40);
const TEMPLATE_DIGEST = `sha256:${'b'.repeat(64)}`;
const ARTIFACT_DIGEST = `sha256:${'c'.repeat(64)}`;

function context(suffix: string, generation = 1): AgentWorkspaceOperationContextV1 {
  return {
    operationId: `operation:${suffix}`,
    idempotencyKey: `idempotency:${suffix}`,
    workItemId: 'work-item-02',
    leaseGeneration: generation,
  };
}

function provisionInput(operation = context('provision')): AgentWorkspaceProvisionInputV1 {
  return {
    binding: {
      workItemId: 'work-item-02',
      workContractVersion: 1,
      verification: {planId: 'plan-02', planVersion: 1},
      repositoryId: 'repository-02',
      repository: 'siftable/execufunction',
      baseRef: 'refs/heads/main',
      baseSha: BASE_SHA,
      branch: 'sift/runtime-02-abcdef',
    },
    template: {
      templateId: 'fake-template',
      templateDigest: TEMPLATE_DIGEST,
      provider: 'fake',
      region: 'local',
      resourceClass: 'test',
    },
    ttl: {expiresAt: '2030-01-01T01:00:00.000Z', terminationGraceSeconds: 5},
    context: operation,
  };
}

describe('FakeAgentWorkspaceRuntimeProvider', () => {
  let now: Date;
  let provider: FakeAgentWorkspaceRuntimeProvider;

  beforeEach(() => {
    now = new Date('2030-01-01T00:00:00.000Z');
    provider = new FakeAgentWorkspaceRuntimeProvider({now: () => now});
  });

  it('keeps the packaged provider contract aligned with the canonical workspace contract', () => {
    expect(AGENT_WORKSPACE_RUNTIME_VERSION).toBe(SHARED_RUNTIME_VERSION);
    expect(AGENT_WORKSPACE_RUNTIME_LIMITS).toEqual(SHARED_RUNTIME_LIMITS);
    expect(AGENT_WORKSPACE_RUNTIME_STATES).toEqual(SHARED_RUNTIME_STATES);
    for (const from of AGENT_WORKSPACE_RUNTIME_STATES) {
      for (const to of AGENT_WORKSPACE_RUNTIME_STATES) {
        expect(canTransitionAgentWorkspaceRuntime(from, to)).toBe(sharedCanTransition(from, to));
      }
    }
  });

  it('deterministically covers the complete V1 lifecycle and replays identical mutations', async () => {
    const input = provisionInput();
    const runtime = await provider.provision(input);
    expect(await provider.provision(input)).toEqual(runtime);
    expect(runtime.state).toBe('ready');

    const attached = await provider.attach({
      runtimeId: runtime.runtimeId,
      endpointKind: 'terminal',
      context: context('attach'),
    });
    expect(attached.connectionRef).not.toContain('secret');

    const port = await provider.exposePort({
      runtimeId: runtime.runtimeId,
      port: 4173,
      protocol: 'http',
      endpointKind: 'preview',
      context: context('port'),
    });
    expect(port.kind).toBe('preview');

    const execution = await provider.exec({
      runtimeId: runtime.runtimeId,
      argv: ['npm', 'test'],
      cwdRef: 'workspace',
      environmentContractRef: null,
      timeoutSeconds: 30,
      context: context('exec'),
    });
    expect(execution).toMatchObject({exitCode: 0, timedOut: false});
    expect(provider.readArtifact(execution.stdoutArtifactRef!)).toEqual(Buffer.from('fake:npm test\n'));

    const checkpoint = await provider.checkpoint({
      runtimeId: runtime.runtimeId,
      headSha: BASE_SHA,
      context: context('checkpoint'),
    });
    expect(checkpoint.artifactRef).not.toContain(BASE_SHA);

    provider.interrupt(runtime.runtimeId);
    now = new Date('2030-01-01T00:01:00.000Z');
    const revived = await provider.heartbeat({
      runtimeId: runtime.runtimeId,
      leaseExpiresAt: '2030-01-01T00:30:00.000Z',
      context: context('heartbeat'),
    });
    expect(revived.state).toBe('ready');

    const artifact: AgentWorkspaceArtifactV1 = {
      kind: 'verification',
      ref: 'verification:result-02',
      digest: ARTIFACT_DIGEST,
      createdAt: '2030-01-01T00:01:00.000Z',
    };
    const published = await provider.publishEvidence({
      runtimeId: runtime.runtimeId,
      verification: {planId: 'plan-02', planVersion: 1},
      verificationStepId: 'step-02',
      attemptId: 'attempt-02',
      artifacts: [artifact],
      context: context('publish'),
    });
    expect(published.map(item => item.kind)).toEqual(['verification', 'publish_receipt']);

    provider.fail(runtime.runtimeId);
    const terminated = await provider.terminate({
      runtimeId: runtime.runtimeId,
      reasonCode: 'test_complete',
      context: context('terminate'),
    });
    expect(terminated.state).toBe('terminated');
    expect(provider.stateHistory(runtime.runtimeId)).toEqual(expect.arrayContaining([
      'requested',
      'provisioning',
      'ready',
      'active',
      'interrupted',
      'failed',
      'terminating',
      'terminated',
    ]));
  });

  it('rejects idempotency-key reuse with a different payload', async () => {
    const input = provisionInput();
    await provider.provision(input);
    await expect(provider.provision({
      ...input,
      ttl: {...input.ttl, terminationGraceSeconds: 10},
    })).rejects.toMatchObject<Partial<AgentWorkspaceProviderError>>({code: 'idempotency_conflict'});
  });

  it('removes failed provisioning registrations so a later attempt can retry', async () => {
    class FlakyProvider extends FakeAgentWorkspaceRuntimeProvider {
      attempts = 0;

      protected override async provisionResource(
        _input: AgentWorkspaceProvisionInputV1,
        _runtime: AgentWorkspaceRuntimeV1,
      ): Promise<void> {
        this.attempts += 1;
        if (this.attempts === 1) throw new Error('transient provisioning failure');
      }
    }

    const flaky = new FlakyProvider({now: () => now});
    await expect(flaky.provision(provisionInput())).rejects.toThrow('transient provisioning failure');

    const retried = await flaky.provision(provisionInput(context('provision-retry')));
    expect(retried.state).toBe('ready');
    expect(flaky.attempts).toBe(2);
  });

  it('enforces lease generation, cwd, environment, and opaque evidence references', async () => {
    const runtime = await provider.provision(provisionInput());
    await expect(provider.attach({
      runtimeId: runtime.runtimeId,
      endpointKind: 'terminal',
      context: context('wrong-generation', 2),
    })).rejects.toMatchObject<Partial<AgentWorkspaceProviderError>>({code: 'lease_mismatch'});

    await expect(provider.exec({
      runtimeId: runtime.runtimeId,
      argv: ['pwd'],
      cwdRef: '/tmp',
      environmentContractRef: null,
      timeoutSeconds: 1,
      context: context('bad-cwd'),
    })).rejects.toMatchObject<Partial<AgentWorkspaceProviderError>>({code: 'invalid_input'});

    await expect(provider.exec({
      runtimeId: runtime.runtimeId,
      argv: ['env'],
      cwdRef: 'workspace',
      environmentContractRef: 'vault-contract',
      timeoutSeconds: 1,
      context: context('bad-env'),
    })).rejects.toMatchObject<Partial<AgentWorkspaceProviderError>>({code: 'unsupported_environment'});

    await expect(provider.publishEvidence({
      runtimeId: runtime.runtimeId,
      verification: {planId: 'plan-02', planVersion: 1},
      verificationStepId: 'step-02',
      attemptId: 'attempt-02',
      artifacts: [{
        kind: 'verification',
        ref: 'secret:plaintext',
        digest: ARTIFACT_DIGEST,
        createdAt: '2030-01-01T00:00:00.000Z',
      }],
      context: context('bad-reference'),
    })).rejects.toMatchObject<Partial<AgentWorkspaceProviderError>>({code: 'unsafe_reference'});
  });
});

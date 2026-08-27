import {mkdtemp, mkdir, realpath, rm, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {
  AgentWorkspaceOperationContextV1,
  AgentWorkspaceProvisionInputV1,
} from '@execufunction/shared';
import {
  createAgentRuntimeWorktreeDriver,
  createGitRunner,
  listChildWorktrees,
  resolveCommit,
  WorktreeError,
  type GitRunner,
} from '../../interactive-tui/worktreeService';
import {
  AgentWorkspaceProviderError,
  LocalWorktreeAgentWorkspaceRuntimeProvider,
} from '../../src/lib/agent-runtime';

const TEMPLATE_DIGEST = `sha256:${'d'.repeat(64)}`;

function context(suffix: string): AgentWorkspaceOperationContextV1 {
  return {
    operationId: `operation:${suffix}`,
    idempotencyKey: `idempotency:${suffix}`,
    workItemId: 'local-work-item-02',
    leaseGeneration: 1,
  };
}

async function setupRepo(): Promise<{
  repoRoot: string;
  worktreesRoot: string;
  baseSha: string;
  git: GitRunner;
  cleanup: () => Promise<void>;
}> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'sift-runtime-local-')));
  const repoRoot = join(base, 'repo');
  const worktreesRoot = join(base, 'worktrees');
  await mkdir(repoRoot, {recursive: true});
  await mkdir(worktreesRoot, {recursive: true});
  const git = createGitRunner();
  const run = (args: string[]) => {
    const result = git(args, repoRoot);
    if (result.status !== 0) throw new Error(result.stderr || result.spawnError);
  };
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'test@siftable.io']);
  run(['config', 'user.name', 'Sift Test']);
  run(['config', 'commit.gpgsign', 'false']);
  await writeFile(join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  run(['add', '.']);
  run(['commit', '-m', 'initial']);
  const canonicalRepo = await realpath(repoRoot);
  const baseSha = resolveCommit(canonicalRepo, 'HEAD', git)!;
  return {repoRoot: canonicalRepo, worktreesRoot, baseSha, git, cleanup: () => rm(base, {recursive: true, force: true})};
}

function provisionInput(baseSha: string, suffix: string): AgentWorkspaceProvisionInputV1 {
  return {
    binding: {
      workItemId: 'local-work-item-02',
      workContractVersion: 1,
      verification: {planId: 'local-plan-02', planVersion: 1},
      repositoryId: 'local-repository-02',
      repository: 'siftable/execufunction',
      baseRef: 'refs/heads/main',
      baseSha,
      branch: 'sift/runtime-02-local-abcdef',
    },
    template: {
      templateId: 'local-template',
      templateDigest: TEMPLATE_DIGEST,
      provider: 'local-worktree',
      region: 'local',
      resourceClass: 'worktree',
    },
    ttl: {expiresAt: '2030-01-01T01:00:00.000Z', terminationGraceSeconds: 5},
    context: context(suffix),
  };
}

async function expectProcessExit(pid: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  expect(() => process.kill(pid, 0)).toThrow();
}

describe('LocalWorktreeAgentWorkspaceRuntimeProvider', () => {
  it('provisions from an immutable SHA, executes bounded argv, and recovers after provider restart', async () => {
    const fixture = await setupRepo();
    try {
      const now = () => new Date('2030-01-01T00:00:00.000Z');
      const driver = createAgentRuntimeWorktreeDriver({
        repoRoot: fixture.repoRoot,
        layout: {worktreesRoot: fixture.worktreesRoot},
      }, fixture.git);
      const provider = new LocalWorktreeAgentWorkspaceRuntimeProvider({driver, now});
      const input = provisionInput(fixture.baseSha, 'provision');
      const runtime = await provider.provision(input);
      expect(await provider.provision(input)).toEqual(runtime);

      const children = listChildWorktrees(fixture.repoRoot, fixture.git);
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({branch: input.binding.branch, head: fixture.baseSha});

      process.env.SIFT_RUNTIME_TEST_SECRET = 'must-not-cross-runtime-boundary';
      const execution = await provider.exec({
        runtimeId: runtime.runtimeId,
        argv: [
          process.execPath,
          '-e',
          'process.stdout.write(process.env.SIFT_RUNTIME_TEST_SECRET ? "leaked" : "local-ok")',
        ],
        cwdRef: 'workspace',
        environmentContractRef: null,
        timeoutSeconds: 5,
        context: context('exec'),
      }).finally(() => {
        delete process.env.SIFT_RUNTIME_TEST_SECRET;
      });
      expect(execution).toMatchObject({exitCode: 0, timedOut: false});
      expect(provider.readArtifact(execution.stdoutArtifactRef!)?.toString('utf8')).toBe('local-ok');

      const recoveredProvider = new LocalWorktreeAgentWorkspaceRuntimeProvider({driver, now});
      const recovered = await recoveredProvider.provision(provisionInput(fixture.baseSha, 'recover'));
      expect(recovered.runtimeId).toBe(runtime.runtimeId);
      expect(recovered.state).toBe('ready');

      const checkpoint = await recoveredProvider.checkpoint({
        runtimeId: recovered.runtimeId,
        headSha: fixture.baseSha,
        context: context('checkpoint'),
      });
      expect(checkpoint.headSha).toBe(fixture.baseSha);

      const terminal = await recoveredProvider.attach({
        runtimeId: recovered.runtimeId,
        endpointKind: 'terminal',
        context: context('attach'),
      });
      expect(terminal.connectionRef).not.toContain(fixture.worktreesRoot);

      const terminated = await recoveredProvider.terminate({
        runtimeId: recovered.runtimeId,
        reasonCode: 'test_complete',
        context: context('terminate'),
      });
      expect(terminated.state).toBe('terminated');
      expect(listChildWorktrees(fixture.repoRoot, fixture.git)).toHaveLength(0);
      expect(await recoveredProvider.terminate({
        runtimeId: recovered.runtimeId,
        reasonCode: 'test_complete',
        context: context('terminate'),
      })).toEqual(terminated);
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails closed on dirty teardown and out-of-scope execution paths', async () => {
    const fixture = await setupRepo();
    try {
      const driver = createAgentRuntimeWorktreeDriver({
        repoRoot: fixture.repoRoot,
        layout: {worktreesRoot: fixture.worktreesRoot},
      }, fixture.git);
      const provider = new LocalWorktreeAgentWorkspaceRuntimeProvider({
        driver,
        now: () => new Date('2030-01-01T00:00:00.000Z'),
      });
      const runtime = await provider.provision(provisionInput(fixture.baseSha, 'dirty-provision'));
      const child = listChildWorktrees(fixture.repoRoot, fixture.git)[0];
      const dirtyPath = join(child.path, 'uncommitted.txt');
      await writeFile(dirtyPath, 'preserve me\n', 'utf8');

      await expect(provider.terminate({
        runtimeId: runtime.runtimeId,
        reasonCode: 'cleanup',
        context: context('dirty-terminate'),
      })).rejects.toMatchObject<Partial<WorktreeError>>({kind: 'dirty_worktree'});
      expect(provider.read(runtime.runtimeId).state).toBe('ready');
      expect(listChildWorktrees(fixture.repoRoot, fixture.git)).toHaveLength(1);

      await expect(provider.exec({
        runtimeId: runtime.runtimeId,
        argv: ['pwd'],
        cwdRef: '../outside',
        environmentContractRef: null,
        timeoutSeconds: 1,
        context: context('outside'),
      })).rejects.toMatchObject<Partial<AgentWorkspaceProviderError>>({code: 'invalid_input'});

      await unlink(dirtyPath);
      await provider.terminate({
        runtimeId: runtime.runtimeId,
        reasonCode: 'cleanup',
        context: context('clean-terminate'),
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('times out a long-running process without exposing command output in metadata', async () => {
    const fixture = await setupRepo();
    try {
      const driver = createAgentRuntimeWorktreeDriver({
        repoRoot: fixture.repoRoot,
        layout: {worktreesRoot: fixture.worktreesRoot},
      }, fixture.git);
      const provider = new LocalWorktreeAgentWorkspaceRuntimeProvider({
        driver,
        now: () => new Date('2030-01-01T00:00:00.000Z'),
      });
      const runtime = await provider.provision(provisionInput(fixture.baseSha, 'timeout-provision'));
      const result = await provider.exec({
        runtimeId: runtime.runtimeId,
        argv: [
          process.execPath,
          '-e',
          'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"]});process.stdout.write(String(child.pid));setInterval(()=>{},1000)',
        ],
        cwdRef: 'workspace',
        environmentContractRef: null,
        timeoutSeconds: 1,
        context: context('timeout'),
      });
      expect(result).toMatchObject({exitCode: 124, timedOut: true});
      expect(JSON.stringify(result)).not.toContain(fixture.worktreesRoot);
      const descendantPid = Number(provider.readArtifact(result.stdoutArtifactRef!)?.toString('utf8'));
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      if (process.platform !== 'win32') {
        await expectProcessExit(descendantPid);
      }
      await provider.terminate({
        runtimeId: runtime.runtimeId,
        reasonCode: 'cleanup',
        context: context('timeout-terminate'),
      });
    } finally {
      await fixture.cleanup();
    }
  });
});

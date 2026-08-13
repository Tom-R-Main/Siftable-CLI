import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

const publishScope = {
  repository: 'owner/repo',
  branch: 'codex/work-123',
  baseBranch: 'main',
  workItemId: '00000000-0000-4000-8000-000000000123',
  verifiedSha: 'a'.repeat(40),
  title: 'Bounded publisher',
  bodyDigest: 'b'.repeat(64),
};

const runnerMocks = vi.hoisted(() => ({
  assertReviewedExecutableDigest: vi.fn().mockResolvedValue({}),
  buildLocalAdapterInvocation: vi.fn(),
  createExecutionCredentialBinding: vi.fn().mockReturnValue('credential-binding'),
  createExecutionGrantHandleBinding: vi.fn().mockReturnValue('handle-binding'),
  createGitHubPublishScope: vi.fn(),
  createRunnerBinding: vi.fn().mockReturnValue({
    publicKeyPem: 'public-key',
    privateKey: {type: 'private'},
    publicKeyFingerprint: 'c'.repeat(64),
    executablePath: '/usr/bin/git',
    executableDigest: 'd'.repeat(64),
    executableIdentity: {device: 1, inode: 2, size: 3, modifiedMs: 4},
  }),
  decryptExecutionGrantEnvelope: vi.fn(),
  publishReviewedGitHubPr: vi.fn().mockResolvedValue({
    repository: 'owner/repo',
    branch: 'codex/work-123',
    baseBranch: 'main',
    workItemId: '00000000-0000-4000-8000-000000000123',
    verifiedSha: 'a'.repeat(40),
    pullRequestNumber: 42,
    pullRequestUrl: 'https://github.com/owner/repo/pull/42',
    action: 'created',
  }),
  resolveReviewedExecutable: vi.fn().mockResolvedValue({
    path: '/usr/bin/git',
    digest: 'd'.repeat(64),
    identity: {device: 1, inode: 2, size: 3, modifiedMs: 4},
  }),
  runOneReviewedChild: vi.fn(),
}));

vi.mock('../../lib/localExecutionRunner.js', () => runnerMocks);

import GrantsRun from './run.js';

function command<T>(constructor: {prototype: T}): T {
  return Object.create(constructor.prototype) as T;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, {recursive: true, force: true});
  }
});

describe('grants run github_publish_pr', () => {
  it('requests and redeems only the fixed publisher adapter and returns safe metadata', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sift-publish-command-')));
    temporaryRoots.push(root);
    const bodyFile = join(root, 'pr-body.md');
    await writeFile(bodyFile, 'Reviewed body');
    runnerMocks.createGitHubPublishScope.mockReturnValue(publishScope);
    runnerMocks.decryptExecutionGrantEnvelope
      .mockReturnValueOnce({
        kind: 'execution_grant_handle',
        fields: {handle: 'vgrant_opaque'},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      .mockReturnValueOnce({
        kind: 'github_installation_token',
        fields: {token: 'SENTINEL_PUBLISH_TOKEN'},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    const grant = {
      id: 'grant-1',
      approvalId: 'approval-1',
      status: 'pending',
      adapterId: 'github_publish_pr',
      operation: 'publish_pr',
      requestedScope: publishScope,
      executableDigest: 'd'.repeat(64),
      workingDirectory: root,
      containmentTier: 'contained',
      threatDisclosure: 'fixed publisher',
      audience: 'api.github.com',
      issuerId: 'github_app_installation',
      provider: 'github',
      purpose: 'Publish the reviewed work item',
    };
    const apiRequest = vi.fn(async (_flags: unknown, path: string) => {
      if (path === '/api/v1/vault/execution-grants') {
        return {grant, handleEnvelope: {opaque: true}, handleBinding: 'handle-binding'};
      }
      if (path.startsWith('/api/v1/governed-approvals/')) {
        return {approval: {status: 'approved'}};
      }
      if (path === '/api/v1/vault/execution-grants/redeem') {
        return {
          grant,
          envelope: {opaque: true},
          binding: 'credential-binding',
          credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      }
      throw new Error(`unexpected API request: ${path}`);
    });
    const instance = command(GrantsRun);
    (instance as any).parse = vi.fn().mockResolvedValue({
      flags: {
        adapter: 'github_publish_pr',
        operation: 'publish_pr',
        issuer: 'github_app_installation',
        audience: 'api.github.com',
        'vault-entry': 'entry-1',
        'credential-field': 'githubApp',
        scope: JSON.stringify(publishScope),
        purpose: 'Publish the reviewed work item',
        'body-file': bodyFile,
        cwd: root,
        'approval-timeout': 30,
      },
    });
    (instance as any).apiRequest = apiRequest;
    (instance as any).jsonEnabled = () => true;
    (instance as any).log = vi.fn();

    const result = await instance.run();

    expect(apiRequest).toHaveBeenCalledWith(expect.anything(), '/api/v1/vault/execution-grants', {
      method: 'POST',
      body: expect.objectContaining({
        issuerId: 'github_app_installation',
        adapterId: 'github_publish_pr',
        operation: 'publish_pr',
        executablePath: '/usr/bin/git',
        workingDirectory: root,
      }),
    });
    expect(runnerMocks.publishReviewedGitHubPr).toHaveBeenCalledWith(expect.objectContaining({
      adapterId: 'github_publish_pr',
      operation: 'publish_pr',
      executablePath: '/usr/bin/git',
      workingDirectory: root,
    }));
    expect(runnerMocks.buildLocalAdapterInvocation).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('SENTINEL_PUBLISH_TOKEN');
    expect(result).toEqual(expect.objectContaining({
      grantId: 'grant-1',
      pullRequestNumber: 42,
      action: 'created',
    }));
  });
});

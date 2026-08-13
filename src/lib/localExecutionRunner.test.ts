import {
  constants,
  createCipheriv,
  createHash,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  buildLocalAdapterInvocation,
  createExecutionCredentialBinding,
  createExecutionGrantHandleBinding,
  createGitHubPublishScope,
  createRunnerBinding,
  decryptExecutionGrantEnvelope,
  publishReviewedGitHubPr,
  type ExecutionGrantEnvelope,
} from './localExecutionRunner.js';

function envelopeFor(
  publicKeyPem: string,
  binding: string,
  payload: Record<string, unknown>,
): ExecutionGrantEnvelope {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(binding));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload)),
    cipher.final(),
  ]);
  return {
    algorithm: 'RSA-OAEP-256+A256GCM',
    wrappedKey: publicEncrypt({
      key: publicKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    }, key).toString('base64url'),
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
    aadDigest: createHash('sha256').update(binding).digest('hex'),
  };
}

describe('trusted local execution runner', () => {
  it('reconstructs runner and credential bindings from local request state', () => {
    expect(createExecutionGrantHandleBinding({
      grantId: 'grant-1',
      runnerFingerprint: 'b'.repeat(64),
      executableDigest: 'a'.repeat(64),
    })).toBe(`{"executableDigest":"${'a'.repeat(64)}","grantId":"grant-1","runnerFingerprint":"${'b'.repeat(64)}"}`);
    const binding = createExecutionCredentialBinding({
      grantId: 'grant-1',
      runnerFingerprint: 'b'.repeat(64),
      executableDigest: 'a'.repeat(64),
      adapterId: 'github_gh',
      operation: 'repo_view',
      issuerId: 'github_app_installation',
      provider: 'github',
      audience: 'api.github.com',
      requestedScope: {repository: 'owner/repo'},
      workingDirectory: null,
      purpose: 'Inspect repository metadata',
    });
    expect(binding).toContain('"adapterId":"github_gh"');
    expect(binding).toContain('"scopeDigest":');
    expect(binding).not.toContain('owner/repo');
  });

  it('decrypts only the matching runner-and-binding envelope in memory', () => {
    const runner = createRunnerBinding('/usr/local/bin/gh', 'a'.repeat(64));
    const binding = '{"grantId":"grant-1","executableDigest":"aaa"}';
    const payload = {
      kind: 'github_installation_token',
      fields: {token: 'SENTINEL_EPHEMERAL'},
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const encrypted = envelopeFor(runner.publicKeyPem, binding, payload);
    expect(JSON.stringify(encrypted)).not.toContain('SENTINEL_EPHEMERAL');
    expect(decryptExecutionGrantEnvelope(encrypted, runner.privateKey!, binding))
      .toEqual(payload);
    expect(() => decryptExecutionGrantEnvelope(encrypted, runner.privateKey!, `${binding}x`))
      .toThrow('binding is invalid');
  });

  it('constructs only allowlisted gh operations with no arbitrary flags or shell', () => {
    const invocation = buildLocalAdapterInvocation({
      adapterId: 'github_gh',
      operation: 'issue_list',
      executablePath: '/usr/local/bin/gh',
      executableDigest: 'a'.repeat(64),
      requestedScope: {repository: 'owner/repo'},
      credential: {
        kind: 'github_installation_token',
        fields: {token: 'SENTINEL_EPHEMERAL'},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(invocation.args).toEqual([
      'issue', 'list', '--repo', 'owner/repo', '--limit', '100',
      '--json', 'number,title,state,url',
    ]);
    expect(Object.keys(invocation.env)).toEqual(['GH_TOKEN']);
    expect(JSON.stringify(invocation.args)).not.toContain('SENTINEL_EPHEMERAL');
    expect(() => buildLocalAdapterInvocation({
      ...invocation,
      adapterId: 'github_gh',
      operation: 'api',
      executablePath: invocation.executable,
      executableDigest: invocation.executableDigest,
      requestedScope: {repository: 'owner/repo'},
      credential: {
        kind: 'github_installation_token',
        fields: {token: 'x'},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })).toThrow('Unsupported GitHub adapter operation');
    expect(() => buildLocalAdapterInvocation({
      adapterId: 'github_gh',
      operation: 'repo_view',
      executablePath: '/usr/local/bin/gh',
      executableDigest: 'a'.repeat(64),
      requestedScope: {repository: '-qprocess.env/target'},
      credential: {
        kind: 'github_installation_token',
        fields: {token: 'x'},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })).toThrow('GitHub execution grant is invalid');
  });

  it('pushes one exact SHA and creates one metadata-only pull request receipt', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sift-publisher-test-')));
    try {
      const gitPath = join(root, 'git');
      await writeFile(gitPath, '#!/bin/false\n', {mode: 0o700});
      const info = await stat(gitPath);
      const digest = createHash('sha256').update(await readFile(gitPath)).digest('hex');
      const verifiedSha = 'a'.repeat(40);
      let remotePublished = false;
      const executed: string[][] = [];
      const execFile = async (
        _executable: string,
        args: readonly string[],
        options: {env: NodeJS.ProcessEnv},
      ) => {
        executed.push([...args]);
        const operation = args[0]?.startsWith('--git-dir=') ? args[1] : args[0];
        if (['remote', 'rev-parse', 'status', 'init', 'fetch', 'cat-file'].includes(operation ?? '')) {
          expect(options.env.SIFT_GITHUB_TOKEN).toBeUndefined();
        }
        if (['ls-remote', 'push'].includes(operation ?? '')) {
          expect(options.env.SIFT_GITHUB_TOKEN).toBe('SENTINEL_PUBLISH_TOKEN');
        }
        if (args.join(' ') === 'remote get-url origin') {
          return {stdout: 'git@github.com:owner/repo.git\n', stderr: ''};
        }
        if (operation === 'rev-parse') return {stdout: `${verifiedSha}\n`, stderr: ''};
        if (['status', 'init', 'fetch', 'cat-file'].includes(operation ?? '')) {
          return {stdout: '', stderr: ''};
        }
        if (operation === 'ls-remote') {
          return {
            stdout: remotePublished ? `${verifiedSha}\trefs/heads/codex/work-123\n` : '',
            stderr: '',
          };
        }
        if (operation === 'push') {
          remotePublished = true;
          return {stdout: 'ok\n', stderr: ''};
        }
        throw new Error(`unexpected git operation: ${args.join(' ')}`);
      };
      const pullRequest = {
        number: 42,
        html_url: 'https://github.com/owner/repo/pull/42',
        title: 'Bounded publisher',
        body: 'Reviewed body',
        state: 'open',
        merged_at: null,
        base: {ref: 'main'},
        head: {ref: 'codex/work-123', sha: verifiedSha},
      };
      const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).not.toContain('SENTINEL_PUBLISH_TOKEN');
        expect(String(init?.body ?? '')).not.toContain('SENTINEL_PUBLISH_TOKEN');
        if (init?.method === 'DELETE') return new Response(null, {status: 204});
        if (String(url).includes('/pulls?')) return Response.json([]);
        return Response.json(pullRequest, {status: 201});
      };
      const body = 'Reviewed body';
      const scope = createGitHubPublishScope({
        repository: 'owner/repo',
        branch: 'codex/work-123',
        baseBranch: 'main',
        workItemId: '00000000-0000-4000-8000-000000000123',
        verifiedSha,
        title: 'Bounded publisher',
        body,
      });
      const receipt = await publishReviewedGitHubPr({
        adapterId: 'github_publish_pr',
        operation: 'publish_pr',
        executablePath: gitPath,
        executableDigest: digest,
        executableIdentity: {
          device: info.dev,
          inode: info.ino,
          size: info.size,
          modifiedMs: info.mtimeMs,
        },
        requestedScope: scope,
        workingDirectory: root,
        title: 'Bounded publisher',
        body,
        credential: {
          kind: 'github_installation_token',
          fields: {token: 'SENTINEL_PUBLISH_TOKEN'},
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }, {execFile, fetchImpl: fetchImpl as typeof fetch});
      expect(receipt).toEqual({
        repository: 'owner/repo',
        branch: 'codex/work-123',
        baseBranch: 'main',
        workItemId: '00000000-0000-4000-8000-000000000123',
        verifiedSha,
        pullRequestNumber: 42,
        pullRequestUrl: 'https://github.com/owner/repo/pull/42',
        action: 'created',
      });
      expect(JSON.stringify({receipt, executed})).not.toContain('SENTINEL_PUBLISH_TOKEN');
      expect(executed.some(args => args[1] === 'push'
        && args.slice(2).join(' ') === [
          '--porcelain',
          'https://github.com/owner/repo.git',
          `${verifiedSha}:refs/heads/codex/work-123`,
        ].join(' '))).toBe(true);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('fails closed before push when the remote branch has another SHA', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sift-publisher-mismatch-')));
    try {
      const gitPath = join(root, 'git');
      const executable = Buffer.from('#!/bin/false\n');
      await writeFile(gitPath, executable, {mode: 0o700});
      const verifiedSha = 'a'.repeat(40);
      const calls: string[][] = [];
      const execFile = async (_executable: string, args: readonly string[]) => {
        calls.push([...args]);
        const operation = args[0]?.startsWith('--git-dir=') ? args[1] : args[0];
        if (args.join(' ') === 'remote get-url origin') {
          return {stdout: 'https://github.com/owner/repo.git\n', stderr: ''};
        }
        if (operation === 'rev-parse') return {stdout: `${verifiedSha}\n`, stderr: ''};
        if (['status', 'init', 'fetch', 'cat-file'].includes(operation ?? '')) {
          return {stdout: '', stderr: ''};
        }
        if (operation === 'ls-remote') {
          return {stdout: `${'b'.repeat(40)}\trefs/heads/codex/work-123\n`, stderr: ''};
        }
        throw new Error('push must not run');
      };
      const body = 'Reviewed body';
      const credential = {
        kind: 'github_installation_token',
        fields: {token: 'SENTINEL_PUBLISH_TOKEN'},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      await expect(publishReviewedGitHubPr({
        adapterId: 'github_publish_pr',
        operation: 'publish_pr',
        executablePath: gitPath,
        executableDigest: createHash('sha256').update(executable).digest('hex'),
        requestedScope: createGitHubPublishScope({
          repository: 'owner/repo',
          branch: 'codex/work-123',
          baseBranch: 'main',
          workItemId: '00000000-0000-4000-8000-000000000123',
          verifiedSha,
          title: 'Bounded publisher',
          body,
        }),
        workingDirectory: root,
        title: 'Bounded publisher',
        body,
        credential,
      }, {
        execFile,
        fetchImpl: (async () => new Response(null, {status: 204})) as typeof fetch,
      })).rejects.toThrow('mismatched remote branch SHA');
      expect(calls.some(args => args[1] === 'push')).toBe(false);
      expect(credential.fields.token).toBe('');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('reuses the one existing pull request without pushing or creating a duplicate', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sift-publisher-idempotent-')));
    try {
      const gitPath = join(root, 'git');
      const executable = Buffer.from('#!/bin/false\n');
      await writeFile(gitPath, executable, {mode: 0o700});
      const verifiedSha = 'a'.repeat(40);
      const gitCalls: string[][] = [];
      const execFile = async (_executable: string, args: readonly string[]) => {
        gitCalls.push([...args]);
        const operation = args[0]?.startsWith('--git-dir=') ? args[1] : args[0];
        if (args.join(' ') === 'remote get-url origin') {
          return {stdout: 'https://github.com/owner/repo.git\n', stderr: ''};
        }
        if (operation === 'rev-parse') return {stdout: `${verifiedSha}\n`, stderr: ''};
        if (['status', 'init', 'fetch', 'cat-file'].includes(operation ?? '')) {
          return {stdout: '', stderr: ''};
        }
        if (operation === 'ls-remote') {
          return {stdout: `${verifiedSha}\trefs/heads/codex/work-123\n`, stderr: ''};
        }
        throw new Error(`unexpected git operation: ${args.join(' ')}`);
      };
      const apiMethods: string[] = [];
      const existing = {
        number: 42,
        html_url: 'https://github.com/owner/repo/pull/42',
        title: 'Bounded publisher',
        body: 'Reviewed body',
        state: 'open',
        merged_at: null,
        base: {ref: 'main'},
        head: {ref: 'codex/work-123', sha: verifiedSha},
      };
      const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
        apiMethods.push(`${init?.method ?? 'GET'} ${String(url)}`);
        if (init?.method === 'DELETE') return new Response(null, {status: 204});
        return Response.json([existing]);
      };
      const body = 'Reviewed body';
      const receipt = await publishReviewedGitHubPr({
        adapterId: 'github_publish_pr',
        operation: 'publish_pr',
        executablePath: gitPath,
        executableDigest: createHash('sha256').update(executable).digest('hex'),
        requestedScope: createGitHubPublishScope({
          repository: 'owner/repo',
          branch: 'codex/work-123',
          baseBranch: 'main',
          workItemId: '00000000-0000-4000-8000-000000000123',
          verifiedSha,
          title: 'Bounded publisher',
          body,
        }),
        workingDirectory: root,
        title: 'Bounded publisher',
        body,
        credential: {
          kind: 'github_installation_token',
          fields: {token: 'SENTINEL_PUBLISH_TOKEN'},
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }, {execFile, fetchImpl: fetchImpl as typeof fetch});
      expect(receipt.action).toBe('unchanged');
      expect(gitCalls.some(args => args[1] === 'push')).toBe(false);
      expect(apiMethods.filter(value => value.startsWith('POST '))).toEqual([]);
      expect(apiMethods.filter(value => value.startsWith('PATCH '))).toEqual([]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('rejects executable substitution and clears the redeemed credential', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sift-publisher-executable-')));
    try {
      const gitPath = join(root, 'git');
      const reviewed = Buffer.from('#!/bin/false\n');
      await writeFile(gitPath, reviewed, {mode: 0o700});
      const reviewedInfo = await stat(gitPath);
      await writeFile(gitPath, '#!/bin/true\n', {mode: 0o700});
      const body = 'Reviewed body';
      const credential = {
        kind: 'github_installation_token',
        fields: {token: 'SENTINEL_PUBLISH_TOKEN'},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      let executableRan = false;
      const execFile = async () => {
        executableRan = true;
        throw new Error('substituted executable must not run');
      };
      await expect(publishReviewedGitHubPr({
        adapterId: 'github_publish_pr',
        operation: 'publish_pr',
        executablePath: gitPath,
        executableDigest: createHash('sha256').update(reviewed).digest('hex'),
        executableIdentity: {
          device: reviewedInfo.dev,
          inode: reviewedInfo.ino,
          size: reviewedInfo.size,
          modifiedMs: reviewedInfo.mtimeMs,
        },
        requestedScope: createGitHubPublishScope({
          repository: 'owner/repo',
          branch: 'codex/work-123',
          baseBranch: 'main',
          workItemId: '00000000-0000-4000-8000-000000000123',
          verifiedSha: 'a'.repeat(40),
          title: 'Bounded publisher',
          body,
        }),
        workingDirectory: root,
        title: 'Bounded publisher',
        body,
        credential,
      }, {
        execFile,
        fetchImpl: (async () => new Response(null, {status: 204})) as typeof fetch,
      })).rejects.toThrow('Reviewed executable changed after grant approval');
      expect(executableRan).toBe(false);
      expect(credential.fields.token).toBe('');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});

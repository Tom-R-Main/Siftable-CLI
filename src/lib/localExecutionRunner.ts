import {
  constants,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  type KeyObject,
} from 'node:crypto';
import {execFile} from 'node:child_process';
import {access, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, delimiter, join} from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_CAPTURE_BYTES = 1024 * 1024;
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_PUBLISH_ADAPTER_ID = 'github_publish_pr';
const GITHUB_PUBLISH_OPERATION = 'publish_pr';
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const WORK_ITEM_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ExecutionGrantEnvelope {
  algorithm: 'RSA-OAEP-256+A256GCM';
  wrappedKey: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
  aadDigest: string;
}

export interface DecryptedGrantCredential {
  kind: string;
  fields: Record<string, string>;
  expiresAt: string;
}

export interface RunnerBinding {
  publicKeyPem: string;
  privateKey: KeyObject | null;
  publicKeyFingerprint: string;
  executablePath: string;
  executableDigest: string;
  executableIdentity: ExecutableIdentity;
}

export interface ExecutableIdentity {
  device: number;
  inode: number;
  size: number;
  modifiedMs: number;
}

export interface LocalAdapterInvocation {
  executable: string;
  executableDigest: string;
  executableIdentity?: ExecutableIdentity;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  tier: 'contained' | 'bounded_only';
  threatDisclosure: string;
}

export interface GitHubPublishScope extends Record<string, string> {
  repository: string;
  branch: string;
  baseBranch: string;
  workItemId: string;
  verifiedSha: string;
  title: string;
  bodyDigest: string;
}

export interface GitHubPublishReceipt {
  repository: string;
  branch: string;
  baseBranch: string;
  workItemId: string;
  verifiedSha: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  action: 'created' | 'updated' | 'unchanged';
}

type ReviewedExecFile = (
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    encoding: 'utf8';
    maxBuffer: number;
    timeout: number;
    windowsHide: true;
  },
) => Promise<{stdout: string; stderr: string}>;

interface GitHubPublishDependencies {
  execFile?: ReviewedExecFile;
  fetchImpl?: typeof fetch;
}

function canonicalJson(value: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function isSafeBranch(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value)
    && !value.includes('..')
    && !value.includes('//')
    && !value.includes('@{')
    && !value.endsWith('/')
    && !value.endsWith('.')
    && !value.endsWith('.lock');
}

function assertGitHubPublishScope(scope: Record<string, string>): GitHubPublishScope {
  const expectedKeys = [
    'baseBranch',
    'bodyDigest',
    'branch',
    'repository',
    'title',
    'verifiedSha',
    'workItemId',
  ];
  if (Object.keys(scope).sort().join(',') !== expectedKeys.join(',')
    || !GITHUB_REPOSITORY_PATTERN.test(scope.repository ?? '')
    || !isSafeBranch(scope.branch ?? '')
    || !isSafeBranch(scope.baseBranch ?? '')
    || !WORK_ITEM_PATTERN.test(scope.workItemId ?? '')
    || !GIT_SHA_PATTERN.test(scope.verifiedSha ?? '')
    || !(scope.title ?? '').trim()
    || scope.title.length > 256
    || !/^[0-9a-f]{64}$/.test(scope.bodyDigest ?? '')) {
    throw new Error('GitHub PR publication scope is invalid');
  }
  return scope as unknown as GitHubPublishScope;
}

export function createGitHubPublishScope(input: {
  repository: string;
  branch: string;
  baseBranch: string;
  workItemId: string;
  verifiedSha: string;
  title: string;
  body: string;
}): Record<string, string> {
  return assertGitHubPublishScope({
    repository: input.repository,
    branch: input.branch,
    baseBranch: input.baseBranch,
    workItemId: input.workItemId,
    verifiedSha: input.verifiedSha,
    title: input.title.trim(),
    bodyDigest: createHash('sha256').update(input.body).digest('hex'),
  });
}

export function createExecutionGrantHandleBinding(input: {
  grantId: string;
  runnerFingerprint: string;
  executableDigest: string;
}): string {
  return canonicalJson(input);
}

export function createExecutionCredentialBinding(input: {
  grantId: string;
  runnerFingerprint: string;
  executableDigest: string;
  adapterId: string;
  operation: string;
  issuerId: string;
  provider: string;
  audience: string;
  requestedScope: Record<string, string>;
  workingDirectory: string | null;
  purpose: string;
}): string {
  return canonicalJson({
    grantId: input.grantId,
    runnerFingerprint: input.runnerFingerprint,
    executableDigest: input.executableDigest,
    adapterId: input.adapterId,
    operation: input.operation,
    issuerId: input.issuerId,
    provider: input.provider,
    audience: input.audience,
    scopeDigest: createHash('sha256').update(canonicalJson(input.requestedScope)).digest('hex'),
    workingDirectoryDigest: input.workingDirectory
      ? createHash('sha256').update(input.workingDirectory).digest('hex')
      : 'none',
    purposeDigest: createHash('sha256').update(input.purpose).digest('hex'),
  });
}

function base64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function redact(value: string, credential: DecryptedGrantCredential): string {
  let safe = value;
  for (const secret of Object.values(credential.fields)) {
    if (secret) safe = safe.split(secret).join('[REDACTED]');
  }
  return safe
    .replace(/(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED]')
    .replace(/AKIA[A-Z0-9]{16}/g, '[REDACTED]');
}

export async function resolveReviewedExecutable(name: 'gh' | 'git' | 'terraform'): Promise<{
  path: string;
  digest: string;
  identity: ExecutableIdentity;
}> {
  const directories = name === 'git'
    ? ['/usr/bin']
    : (process.env.PATH ?? '').split(delimiter);
  for (const directory of directories) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      const path = await realpath(candidate);
      const inspected = await inspectExecutable(path);
      return {path, digest: inspected.digest, identity: inspected.identity};
    } catch {
      // Continue through PATH; no shell or user-provided executable is involved.
    }
  }
  throw new Error(`Reviewed executable not found on PATH: ${name}`);
}

export function createRunnerBinding(
  executablePath: string,
  executableDigest: string,
  executableIdentity: ExecutableIdentity = {
    device: 0,
    inode: 0,
    size: 0,
    modifiedMs: 0,
  },
): RunnerBinding {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 3072,
  });
  const publicKeyPem = pair.publicKey.export({type: 'spki', format: 'pem'}).toString();
  return {
    publicKeyPem,
    privateKey: pair.privateKey,
    publicKeyFingerprint: createHash('sha256').update(publicKeyPem.trim()).digest('hex'),
    executablePath,
    executableDigest,
    executableIdentity,
  };
}

export function decryptExecutionGrantEnvelope(
  envelope: ExecutionGrantEnvelope,
  privateKey: KeyObject,
  binding: string,
): DecryptedGrantCredential {
  if (envelope.algorithm !== 'RSA-OAEP-256+A256GCM'
    || createHash('sha256').update(binding).digest('hex') !== envelope.aadDigest) {
    throw new Error('Execution grant envelope binding is invalid');
  }
  const key = privateDecrypt({
    key: privateKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, base64url(envelope.wrappedKey));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, base64url(envelope.nonce));
    decipher.setAAD(Buffer.from(binding, 'utf8'));
    decipher.setAuthTag(base64url(envelope.authTag));
    const plaintext = Buffer.concat([
      decipher.update(base64url(envelope.ciphertext)),
      decipher.final(),
    ]);
    try {
      const credential = JSON.parse(plaintext.toString('utf8')) as DecryptedGrantCredential;
      if (!credential.fields || new Date(credential.expiresAt).getTime() <= Date.now()) {
        throw new Error('Execution grant credential is expired or invalid');
      }
      return credential;
    } finally {
      plaintext.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

export function buildLocalAdapterInvocation(input: {
  adapterId: string;
  operation: string;
  executablePath: string;
  executableDigest: string;
  executableIdentity?: ExecutableIdentity;
  requestedScope: Record<string, string>;
  workingDirectory?: string;
  credential: DecryptedGrantCredential;
}): LocalAdapterInvocation {
  if (input.adapterId === 'github_gh') {
    if (input.credential.kind !== 'github_installation_token'
      || !input.credential.fields.token
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/
        .test(input.requestedScope.repository ?? '')) {
      throw new Error('GitHub execution grant is invalid');
    }
    const args = input.operation === 'repo_view'
      ? ['repo', 'view', input.requestedScope.repository, '--json', 'nameWithOwner,url,visibility']
      : input.operation === 'issue_list'
        ? ['issue', 'list', '--repo', input.requestedScope.repository, '--limit', '100', '--json', 'number,title,state,url']
        : null;
    if (!args) throw new Error('Unsupported GitHub adapter operation');
    return {
      executable: input.executablePath,
      executableDigest: input.executableDigest,
      executableIdentity: input.executableIdentity,
      args,
      env: {GH_TOKEN: input.credential.fields.token},
      tier: 'contained',
      threatDisclosure: 'Only allowlisted gh subcommands run; gh api, aliases, extensions, and arbitrary flags are unavailable.',
    };
  }
  if (input.adapterId === 'terraform_apply') {
    const fields = input.credential.fields;
    if (input.operation !== 'apply' || input.credential.kind !== 'aws_sts'
      || !fields.accessKeyId || !fields.secretAccessKey || !fields.sessionToken
      || !input.workingDirectory) {
      throw new Error('Terraform execution grant is invalid');
    }
    return {
      executable: input.executablePath,
      executableDigest: input.executableDigest,
      executableIdentity: input.executableIdentity,
      args: ['apply', '-input=false', '-auto-approve'],
      env: {
        AWS_ACCESS_KEY_ID: fields.accessKeyId,
        AWS_SECRET_ACCESS_KEY: fields.secretAccessKey,
        AWS_SESSION_TOKEN: fields.sessionToken,
      },
      cwd: input.workingDirectory,
      tier: 'bounded_only',
      threatDisclosure: 'Terraform providers, plugins, local-exec, and external data sources can observe the short-lived credential; TTL and provider scope are the security boundary.',
    };
  }
  throw new Error('No reviewed local adapter is available');
}

export async function runOneReviewedChild(
  invocation: LocalAdapterInvocation,
  credential: DecryptedGrantCredential,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  tier: LocalAdapterInvocation['tier'];
  threatDisclosure: string;
}> {
  try {
    const envKeys = Object.keys(invocation.env).sort();
    const githubAllowed = invocation.tier === 'contained'
      && basename(invocation.executable) === 'gh'
      && envKeys.join(',') === 'GH_TOKEN'
      && (
        (invocation.args[0] === 'repo' && invocation.args[1] === 'view'
          && !invocation.args[2].startsWith('-')
          && invocation.args[3] === '--json' && invocation.args.length === 5)
        || (invocation.args[0] === 'issue' && invocation.args[1] === 'list'
          && invocation.args[2] === '--repo' && !invocation.args[3].startsWith('-')
          && invocation.args[4] === '--limit'
          && invocation.args[5] === '100' && invocation.args[6] === '--json'
          && invocation.args.length === 8)
      );
    const terraformAllowed = invocation.tier === 'bounded_only'
      && basename(invocation.executable) === 'terraform'
      && invocation.args.join('\0') === ['apply', '-input=false', '-auto-approve'].join('\0')
      && envKeys.join(',') === 'AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY,AWS_SESSION_TOKEN'
      && Boolean(invocation.cwd);
    if (!githubAllowed && !terraformAllowed) {
      throw new Error('Local execution invocation escaped its reviewed adapter contract');
    }
    await assertReviewedExecutableDigest(
      invocation.executable,
      invocation.executableDigest,
      invocation.executableIdentity,
    );
    const isolatedConfig = await mkdtemp(join(tmpdir(), 'sift-grant-'));
    const childEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: isolatedConfig,
      GH_CONFIG_DIR: isolatedConfig,
      GH_PAGER: 'cat',
      GH_PROMPT_DISABLED: '1',
      PAGER: 'cat',
      NO_COLOR: '1',
      ...invocation.env,
    };
    try {
      const result = await execFileAsync(invocation.executable, invocation.args, {
        cwd: invocation.cwd,
        env: childEnv,
        encoding: 'utf8',
        maxBuffer: MAX_CAPTURE_BYTES,
        timeout: 15 * 60 * 1000,
        windowsHide: true,
      });
      return {
        exitCode: 0,
        stdout: redact(result.stdout, credential),
        stderr: redact(result.stderr, credential),
        tier: invocation.tier,
        threatDisclosure: invocation.threatDisclosure,
      };
    } catch (error) {
      const failure = error as Error & {code?: number; stdout?: string; stderr?: string};
      return {
        exitCode: typeof failure.code === 'number' ? failure.code : 1,
        stdout: redact(failure.stdout ?? '', credential),
        stderr: redact(failure.stderr ?? 'Reviewed child process failed', credential),
        tier: invocation.tier,
        threatDisclosure: invocation.threatDisclosure,
      };
    } finally {
      await rm(isolatedConfig, {recursive: true, force: true});
    }
  } finally {
    if (credential.kind === 'github_installation_token' && credential.fields.token) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        await fetch('https://api.github.com/installation/token', {
          method: 'DELETE',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${credential.fields.token}`,
            'User-Agent': 'Siftable-local-execution-runner',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: controller.signal,
        });
      } catch {
        // The token remains provider-bounded to one hour if best-effort revocation fails.
      } finally {
        clearTimeout(timeout);
      }
    }
    for (const key of Object.keys(credential.fields)) credential.fields[key] = '';
  }
}

function repositoryFromRemote(remote: string): string | null {
  const trimmed = remote.trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(trimmed);
  return match?.[1] ?? null;
}

async function boundedGitHubJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CAPTURE_BYTES) {
    throw new Error('GitHub PR publisher response exceeded its safety limit');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_CAPTURE_BYTES) {
    throw new Error('GitHub PR publisher response exceeded its safety limit');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('GitHub PR publisher returned invalid JSON');
  }
}

interface GitHubPullRequest {
  number: number;
  htmlUrl: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  baseBranch: string;
  headBranch: string;
  headSha: string;
}

function parseGitHubPullRequest(value: unknown): GitHubPullRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GitHub PR publisher returned an invalid pull request');
  }
  const item = value as Record<string, unknown>;
  const base = item.base as Record<string, unknown> | undefined;
  const head = item.head as Record<string, unknown> | undefined;
  if (!Number.isSafeInteger(item.number)
    || typeof item.html_url !== 'string'
    || !/^https:\/\/github\.com\//.test(item.html_url)
    || typeof item.title !== 'string'
    || !(typeof item.body === 'string' || item.body === null)
    || (item.state !== 'open' && item.state !== 'closed')
    || !(typeof item.merged_at === 'string' || item.merged_at === null)
    || typeof base?.ref !== 'string'
    || typeof head?.ref !== 'string'
    || typeof head?.sha !== 'string'
    || !GIT_SHA_PATTERN.test(head.sha)) {
    throw new Error('GitHub PR publisher returned an invalid pull request');
  }
  return {
    number: item.number as number,
    htmlUrl: item.html_url,
    title: item.title,
    body: typeof item.body === 'string' ? item.body : '',
    state: item.state,
    merged: item.merged_at !== null,
    baseBranch: base.ref,
    headBranch: head.ref,
    headSha: head.sha,
  };
}

function parseRemoteSha(output: string, expectedRef: string): string | null {
  const lines = output.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  if (lines.length !== 1) throw new Error('GitHub branch lookup returned multiple refs');
  const [sha, ref, extra] = lines[0].split(/\s+/);
  if (extra || ref !== expectedRef || !GIT_SHA_PATTERN.test(sha ?? '')) {
    throw new Error('GitHub branch lookup returned an invalid ref');
  }
  return sha;
}

export async function publishReviewedGitHubPr(input: {
  adapterId: string;
  operation: string;
  executablePath: string;
  executableDigest: string;
  executableIdentity?: ExecutableIdentity;
  requestedScope: Record<string, string>;
  workingDirectory: string;
  title: string;
  body: string;
  credential: DecryptedGrantCredential;
}, dependencies: GitHubPublishDependencies = {}): Promise<GitHubPublishReceipt> {
  const credential = input.credential;
  const token = credential.fields.token ?? '';
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  let isolatedConfig: string | undefined;
  try {
    const scope = assertGitHubPublishScope(input.requestedScope);
    if (input.adapterId !== GITHUB_PUBLISH_ADAPTER_ID
      || input.operation !== GITHUB_PUBLISH_OPERATION
      || credential.kind !== 'github_installation_token'
      || !token
      || new Date(credential.expiresAt).getTime() <= Date.now()
      || scope.title !== input.title.trim()
      || scope.bodyDigest !== createHash('sha256').update(input.body).digest('hex')) {
      throw new Error('GitHub PR publication grant is invalid');
    }
    const workingDirectory = await realpath(input.workingDirectory);
    if (workingDirectory !== input.workingDirectory) {
      throw new Error('GitHub PR publication working directory is not canonical');
    }
    await assertReviewedExecutableDigest(
      input.executablePath,
      input.executableDigest,
      input.executableIdentity,
    );

    isolatedConfig = await mkdtemp(join(tmpdir(), 'sift-github-publish-'));
    const askpassPath = join(isolatedConfig, 'askpass.cjs');
    const publishGitDirectory = join(isolatedConfig, 'repository.git');
    const emptyTemplateDirectory = join(isolatedConfig, 'templates');
    const execute = dependencies.execFile ?? execFileAsync as ReviewedExecFile;
    const baseGitEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: isolatedConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    };
    const runGit = async (
      args: readonly string[],
      options: {cwd?: string; authenticated?: boolean} = {},
    ): Promise<string> => {
      try {
        const result = await execute(input.executablePath, args, {
          cwd: options.cwd ?? workingDirectory,
          env: options.authenticated
            ? {
              ...baseGitEnv,
              GIT_ASKPASS: askpassPath,
              SIFT_GITHUB_TOKEN: token,
            }
            : baseGitEnv,
          encoding: 'utf8',
          maxBuffer: MAX_CAPTURE_BYTES,
          timeout: 5 * 60 * 1000,
          windowsHide: true,
        });
        return redact(result.stdout, credential);
      } catch (error) {
        const failure = error as Error & {stdout?: string; stderr?: string};
        const detail = redact(failure.stderr ?? failure.stdout ?? '', credential).trim();
        throw new Error(detail
          ? `GitHub PR publisher git operation failed: ${detail}`
          : 'GitHub PR publisher git operation failed');
      }
    };
    const githubRequest = async (
      path: string,
      init: {method?: 'GET' | 'POST' | 'PATCH'; body?: Record<string, unknown>} = {},
    ): Promise<unknown> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetchImpl(`https://api.github.com${path}`, {
          method: init.method ?? 'GET',
          redirect: 'error',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Siftable-github-pr-publisher',
            'X-GitHub-Api-Version': GITHUB_API_VERSION,
          },
          body: init.body ? JSON.stringify(init.body) : undefined,
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`GitHub PR publisher request failed with status ${response.status}`);
        }
        return boundedGitHubJson(response);
      } finally {
        clearTimeout(timeout);
      }
    };

    await writeFile(
      askpassPath,
      `#!${process.execPath}\nconst prompt = process.argv[2] ?? '';\nprocess.stdout.write(prompt.includes('Username') ? 'x-access-token' : (process.env.SIFT_GITHUB_TOKEN ?? ''));\n`,
      {mode: 0o700},
    );
    await mkdir(emptyTemplateDirectory, {mode: 0o700});
    const remote = (await runGit(['remote', 'get-url', 'origin'])).trim();
    const remoteRepository = repositoryFromRemote(remote);
    if (!remoteRepository
      || remoteRepository.toLowerCase() !== scope.repository.toLowerCase()) {
      throw new Error('GitHub PR publisher repository does not match origin');
    }
    const localSha = (await runGit([
      'rev-parse',
      '--verify',
      `refs/heads/${scope.branch}^{commit}`,
    ])).trim();
    if (localSha !== scope.verifiedSha) {
      throw new Error('GitHub PR publisher branch does not match the verified SHA');
    }
    if ((await runGit(['status', '--porcelain=v1'])).trim()) {
      throw new Error('GitHub PR publisher requires a clean checkout');
    }

    await runGit([
      'init',
      '--bare',
      `--template=${emptyTemplateDirectory}`,
      publishGitDirectory,
    ], {cwd: isolatedConfig});
    await runGit([
      `--git-dir=${publishGitDirectory}`,
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      workingDirectory,
      scope.verifiedSha,
    ], {cwd: isolatedConfig});
    await runGit([
      `--git-dir=${publishGitDirectory}`,
      'cat-file',
      '-e',
      `${scope.verifiedSha}^{commit}`,
    ], {cwd: isolatedConfig});

    const remoteUrl = `https://github.com/${scope.repository}.git`;
    const branchRef = `refs/heads/${scope.branch}`;
    const beforePush = parseRemoteSha(
      await runGit([
        `--git-dir=${publishGitDirectory}`,
        'ls-remote',
        remoteUrl,
        branchRef,
      ], {cwd: isolatedConfig, authenticated: true}),
      branchRef,
    );
    if (beforePush && beforePush !== scope.verifiedSha) {
      throw new Error('GitHub PR publisher found a mismatched remote branch SHA');
    }
    if (!beforePush) {
      await runGit([
        `--git-dir=${publishGitDirectory}`,
        'push',
        '--porcelain',
        remoteUrl,
        `${scope.verifiedSha}:${branchRef}`,
      ], {cwd: isolatedConfig, authenticated: true});
    }
    const publishedSha = parseRemoteSha(
      await runGit([
        `--git-dir=${publishGitDirectory}`,
        'ls-remote',
        remoteUrl,
        branchRef,
      ], {cwd: isolatedConfig, authenticated: true}),
      branchRef,
    );
    if (publishedSha !== scope.verifiedSha) {
      throw new Error('GitHub PR publisher could not verify the exact remote SHA');
    }

    const [owner] = scope.repository.split('/');
    const query = new URLSearchParams({
      state: 'all',
      head: `${owner}:${scope.branch}`,
      per_page: '100',
    });
    const existingJson = await githubRequest(
      `/repos/${scope.repository}/pulls?${query.toString()}`,
    );
    if (!Array.isArray(existingJson) || existingJson.length > 1) {
      throw new Error('GitHub PR publisher found an ambiguous pull request state');
    }
    let action: GitHubPublishReceipt['action'];
    let pullRequest: GitHubPullRequest;
    if (existingJson.length === 0) {
      pullRequest = parseGitHubPullRequest(await githubRequest(
        `/repos/${scope.repository}/pulls`,
        {
          method: 'POST',
          body: {
            title: scope.title,
            body: input.body,
            head: scope.branch,
            base: scope.baseBranch,
          },
        },
      ));
      action = 'created';
    } else {
      pullRequest = parseGitHubPullRequest(existingJson[0]);
      if (pullRequest.headSha !== scope.verifiedSha
        || pullRequest.headBranch !== scope.branch) {
        throw new Error('GitHub PR publisher found a mismatched existing pull request');
      }
      if (pullRequest.merged) {
        action = 'unchanged';
      } else if (pullRequest.title !== scope.title
        || pullRequest.body !== input.body
        || pullRequest.baseBranch !== scope.baseBranch
        || pullRequest.state !== 'open') {
        pullRequest = parseGitHubPullRequest(await githubRequest(
          `/repos/${scope.repository}/pulls/${pullRequest.number}`,
          {
            method: 'PATCH',
            body: {
              title: scope.title,
              body: input.body,
              base: scope.baseBranch,
              state: 'open',
            },
          },
        ));
        action = 'updated';
      } else {
        action = 'unchanged';
      }
    }
    if (pullRequest.headSha !== scope.verifiedSha
      || pullRequest.headBranch !== scope.branch
      || pullRequest.baseBranch !== scope.baseBranch) {
      throw new Error('GitHub PR publisher receipt does not match the approved scope');
    }
    return {
      repository: scope.repository,
      branch: scope.branch,
      baseBranch: scope.baseBranch,
      workItemId: scope.workItemId,
      verifiedSha: scope.verifiedSha,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.htmlUrl,
      action,
    };
  } finally {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      if (token) {
        await fetchImpl('https://api.github.com/installation/token', {
          method: 'DELETE',
          redirect: 'error',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'Siftable-github-pr-publisher',
            'X-GitHub-Api-Version': GITHUB_API_VERSION,
          },
          signal: controller.signal,
        });
      }
    } catch {
      // Provider TTL remains the fallback when best-effort revocation fails.
    } finally {
      clearTimeout(timeout);
      for (const key of Object.keys(credential.fields)) credential.fields[key] = '';
      if (isolatedConfig) {
        await rm(isolatedConfig, {recursive: true, force: true});
      }
    }
  }
}

export async function assertReviewedExecutableDigest(
  executablePath: string,
  expectedDigest: string,
  expectedIdentity?: ExecutableIdentity,
): Promise<ExecutableIdentity> {
  if (!/^[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new Error('Reviewed executable digest is missing');
  }
  const inspected = await inspectExecutable(executablePath);
  if (inspected.digest !== expectedDigest) {
    throw new Error('Reviewed executable changed after grant approval');
  }
  if (expectedIdentity && (
    inspected.identity.device !== expectedIdentity.device
    || inspected.identity.inode !== expectedIdentity.inode
    || inspected.identity.size !== expectedIdentity.size
    || inspected.identity.modifiedMs !== expectedIdentity.modifiedMs
  )) {
    throw new Error('Reviewed executable identity changed after grant approval');
  }
  return inspected.identity;
}

async function inspectExecutable(executablePath: string): Promise<{
  digest: string;
  identity: ExecutableIdentity;
}> {
  const file = await open(executablePath, fsConstants.O_RDONLY);
  try {
    const before = await file.stat();
    const digest = createHash('sha256').update(await file.readFile()).digest('hex');
    const afterPath = await stat(executablePath);
    if (before.dev !== afterPath.dev || before.ino !== afterPath.ino) {
      throw new Error('Reviewed executable path changed during verification');
    }
    return {
      digest,
      identity: {
        device: before.dev,
        inode: before.ino,
        size: before.size,
        modifiedMs: before.mtimeMs,
      },
    };
  } finally {
    await file.close();
  }
}

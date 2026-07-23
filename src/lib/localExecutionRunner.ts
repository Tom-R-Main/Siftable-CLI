import {
  constants,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  type KeyObject,
} from 'node:crypto';
import {execFile} from 'node:child_process';
import {access, mkdtemp, open, readFile, realpath, rm, stat} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, delimiter, join} from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_CAPTURE_BYTES = 1024 * 1024;

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

function canonicalJson(value: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ));
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

export async function resolveReviewedExecutable(name: 'gh' | 'terraform'): Promise<{
  path: string;
  digest: string;
  identity: ExecutableIdentity;
}> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
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

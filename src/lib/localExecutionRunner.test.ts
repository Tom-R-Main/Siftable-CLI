import {
  constants,
  createCipheriv,
  createHash,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {
  buildLocalAdapterInvocation,
  createExecutionCredentialBinding,
  createExecutionGrantHandleBinding,
  createRunnerBinding,
  decryptExecutionGrantEnvelope,
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
});

import {Flags} from '@oclif/core';
import {readFile, realpath} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {BaseCommand} from '../../lib/base-command.js';
import {parseStringMap} from '../../lib/execution-grant-input.js';
import {
  buildLocalAdapterInvocation,
  assertReviewedExecutableDigest,
  createExecutionCredentialBinding,
  createExecutionGrantHandleBinding,
  createGitHubPublishScope,
  createRunnerBinding,
  decryptExecutionGrantEnvelope,
  publishReviewedGitHubPr,
  resolveReviewedExecutable,
  runOneReviewedChild,
  type ExecutionGrantEnvelope,
} from '../../lib/localExecutionRunner.js';

interface GrantRecord {
  id: string;
  approvalId: string;
  status: string;
  adapterId: string;
  operation: string;
  requestedScope: Record<string, string>;
  executableDigest: string;
  workingDirectory: string | null;
  containmentTier: string;
  threatDisclosure: string;
  audience: string;
  issuerId: string;
  provider: string;
  purpose: string;
}

const MAX_PR_BODY_BYTES = 64 * 1024;

function sameStringMap(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const sort = (value: Record<string, string>) => JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
  ));
  return sort(left) === sort(right);
}

export default class GrantsRun extends BaseCommand {
  static description = 'Request approval, redeem in memory, and run exactly one reviewed child process';
  static flags = {
    ...BaseCommand.baseFlags,
    'vault-entry': Flags.string({required: true}),
    'credential-field': Flags.string({required: true}),
    issuer: Flags.string({required: true}),
    adapter: Flags.string({
      required: true,
      options: ['github_gh', 'github_publish_pr', 'terraform_apply'],
    }),
    operation: Flags.string({required: true}),
    audience: Flags.string({required: true}),
    scope: Flags.string({required: true}),
    purpose: Flags.string({required: true}),
    cwd: Flags.string(),
    'body-file': Flags.string({description: 'PR body file for github_publish_pr'}),
    'approval-timeout': Flags.integer({default: 600, min: 30, max: 600}),
  };

  async run(): Promise<unknown> {
    const {flags} = await this.parse(GrantsRun);
    const publishing = flags.adapter === 'github_publish_pr';
    if (publishing && (flags.operation !== 'publish_pr' || !flags.cwd || !flags['body-file'])) {
      throw new Error('github_publish_pr requires --operation publish_pr, --cwd, and --body-file');
    }
    if (publishing
      && (flags.issuer !== 'github_app_installation' || flags.audience !== 'api.github.com')) {
      throw new Error('github_publish_pr requires the GitHub App installation issuer and api.github.com audience');
    }
    if (!publishing && flags['body-file']) {
      throw new Error('--body-file is available only for github_publish_pr');
    }
    const executableName = flags.adapter === 'terraform_apply'
      ? 'terraform'
      : publishing ? 'git' : 'gh';
    const executable = await resolveReviewedExecutable(executableName);
    const runner = createRunnerBinding(
      executable.path,
      executable.digest,
      executable.identity,
    );
    const requestedScope = parseStringMap(flags.scope, '--scope');
    const workingDirectory = publishing ? await realpath(flags.cwd!) : flags.cwd;
    let publicationBody: string | undefined;
    if (publishing) {
      const bodyBytes = await readFile(flags['body-file']!);
      if (bodyBytes.byteLength > MAX_PR_BODY_BYTES) {
        throw new Error('Pull request body exceeds the 64 KiB publication limit');
      }
      publicationBody = bodyBytes.toString('utf8');
      const boundScope = createGitHubPublishScope({
        repository: requestedScope.repository ?? '',
        branch: requestedScope.branch ?? '',
        baseBranch: requestedScope.baseBranch ?? '',
        workItemId: requestedScope.workItemId ?? '',
        verifiedSha: requestedScope.verifiedSha ?? '',
        title: requestedScope.title ?? '',
        body: publicationBody,
      });
      if (!sameStringMap(boundScope, requestedScope)) {
        throw new Error('github_publish_pr scope does not match the exact PR body binding');
      }
    }
    const request = await this.apiRequest<{
      grant: GrantRecord;
      handleEnvelope: ExecutionGrantEnvelope;
      handleBinding: string;
    }>(
      flags,
      '/api/v1/vault/execution-grants',
      {
        method: 'POST',
        body: {
          surface: 'cli',
          vaultEntryId: flags['vault-entry'],
          credentialField: flags['credential-field'],
          issuerId: flags.issuer,
          adapterId: flags.adapter,
          operation: flags.operation,
          audience: flags.audience,
          requestedScope,
          purpose: flags.purpose,
          runnerPublicKeyPem: runner.publicKeyPem,
          runnerPublicKeyFingerprint: runner.publicKeyFingerprint,
          executablePath: runner.executablePath,
          executableDigest: runner.executableDigest,
          workingDirectory,
        },
      },
    );
    const privateKey = runner.privateKey;
    if (!privateKey) throw new Error('Runner private key is unavailable');
    const expectedHandleBinding = createExecutionGrantHandleBinding({
      grantId: request.grant.id,
      runnerFingerprint: runner.publicKeyFingerprint,
      executableDigest: runner.executableDigest,
    });
    if (
      request.handleBinding !== expectedHandleBinding
      || request.grant.adapterId !== flags.adapter
      || request.grant.operation !== flags.operation
      || request.grant.issuerId !== flags.issuer
      || request.grant.provider !== (flags.adapter === 'terraform_apply' ? 'aws' : 'github')
      || request.grant.audience !== flags.audience
      || request.grant.purpose !== flags.purpose
      || request.grant.executableDigest !== runner.executableDigest
      || request.grant.workingDirectory !== (workingDirectory ?? null)
      || !sameStringMap(request.grant.requestedScope, requestedScope)
    ) {
      throw new Error('Execution grant response does not match the locally requested binding');
    }
    const handleCredential = decryptExecutionGrantEnvelope(
      request.handleEnvelope,
      privateKey,
      expectedHandleBinding,
    );
    if (handleCredential.kind !== 'execution_grant_handle'
      || !handleCredential.fields.handle?.startsWith('vgrant_')) {
      throw new Error('Runner-bound execution grant handle is invalid');
    }
    let handle = handleCredential.fields.handle;
    handleCredential.fields.handle = '';
    this.log(`Approval required: ${request.grant.approvalId}`);
    this.log('Approve the exact request in the first-party Siftable browser. The runner is waiting with its private key only in memory.');
    const deadline = Date.now() + flags['approval-timeout'] * 1000;
    let approvalStatus = 'pending';
    while (Date.now() < deadline) {
      const approval = await this.apiRequest<{approval: {status: string}}>(
        flags,
        `/api/v1/governed-approvals/${encodeURIComponent(request.grant.approvalId)}?surface=cli`,
      );
      approvalStatus = approval.approval.status;
      if (approvalStatus === 'approved') break;
      if (approvalStatus !== 'pending') throw new Error(`Grant approval is ${approvalStatus}`);
      await delay(2000);
    }
    if (approvalStatus !== 'approved') throw new Error('Grant approval timed out');
    await assertReviewedExecutableDigest(
      runner.executablePath,
      runner.executableDigest,
      runner.executableIdentity,
    );
    const redeemed = await this.apiRequest<{
      grant: GrantRecord;
      envelope: ExecutionGrantEnvelope;
      binding: string;
      credentialExpiresAt: string;
    }>(
      flags,
      '/api/v1/vault/execution-grants/redeem',
      {
        method: 'POST',
        body: {
          surface: 'cli',
          handle,
          approvalId: request.grant.approvalId,
          runnerPublicKeyFingerprint: runner.publicKeyFingerprint,
          executableDigest: runner.executableDigest,
        },
      },
    );
    try {
      const expectedCredentialBinding = createExecutionCredentialBinding({
        grantId: request.grant.id,
        runnerFingerprint: runner.publicKeyFingerprint,
        executableDigest: runner.executableDigest,
        adapterId: flags.adapter,
        operation: flags.operation,
        issuerId: flags.issuer,
        provider: flags.adapter === 'terraform_apply' ? 'aws' : 'github',
        audience: flags.audience,
        requestedScope,
        workingDirectory: workingDirectory ?? null,
        purpose: flags.purpose,
      });
      if (
        redeemed.binding !== expectedCredentialBinding
        || redeemed.grant.id !== request.grant.id
        || redeemed.grant.adapterId !== flags.adapter
        || redeemed.grant.operation !== flags.operation
        || redeemed.grant.issuerId !== flags.issuer
        || redeemed.grant.provider !== (flags.adapter === 'terraform_apply' ? 'aws' : 'github')
        || redeemed.grant.audience !== flags.audience
        || redeemed.grant.purpose !== flags.purpose
        || redeemed.grant.executableDigest !== runner.executableDigest
        || redeemed.grant.workingDirectory !== (workingDirectory ?? null)
        || !sameStringMap(redeemed.grant.requestedScope, requestedScope)
      ) {
        throw new Error('Redeemed credential does not match the approved local binding');
      }
      const credential = decryptExecutionGrantEnvelope(
        redeemed.envelope,
        privateKey,
        expectedCredentialBinding,
      );
      if (publishing) {
        const receipt = await publishReviewedGitHubPr({
          adapterId: flags.adapter,
          operation: flags.operation,
          executablePath: runner.executablePath,
          executableDigest: runner.executableDigest,
          executableIdentity: runner.executableIdentity,
          requestedScope,
          workingDirectory: workingDirectory!,
          title: requestedScope.title,
          body: publicationBody!,
          credential,
        });
        if (!this.jsonEnabled()) {
          this.log(`Pull request ${receipt.action}: #${receipt.pullRequestNumber} ${receipt.pullRequestUrl}`);
          this.log(`Containment tier: ${redeemed.grant.containmentTier}`);
          this.log(`Threat boundary: ${redeemed.grant.threatDisclosure}`);
        }
        return {
          grantId: redeemed.grant.id,
          credentialExpiresAt: redeemed.credentialExpiresAt,
          ...receipt,
        };
      }
      const invocation = buildLocalAdapterInvocation({
        adapterId: flags.adapter,
        operation: flags.operation,
        executablePath: runner.executablePath,
        executableDigest: runner.executableDigest,
        executableIdentity: runner.executableIdentity,
        requestedScope,
        workingDirectory,
        credential,
      });
      const receipt = await runOneReviewedChild(invocation, credential);
      if (receipt.stdout) this.log(receipt.stdout.trimEnd());
      if (receipt.stderr) this.warn(receipt.stderr.trimEnd());
      this.log(`Containment tier: ${receipt.tier}`);
      this.log(`Threat boundary: ${receipt.threatDisclosure}`);
      if (receipt.exitCode !== 0) this.exit(receipt.exitCode);
      return {
        grantId: redeemed.grant.id,
        exitCode: receipt.exitCode,
        containmentTier: receipt.tier,
        credentialExpiresAt: redeemed.credentialExpiresAt,
      };
    } finally {
      handle = '';
      runner.privateKey = null;
    }
  }
}

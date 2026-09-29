import {Args, Flags} from '@oclif/core';
import type {TransitionWorkItemInput} from '@siftable/mcp-server/dist/exfClient.js';
import {BaseCommand, type ApiContextFlags} from './base-command.js';
import {createGitReader, type GitReader} from './work-coverage/bind.js';
import {autoSavePath, runCoverageShadow} from './work-coverage/run.js';
import {
  deleteWorkLeaseSession,
  readWorkLeaseSession,
  writeWorkLeaseSession,
  type WorkLeaseSession,
} from './work-lease-session.js';
import {resolveWorkspaceTenantId} from './workspace-context.js';

export function redactLifecycleResponse(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const record = data as Record<string, unknown>;
  const workItem = record.workItem;
  if (!workItem || typeof workItem !== 'object' || Array.isArray(workItem)) return data;
  const {claimToken: _claimToken, ...safeWorkItem} = workItem as Record<string, unknown>;
  return {...record, workItem: safeWorkItem};
}

export abstract class WorkActionCommand extends BaseCommand {
  static args = {
    id: Args.string({description: 'Work item ID', required: true}),
  };

  static baseActionFlags = {
    ...BaseCommand.baseFlags,
    owner: Flags.string({description: 'Claim owner identity (required for lease-owned transitions)'}),
    'claim-token': Flags.string({description: 'Claim token returned by work claim (required for lease-owned transitions)'}),
    lease: Flags.integer({description: 'Lease seconds'}),
    summary: Flags.string({description: 'Result summary'}),
    artifacts: Flags.string({description: 'Artifact refs JSON array'}),
    reason: Flags.string({description: 'Block or failure reason'}),
    'verification-results': Flags.string({
      description: 'Verification evidence JSON array: [{"command","exitCode","output"?}]',
    }),
    'memory-decision': Flags.string({
      description:
        'Durable code-memory decision JSON (required on agent complete/review): {"decision":"store"|"skip","rationale":"...","fact"?,"category"?,"repositoryId"?,"filePath"?,"paths"?,"evidenceChunkIds"?,"sourceCommit"?,"confidence"?}',
    }),
  };

  protected async runWorkAction(command: typeof WorkActionCommand, action: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const {args, flags} = await this.parse(command);
    const ownerBoundActions = new Set(['start', 'heartbeat', 'block', 'fail']);
    const optionalSessionActions = new Set(['complete', 'review', 'cancel']);
    const hasExplicitOwner = typeof flags.owner === 'string' && flags.owner.length > 0;
    const hasExplicitToken = typeof flags['claim-token'] === 'string' && flags['claim-token'].length > 0;
    if (hasExplicitOwner !== hasExplicitToken) {
      if (action === 'release') {
        this.error('release requires both --owner and --claim-token from the active claim.');
      }
      if (action === 'cancel') {
        this.error('cancel requires --owner and --claim-token together for active work; omit both only for queued/blocked cancellation.');
      }
      this.error(`${action} requires --owner and --claim-token together.`);
    }
    let session: WorkLeaseSession | null = null;
    if (!hasExplicitOwner
      && (ownerBoundActions.has(action) || action === 'release' || optionalSessionActions.has(action))) {
      session = await readWorkLeaseSession(args.id);
      if (session && session.apiUrl !== flags['api-url']) {
        this.error('The saved work lease belongs to a different API URL. Pass explicit lease credentials only after verifying the target service.');
      }
      if (session && flags.workspace
        && resolveWorkspaceTenantId(flags.workspace) !== session.workspaceId) {
        this.error('The saved work lease belongs to a different workspace. Omit --workspace to resume its recorded scope, or pass explicit lease credentials after verifying the target workspace.');
      }
    }
    const claimOwner = hasExplicitOwner ? flags.owner : session?.claimOwner;
    const claimToken = hasExplicitToken ? flags['claim-token'] : session?.claimToken;
    if (ownerBoundActions.has(action) && (!claimOwner || !claimToken)) {
      this.error(`${action} requires both --owner and --claim-token from the active claim.`);
    }
    if (action === 'release' && (!claimOwner || !claimToken)) {
      this.error('release requires both --owner and --claim-token from the active claim.');
    }
    if (action === 'cancel' && Boolean(claimOwner) !== Boolean(claimToken)) {
      this.error('cancel requires --owner and --claim-token together for active work; omit both only for queued/blocked cancellation.');
    }
    if ((action === 'complete' || action === 'review') && claimOwner && claimToken && !flags['memory-decision']) {
      this.error(`${action} under an active claim requires --memory-decision JSON (store or skip with rationale).`);
    }
    const client = await this.client(session
      ? {...flags, workspace: session.workspaceId}
      : flags);
    const response = await client.transitionWorkItem(args.id, action, {
      claimOwner,
      claimToken,
      leaseSeconds: flags.lease,
      resultSummary: flags.summary,
      artifactRefs: this.parseJsonFlag<unknown[]>(flags.artifacts, 'artifacts'),
      verificationResults: this.parseJsonFlag<NonNullable<TransitionWorkItemInput['verificationResults']>>(
        flags['verification-results'],
        'verification-results',
      ),
      durableMemory: this.parseJsonFlag<NonNullable<TransitionWorkItemInput['durableMemory']>>(
        flags['memory-decision'],
        'memory-decision',
      ),
      blockedReason: flags.reason,
      failureReason: flags.reason,
      ...extra,
    }, {idempotencyKey: action === 'heartbeat' ? undefined : this.idempotencyKey()});
    this.handleApiError(response);
    const workItem = this.unwrapOne(response, 'workItem');
    const terminalStatuses = new Set(['queued', 'needs_review', 'done', 'failed', 'cancelled', 'canceled']);
    const terminalActions = new Set(['release', 'review', 'complete', 'fail', 'cancel']);
    const terminal = terminalActions.has(action)
      || terminalStatuses.has(String(workItem.status ?? ''));
    if (terminal) {
      await deleteWorkLeaseSession(args.id);
    } else if (session) {
      const updatedSession = {
        ...session,
        claimToken: typeof workItem.claimToken === 'string' ? workItem.claimToken : session.claimToken,
        expiresAt: typeof workItem.claimExpiresAt === 'string'
          ? workItem.claimExpiresAt
          : session.expiresAt,
        updatedAt: new Date().toISOString(),
      } satisfies WorkLeaseSession;
      try {
        await writeWorkLeaseSession(updatedSession);
      } catch {
        const release = await client.transitionWorkItem(args.id, 'release', {
          claimOwner: updatedSession.claimOwner,
          claimToken: updatedSession.claimToken,
        }, {idempotencyKey: this.idempotencyKey()}).catch(() => null);
        if (release && !release.error) await deleteWorkLeaseSession(args.id);
        this.error(release && !release.error
          ? 'The lease was released because its renewed private session could not be saved.'
          : 'The renewed private session could not be saved and automatic release did not succeed; wait for the lease to expire before reclaiming the item.');
      }
    }
    if (!this.jsonEnabled()) {
      this.log(`Work item ${action}: ${workItem.id}`);
    }
    if (action === 'review') {
      await this.runReviewCoverageShadow(
        typeof workItem.id === 'string' && workItem.id ? workItem.id : args.id,
        session ? {...flags, workspace: session.workspaceId} : flags,
      );
    }
    return redactLifecycleResponse(response.data);
  }

  protected coverageShadowGitReader(signal?: AbortSignal): GitReader {
    return createGitReader(process.cwd(), {signal});
  }

  /**
   * Opt-in (SIFT_COVERAGE_SHADOW=1) Jev coverage shadow after a successful review transition.
   * Best effort: it never changes the review result, exit code or output; a failure writes one
   * warning line to stderr.
   */
  protected async runReviewCoverageShadow(workItemId: string, flags: ApiContextFlags): Promise<void> {
    if (process.env.SIFT_COVERAGE_SHADOW !== '1') return;
    // Bounded independently of the review: the whole run (git reads and both API calls) is cancelled
    // after SIFT_COVERAGE_SHADOW_TIMEOUT_MS (default 90 s), so it can never hold back the review's output.
    const timeoutMs = Number(process.env.SIFT_COVERAGE_SHADOW_TIMEOUT_MS) > 0 ? Number(process.env.SIFT_COVERAGE_SHADOW_TIMEOUT_MS) : 90_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
    try {
      const saveDir = process.env.SIFT_COVERAGE_SHADOW_SAVE_DIR;
      await runCoverageShadow({
        workItemId,
        git: this.coverageShadowGitReader(controller.signal),
        savePath: saveDir ? autoSavePath(saveDir, workItemId) : undefined,
        request: <T>(path: string, options?: {method: 'POST'; body: unknown}) =>
          this.apiRequest<T>(flags, path, {...(options ?? {}), signal: controller.signal}),
      });
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      const message = (reason instanceof Error ? reason.message : String(reason)).replace(/\s+/g, ' ').trim();
      process.stderr.write(`Warning: coverage shadow did not run: ${message}\n`);
    } finally {
      clearTimeout(timer);
    }
  }
}

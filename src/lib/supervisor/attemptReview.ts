/**
 * The review phase (first-run U3-2 contract rev 2): a Taster review of the
 * verified result, after the selected and regression runs pass.
 *
 * 1. The result-commit helper commits the selected run's verified tree on the
 *    base (the result head) and makes it a work tree any reader can open.
 * 2. A review network of its own, a relay sidecar whose handler bills the
 *    reviewer role, and the reviewer container (the pinned reviewer image,
 *    `sift machine review-attempt`), which sees the base objects and the
 *    verified tree read-only and reaches nothing but its sidecar.
 * 3. The model routes are open only while the reviewer runs. Its one result
 *    line is read, capped and checked; then everything the phase made is
 *    removed, under its own cleanup budget.
 *
 * The outcome passes only for a `complete` verdict whose reviewed SHA is the
 * result head.
 */
import {attemptVolumeName, type AttemptFsRecord} from './attemptFilesystem.js';
import {checkAttemptVolume, gone, helperSpec, labels, runHelper, stopped, type WorkspaceContext, WorkspaceRefused} from './attemptWorkspace.js';
import {evaluateNetworkInspect, evaluateSandboxInspect, networkCreateArgs, type SandboxContainerSpec, sandboxCreateArgs} from './containerSandbox.js';
import {attemptRelayHandler, type ModelRelayTarget} from './modelRelayHandler.js';
import {MODEL_PATHS, SIDECAR_PORT} from './relaySidecar.js';
import {serveSidecarFrames} from './sidecarBridge.js';

export const REVIEW_TIMEOUT_MS = 15 * 60_000;

/** The plan's review (U3-2): the pinned reviewer image and the model the relay bills to the reviewer, or why it is refused. */
export function reviewPlanProblem(review: unknown): string | undefined {
  const value = review as {imageRef?: unknown; model?: unknown};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'review is not an object';
  if (Object.keys(value).some((key) => key !== 'imageRef' && key !== 'model')) return 'review has an unknown field';
  if (typeof value.imageRef !== 'string' || !/^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/.test(value.imageRef)) return 'review.imageRef must be pinned by digest';
  if (typeof value.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,200}$/.test(value.model)) return 'review.model must be a provider model id';
  return undefined;
}
const MAX_REVIEW_RESULT_BYTES = 8 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;

export interface ReviewContext extends WorkspaceContext {
  record: AttemptFsRecord;
  /** The pinned reviewer image and its local ID. */
  reviewImageRef: string;
  reviewImageId: string;
  model: string;
  /** The relay sidecar program, bind-mounted read-only. */
  sidecarAsset: string;
  /** The attempt relay, as the reviewer role. */
  relay: Omit<ModelRelayTarget, 'role'>;
  fetch: typeof fetch;
  nextCallId: () => Promise<string>;
  hostAddresses: string[];
  timeoutMs?: number;
}

export interface ReviewOutcome {
  /** The result head the review was asked for. */
  head?: string;
  /** `passed`, or the reason it did not. */
  outcome: 'passed' | 'review_failed' | 'review_head_mismatch' | 'review_timeout' | 'review_interrupted';
  detail?: string;
  /** The reviewer's receipt as it printed it, kept whatever the verdict. */
  receipt?: Record<string, unknown>;
}

/** The result line, checked: a receipt with a verdict, or a refusal; anything else is a failed review. */
export function judgeReview(head: string, line: string): ReviewOutcome {
  let result: {version?: unknown; ok?: unknown; code?: unknown; detail?: unknown; receipt?: unknown};
  try {
    result = JSON.parse(line) as typeof result;
  } catch {
    return {head, outcome: 'review_failed', detail: 'the reviewer printed no result'};
  }
  if (result.version !== 'sift.review-result/v1') return {head, outcome: 'review_failed', detail: 'the reviewer result has an unknown version'};
  if (result.ok !== true) {
    return {head, outcome: 'review_failed', detail: typeof result.detail === 'string' ? result.detail.slice(0, 500) : String(result.code ?? 'failed')};
  }
  const receipt = result.receipt as {verdict?: {kind?: unknown; reviewedSha?: unknown}} | undefined;
  const verdict = receipt?.verdict;
  if (!receipt || typeof receipt !== 'object' || !verdict || typeof verdict.kind !== 'string') {
    return {head, outcome: 'review_failed', detail: 'the reviewer result has no verdict'};
  }
  const kept = receipt as Record<string, unknown>;
  if (verdict.reviewedSha !== head) return {head, outcome: 'review_head_mismatch', detail: `reviewed ${String(verdict.reviewedSha)}`, receipt: kept};
  // skipped, incomplete and failed name the head without a review having happened (contract rev 2, R8).
  if (verdict.kind !== 'complete') return {head, outcome: 'review_failed', detail: `verdict ${verdict.kind}`, receipt: kept};
  return {head, outcome: 'passed', receipt: kept};
}

/** Runs the review phase; never throws for a review that could not run, and always removes what it made. */
export async function runReview(ctx: ReviewContext, input: {baseSha: string; treeId: string}): Promise<ReviewOutcome> {
  const volume = attemptVolumeName(ctx.runId);
  let head: string | undefined;
  try {
    stopped(ctx);
    await checkAttemptVolume(ctx, ctx.record);
    const committed = await runHelper(ctx, 'result-commit', helperSpec(ctx, 'result-commit', 'none', [
      {volume, target: '/workspace', readonly: true, subpath: 'work'},
      {volume, target: '/verify', readonly: false, subpath: 'verify/selected'},
    ], {HOME: '/tmp/h', SIFT_MODE: 'result-commit', SIFT_VERIFY: JSON.stringify(input)}), ctx.timeouts?.patchMs ?? 60_000) as {head?: unknown};
    if (typeof committed.head !== 'string' || !SHA.test(committed.head)) throw new WorkspaceRefused('review_failed', 'no result head');
    head = committed.head;
  } catch (error) {
    return {...(head ? {head} : {}), outcome: error instanceof WorkspaceRefused && error.code === 'interrupted' ? 'review_interrupted' : 'review_failed',
      detail: (error as Error).message.slice(0, 500)};
  }
  const made: Array<{kind: 'container' | 'network'; id: string}> = [];
  let open = false;
  let sidecar: ReturnType<WorkspaceContext['attach']> | undefined;
  let reviewer: ReturnType<WorkspaceContext['attach']> | undefined;
  try {
    stopped(ctx);
    const networkLabels = {'sift.machine.run': ctx.runId, 'sift.machine.attempt': ctx.attemptId};
    const networkId = await ctx.create('review-net', networkCreateArgs(`sift-a-${ctx.runId}-review-net`, {...networkLabels, 'sift.machine.role': 'review-net'}));
    made.push({kind: 'network', id: networkId});
    const relayName = `sift-a-${ctx.runId}-review-relay`;
    const sidecarSpec: SandboxContainerSpec = {
      name: relayName, imageRef: ctx.reviewImageRef, networkId, labels: labels(ctx, 'review-relay'),
      entrypoint: 'node', command: ['/sift/relaySidecar.js'], mounts: [{source: ctx.sidecarAsset, target: '/sift/relaySidecar.js'}],
      tmpfs: ['/tmp'], env: {}, limits: {cpus: 0.5, memoryMb: 256, pidsLimit: 64}, cgroupParent: ctx.slice, interactive: true,
    };
    const reviewerSpec: SandboxContainerSpec = {
      name: `sift-a-${ctx.runId}-reviewer`, imageRef: ctx.reviewImageRef, networkId, labels: labels(ctx, 'reviewer'),
      entrypoint: 'sift', command: ['machine', 'review-attempt'], mounts: [],
      volumes: [{volume, target: '/workspace', readonly: true, subpath: 'work'},
        {volume, target: '/verify', readonly: true, subpath: 'verify/selected'}],
      tmpfs: ['/tmp'], workdir: '/verify/src',
      env: {HOME: '/tmp/h', SIFT_REVIEW: JSON.stringify({baseSha: input.baseSha, head, model: ctx.model}),
        SIFT_RELAY_URL: `http://${relayName}:${SIDECAR_PORT}${MODEL_PATHS.openai}`},
      limits: {cpus: 2, memoryMb: 4096, pidsLimit: 512}, cgroupParent: ctx.slice,
    };
    const sidecarId = await ctx.create('review-relay', sandboxCreateArgs(sidecarSpec));
    made.push({kind: 'container', id: sidecarId});
    const reviewerId = await ctx.create('reviewer', sandboxCreateArgs(reviewerSpec));
    made.push({kind: 'container', id: reviewerId});
    const inspected = await ctx.docker(['container', 'inspect', sidecarId, reviewerId]);
    const entries = inspected.code === 0 ? JSON.parse(inspected.stdout) as Array<{Id?: string}> : [];
    const byId = new Map(entries.map((entry) => [entry.Id, entry]));
    const problems = [
      ...evaluateSandboxInspect(byId.get(sidecarId), {containerId: sidecarId, imageRef: ctx.reviewImageRef, imageId: ctx.reviewImageId, networkId,
        spec: sidecarSpec, phase: 'created'}).problems.map((p) => `review-relay:${p}`),
      ...evaluateSandboxInspect(byId.get(reviewerId), {containerId: reviewerId, imageRef: ctx.reviewImageRef, imageId: ctx.reviewImageId, networkId,
        spec: reviewerSpec, phase: 'created'}).problems.map((p) => `reviewer:${p}`),
    ];
    if (problems.length > 0) throw new WorkspaceRefused('review_failed', `the review containers are not as specified: ${problems.join(', ')}`);
    // Checked before anything joins it: internal, ours, and empty; only the two containers above can join.
    const [network] = JSON.parse((await ctx.docker(['network', 'inspect', networkId])).stdout || '[]') as unknown[];
    const networkProblems = evaluateNetworkInspect(network, {networkId, labels: {...networkLabels, 'sift.machine.role': 'review-net'},
      containerIds: [], hostAddresses: ctx.hostAddresses});
    if (networkProblems.length > 0) throw new WorkspaceRefused('review_failed', `the review network is not as specified: ${networkProblems.join(', ')}`);
    stopped(ctx);
    sidecar = ctx.attach(['start', '--attach', '--interactive', sidecarId]);
    serveSidecarFrames(sidecar.stdout, sidecar.stdin, attemptRelayHandler({fetch: ctx.fetch, diagnosticNonce: ''}, {...ctx.relay, role: 'reviewer'},
      {open: () => open && !ctx.signal?.aborted, nextCallId: ctx.nextCallId}));
    open = true;
    reviewer = ctx.attach(['start', '--attach', reviewerId]);
    const attached = reviewer;
    let out = '';
    attached.stdout.on('data', (chunk: Buffer | string) => { if (out.length < MAX_REVIEW_RESULT_BYTES) out += chunk.toString(); });
    const ended = new Promise<void>((resolve) => { attached.stdout.once('end', resolve); attached.stdout.once('close', resolve); });
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const limit = ctx.timeoutMs ?? REVIEW_TIMEOUT_MS;
    const exit = await Promise.race([Promise.all([attached.exited, ended]).then(([code]) => code),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), limit); }),
      new Promise<'stopped'>((resolve) => {
        onAbort = () => resolve('stopped');
        if (ctx.signal?.aborted) onAbort();
        else ctx.signal?.addEventListener('abort', onAbort, {once: true});
      })]);
    clearTimeout(timer);
    if (onAbort) ctx.signal?.removeEventListener('abort', onAbort);
    open = false;
    if (exit === null) return {head, outcome: 'review_timeout', detail: `the review ran past ${limit} ms`};
    if (exit === 'stopped') return {head, outcome: 'review_interrupted', detail: 'the attempt stopped during the review'};
    return judgeReview(head, out.trim().split('\n').at(-1) ?? '');
  } catch (error) {
    return {head, outcome: error instanceof WorkspaceRefused && error.code === 'interrupted' ? 'review_interrupted' : 'review_failed',
      detail: (error as Error).message.slice(0, 500)};
  } finally {
    open = false;
    for (const item of [...made].reverse()) {
      if (item.kind === 'container') await ctx.docker(['container', 'kill', '--signal', 'KILL', item.id]);
      const removed = await ctx.docker(item.kind === 'container' ? ['container', 'rm', '--force', item.id] : ['network', 'rm', item.id]);
      if (!gone(removed)) ctx.held?.(`${item.kind}:${item.id}`);
    }
    reviewer?.kill();
    sidecar?.kill();
  }
}

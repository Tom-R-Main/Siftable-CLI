import {
  appendCollabEvent,
  claimNextCollabBranch,
  completeCollabBranch,
  createCollabSession,
  enqueueCollabBranch,
  failCollabBranch,
  heartbeatCollabBranch,
  type CollabClaim,
} from './collabEngine';

export interface CollabBranchSpec {
  id: string;
  role: string;
  focus?: string;
  maxToolCalls?: number;
  maxElapsedMs?: number;
}

export interface CollabBranchRunContext<TBranch> {
  branch: TBranch;
  startedAt: number;
  sessionId?: number;
  appendEvent: (type: string, payload?: unknown) => void;
  heartbeat: () => void;
}

export interface CollabBranchFinalState {
  status: 'completed' | 'failed';
  output?: unknown;
  error?: unknown;
}

export interface RunCollabBranchesOptions<TBranch, TResult> {
  root: string;
  cwd: string;
  leaseMs?: number;
  maxBranches?: number;
  process?: 'parallel' | 'sequential';
  workerPrefix: string;
  branches: TBranch[];
  specForBranch: (branch: TBranch) => CollabBranchSpec;
  runBranch: (context: CollabBranchRunContext<TBranch>) => Promise<TResult>;
  finalizeBranch?: (result: TResult, branch: TBranch) => CollabBranchFinalState;
}

export interface RunCollabBranchesResult<TResult> {
  sessionId?: number;
  results: TResult[];
}

interface CollabRunnerContext {
  sessionId: number;
  leaseMs: number;
}

interface CollabRunnerLease extends CollabClaim {
  sessionId: number;
}

export async function runCollabBranches<TBranch, TResult>(
  options: RunCollabBranchesOptions<TBranch, TResult>,
): Promise<RunCollabBranchesResult<TResult>> {
  const collab = createCollabRunnerContext(options);
  const results = options.process === 'sequential'
    ? await runSequentialCollabBranches(options, collab)
    : await Promise.all(options.branches.map((branch) => runOneCollabBranch(options, branch, collab)));
  return {
    ...(collab ? { sessionId: collab.sessionId } : {}),
    results,
  };
}

async function runSequentialCollabBranches<TBranch, TResult>(
  options: RunCollabBranchesOptions<TBranch, TResult>,
  collab: CollabRunnerContext | null,
): Promise<TResult[]> {
  const results: TResult[] = [];
  for (const branch of options.branches) {
    results.push(await runOneCollabBranch(options, branch, collab));
  }
  return results;
}

function createCollabRunnerContext<TBranch, TResult>(
  options: RunCollabBranchesOptions<TBranch, TResult>,
): CollabRunnerContext | null {
  try {
    const sessionId = createCollabSession({
      root: options.root,
      cwd: options.cwd,
      maxBranches: Math.max(1, options.maxBranches ?? options.branches.length),
    });
    for (const branch of options.branches) {
      const spec = options.specForBranch(branch);
      enqueueCollabBranch(sessionId, {
        role: spec.role,
        focus: spec.focus ?? spec.role,
        maxToolCalls: spec.maxToolCalls,
        maxElapsedMs: spec.maxElapsedMs,
      });
    }
    return { sessionId, leaseMs: Math.max(1, options.leaseMs ?? 30_000) };
  } catch {
    return null;
  }
}

async function runOneCollabBranch<TBranch, TResult>(
  options: RunCollabBranchesOptions<TBranch, TResult>,
  branch: TBranch,
  collab: CollabRunnerContext | null,
): Promise<TResult> {
  const startedAt = Date.now();
  const lease = claimCollabBranch(collab, options.workerPrefix, options.specForBranch(branch));
  const context: CollabBranchRunContext<TBranch> = {
    branch,
    startedAt,
    ...(collab ? { sessionId: collab.sessionId } : {}),
    appendEvent: (type, payload) => appendCollabBranchEvent(lease, type, payload),
    heartbeat: () => heartbeatCollabBranchLease(lease, collab?.leaseMs ?? 30_000),
  };
  try {
    const result = await options.runBranch(context);
    const finalState = options.finalizeBranch?.(result, branch) ?? { status: 'completed', output: result };
    if (finalState.status === 'failed') {
      failCollabBranchLease(lease, finalState.error ?? finalState.output ?? 'branch failed');
    } else {
      completeCollabBranchLease(lease, finalState.output ?? result);
    }
    return result;
  } catch (err) {
    appendCollabBranchEvent(lease, 'branch_failed', { error: err instanceof Error ? err.message : String(err) });
    failCollabBranchLease(lease, err);
    throw err;
  }
}

function claimCollabBranch(
  collab: CollabRunnerContext | null,
  workerPrefix: string,
  spec: CollabBranchSpec,
): CollabRunnerLease | null {
  if (!collab) return null;
  try {
    const claim = claimNextCollabBranch(collab.sessionId, {
      worker: `${workerPrefix}:${spec.id}`,
      leaseMs: collab.leaseMs,
    });
    if (!claim) return null;
    const lease = { ...claim, sessionId: collab.sessionId };
    appendCollabBranchEvent(lease, 'branch_started', {
      id: spec.id,
      role: spec.role,
      focus: spec.focus ?? spec.role,
    });
    return lease;
  } catch {
    return null;
  }
}

function appendCollabBranchEvent(lease: CollabRunnerLease | null, type: string, payload: unknown): void {
  if (!lease) return;
  try {
    appendCollabEvent(lease.branchId, {
      leaseToken: lease.leaseToken,
      type,
      payload: compactCollabPayload(payload),
    });
  } catch {
    // Collab journaling is diagnostic; callers keep their existing control flow.
  }
}

function heartbeatCollabBranchLease(lease: CollabRunnerLease | null, leaseMs: number): void {
  if (!lease) return;
  try {
    heartbeatCollabBranch(lease.branchId, { leaseToken: lease.leaseToken, leaseMs });
  } catch {
    // Best-effort only.
  }
}

function completeCollabBranchLease(lease: CollabRunnerLease | null, output: unknown): void {
  if (!lease) return;
  try {
    completeCollabBranch(lease.branchId, {
      leaseToken: lease.leaseToken,
      output: compactCollabPayload(output, 450),
    });
  } catch {
    // Best-effort only.
  }
}

function failCollabBranchLease(lease: CollabRunnerLease | null, error: unknown): void {
  if (!lease) return;
  try {
    failCollabBranch(lease.branchId, {
      leaseToken: lease.leaseToken,
      error: compactCollabPayload(error instanceof Error ? error.message : String(error), 450),
    });
  } catch {
    // Best-effort only.
  }
}

function compactCollabPayload(payload: unknown, maxChars = 1_800): string {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (!raw) return '';
  return raw.length <= maxChars ? raw : `${raw.slice(0, maxChars - 1)}...`;
}

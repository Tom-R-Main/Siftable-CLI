import { AsyncLocalStorage } from 'node:async_hooks';

/** Trusted host bindings, never part of model-visible tool arguments. */
export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly workspaceRoot: string;
  readonly sessionCwd: string;
  /** Absolute epoch milliseconds. */
  readonly deadline?: number;
  readonly signal?: AbortSignal;
  /** Original host cancellation signal, retained by explicitly long-lived jobs. */
  readonly lifetimeSignal?: AbortSignal;
  readonly approval?: Readonly<{ policy: 'ask' | 'deny' | 'allow'; scopeId: string }>;
  readonly onOutput?: (output: { stream: 'stdout' | 'stderr'; text: string }) => void;
}

const executionStorage = new AsyncLocalStorage<ToolExecutionContext>();

export function currentExecutionContext(): ToolExecutionContext | undefined {
  return executionStorage.getStore();
}

export function assertExecutionActive(context = currentExecutionContext()): void {
  if (context?.signal?.aborted) throw new Error('Tool execution cancelled');
  if (context?.deadline !== undefined && Date.now() >= context.deadline) {
    throw new Error('Tool execution deadline exceeded');
  }
}

/** Each invocation owns its timer/listeners; no cross-turn ambient mutation. */
export async function withExecutionContext<T>(context: ToolExecutionContext, run: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(context.signal?.reason);
  if (context.signal?.aborted) abort();
  else context.signal?.addEventListener('abort', abort, { once: true });
  const remaining = context.deadline === undefined ? undefined : context.deadline - Date.now();
  const timer = remaining === undefined ? undefined : setTimeout(() => controller.abort(new Error('Tool execution deadline exceeded')), Math.max(0, remaining));
  if (remaining !== undefined && remaining <= 0) controller.abort();
  const snapshot = Object.freeze({ ...context, lifetimeSignal: context.lifetimeSignal ?? context.signal, approval: context.approval ? Object.freeze({ ...context.approval }) : undefined, signal: controller.signal });
  try {
    assertExecutionActive(snapshot);
    return await executionStorage.run(snapshot, run);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    context.signal?.removeEventListener('abort', abort);
  }
}

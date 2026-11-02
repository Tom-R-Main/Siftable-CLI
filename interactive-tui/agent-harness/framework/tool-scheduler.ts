/**
 * Bounded, order-preserving tool batch scheduler.
 *
 * The model may request several tool calls in one step. Tools that declared
 * themselves parallel-safe run concurrently up to a cap; everything else is
 * exclusive and forms a barrier: it waits for all in-flight calls, runs
 * alone, and only then admits later calls. Classification fails closed —
 * a missing, malformed, or throwing classifier means exclusive.
 *
 * Cancellation stops admissions only: calls that already started always
 * drain (their side effects are in flight and must settle into receipts),
 * while calls that never started are reported as `cancelled` so the caller
 * can record a definitive not-started receipt instead of an uncertain one.
 */

export type ToolExecutionMode = "exclusive" | "parallel-safe";

/** Duck-typed view of a tool definition for classification. */
interface ClassifiableTool {
  executionMode?: (args: Record<string, unknown>) => ToolExecutionMode;
}

/** Resolve a call's execution mode, failing closed to exclusive. */
export function classifyToolCall(
  tool: ClassifiableTool | undefined,
  args: Record<string, unknown>,
): ToolExecutionMode {
  if (!tool || typeof tool.executionMode !== "function") return "exclusive";
  try {
    return tool.executionMode(args) === "parallel-safe" ? "parallel-safe" : "exclusive";
  } catch {
    return "exclusive";
  }
}

export type BatchOutcome<R> =
  | { status: "executed"; value: R }
  | { status: "rejected"; reason: unknown }
  | { status: "cancelled" };

export interface RunToolBatchOptions<C, R> {
  /** Execution mode for the call at this index. */
  mode: (call: C, index: number) => ToolExecutionMode;
  /** Execute one call. Started calls always drain, even after cancellation. */
  execute: (call: C, index: number) => Promise<R>;
  /** Concurrent parallel-safe executions allowed (min 1). */
  maxParallel: number;
  /** Checked before each admission; true stops admitting new calls. */
  isCancelled?: () => boolean;
}

/**
 * Fail-closed cap normalization. NaN propagates through Math.max/Math.floor
 * and Infinity survives them, and either disables the admission guard
 * (`size >= cap` never fires) — so a non-finite cap degrades to serial
 * execution rather than unbounded parallelism.
 */
export function normalizeParallelCap(maxParallel: number): number {
  if (typeof maxParallel !== "number" || !Number.isFinite(maxParallel)) return 1;
  return Math.max(1, Math.floor(maxParallel));
}

/**
 * Run a batch of tool calls with bounded parallelism and exclusive barriers.
 * The result array is aligned to `calls` regardless of completion order.
 */
export async function runToolBatch<C, R>(
  calls: readonly C[],
  options: RunToolBatchOptions<C, R>,
): Promise<Array<BatchOutcome<R>>> {
  const cap = normalizeParallelCap(options.maxParallel);
  const results: Array<BatchOutcome<R>> = new Array(calls.length);
  const inFlight = new Set<Promise<void>>();

  const start = (call: C, index: number): void => {
    const settled = options
      .execute(call, index)
      .then(
        (value) => {
          results[index] = { status: "executed", value };
        },
        (reason: unknown) => {
          results[index] = { status: "rejected", reason };
        },
      )
      .finally(() => {
        inFlight.delete(settled);
      });
    inFlight.add(settled);
  };

  const drainAll = async (): Promise<void> => {
    while (inFlight.size > 0) await Promise.all([...inFlight]);
  };

  let cancelled = false;
  for (let index = 0; index < calls.length; index += 1) {
    cancelled ||= options.isCancelled?.() === true;
    if (cancelled) {
      results[index] = { status: "cancelled" };
      continue;
    }
    const call = calls[index];
    if (options.mode(call, index) === "exclusive") {
      await drainAll();
      // Re-check after the wait: draining may have consumed the abort window.
      cancelled ||= options.isCancelled?.() === true;
      if (cancelled) {
        results[index] = { status: "cancelled" };
        continue;
      }
      start(call, index);
      await drainAll();
    } else {
      while (inFlight.size >= cap) await Promise.race([...inFlight]);
      cancelled ||= options.isCancelled?.() === true;
      if (cancelled) {
        results[index] = { status: "cancelled" };
        continue;
      }
      start(call, index);
    }
  }
  await drainAll();
  return results;
}

/**
 * Terminal transitions for a ChatAgent run record. Each requires the run to
 * still be running and stamps when and why it stopped.
 */
import type { RunRecord } from "./chat-agent-types.js";
import { redactSensitiveText } from "./redaction.js";

export function errorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function requireRunning(run: RunRecord): void {
  if (run.status !== "running") {
    throw new Error(
      `Run "${run.manifest.runId}" is already terminal (${run.status}).`,
    );
  }
}

export function completeRun(
  run: RunRecord,
  options: { limitReached?: boolean } = {},
): RunRecord {
  requireRunning(run);
  return {
    ...run,
    status: options.limitReached ? "limit_reached" : "completed",
    completedAt: new Date().toISOString(),
    stopReason: options.limitReached ? "max_rounds" : "model_response",
  };
}

export function failRun(run: RunRecord, error: unknown): RunRecord {
  requireRunning(run);
  const normalized = error instanceof Error
    ? { name: redactSensitiveText(error.name), message: errorMessage(error) }
    : { name: "Error", message: errorMessage(error) };
  return {
    ...run,
    status: "failed",
    completedAt: new Date().toISOString(),
    stopReason: "error",
    error: normalized,
  };
}

export function cancelRun(
  run: RunRecord,
  cancellation: NonNullable<RunRecord["cancellation"]>,
): RunRecord {
  requireRunning(run);
  return {
    ...run,
    status: "cancelled",
    completedAt: new Date().toISOString(),
    stopReason: "cancelled",
    cancellation: { ...cancellation },
  };
}

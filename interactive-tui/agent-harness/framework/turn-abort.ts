/**
 * Cancellation helpers for a ChatAgent turn: raise the turn's abort reason,
 * wait for the previous turn without outliving the caller's signal, and tell
 * an interruption apart from a failure.
 */

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(abortedTurnReason(signal));
  error.name = "AbortError";
  return error;
}

export function waitForTurn(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return previous;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function isAbortInterruption(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

export function abortedTurnReason(signal: AbortSignal): string {
  if (signal.reason instanceof Error && signal.reason.message) {
    return `chat turn aborted: ${signal.reason.message}`;
  }
  if (typeof signal.reason === "string" && signal.reason.trim()) {
    return `chat turn aborted: ${signal.reason}`;
  }
  return "chat turn aborted";
}

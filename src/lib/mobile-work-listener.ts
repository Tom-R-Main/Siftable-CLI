import {setTimeout as delay} from 'node:timers/promises';

interface MobileListenerOptions<T> {
  poll: () => Promise<T>;
  once: boolean;
  onRetry: (delayMs: number) => void;
  wait?: (delayMs: number) => Promise<unknown>;
}

function retryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as Error & {statusCode?: number}).statusCode;
  // Authentication, permission, local configuration and uncertain execution errors need an operator.
  if (status !== undefined) return status === 0 || [408, 409, 429].includes(status) || status >= 500;
  return error.name === 'AbortError' || (error instanceof TypeError && error.message.includes('fetch'));
}

/** Keep the host registered across transient outages without changing dispatch receipt identity. */
export async function listenForMobileWork<T>(options: MobileListenerOptions<T>): Promise<T> {
  const wait = options.wait ?? delay;
  let failures = 0;
  for (;;) {
    let delayMs = 5000;
    try {
      const state = await options.poll();
      if (options.once) return state;
      failures = 0;
    } catch (error) {
      if (options.once || !retryable(error)) throw error;
      failures += 1;
      delayMs = Math.min(60_000, 5000 * 2 ** Math.min(failures - 1, 4));
      options.onRetry(delayMs);
    }
    await wait(delayMs);
  }
}

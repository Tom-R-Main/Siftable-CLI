/** Keep the interface alive until owned session shutdown is confirmed.
 * Concurrent requests share one attempt; a rejected attempt may be retried. */
export function createConfirmedQuit(closeSessions: () => Promise<void>, destroy: () => void): () => Promise<void> {
  let attempt: Promise<void> | undefined;
  let completed = false;
  return () => {
    if (completed) return Promise.resolve();
    if (attempt) return attempt;
    attempt = Promise.resolve().then(closeSessions).then(() => {
      destroy();
      completed = true;
    }).finally(() => { attempt = undefined; });
    return attempt;
  };
}

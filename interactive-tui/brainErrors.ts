/** User-facing wording for a failed local-harness turn. */

/**
 * The error message, plus a warning when the failure carried evidence that
 * tool side effects may have happened. Receipt details are never included.
 */
export function agentHarnessErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!error || typeof error !== 'object' || !('toolEffects' in error)) return message;

  const effects = (error as {toolEffects?: unknown}).toolEffects;
  if (!effects || typeof effects !== 'object' || Array.isArray(effects)) return message;

  const {
    certainty,
    receipts,
    verificationRequired,
  } = effects as {
    certainty?: unknown;
    receipts?: unknown;
    verificationRequired?: unknown;
  };
  const mayHaveOccurred = certainty === 'unknown'
    || (Array.isArray(receipts) && receipts.length > 0)
    || verificationRequired === true
    || (typeof verificationRequired === 'string' && verificationRequired.length > 0);
  if (!mayHaveOccurred) return message;

  return `${message}\n\nTool side effects may have occurred; verify state before retrying.`;
}

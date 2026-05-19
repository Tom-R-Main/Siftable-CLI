export type GroundingMode = 'library' | 'repo' | 'model' | 'pattern';

export interface EvidenceResult<TSignals extends Record<string, unknown> = Record<string, unknown>> {
  ok: boolean;
  mode: GroundingMode;
  subject: string;
  fetchedAt: string;
  signals: TSignals;
  warnings: string[];
  errors: string[];
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function errorResult<TSignals extends Record<string, unknown>>(
  mode: GroundingMode,
  subject: string,
  error: unknown,
  signals: TSignals,
): EvidenceResult<TSignals> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    mode,
    subject,
    fetchedAt: nowIso(),
    signals,
    warnings: [],
    errors: [message],
  };
}

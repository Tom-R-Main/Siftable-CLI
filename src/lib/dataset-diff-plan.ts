export interface DatasetDiffPlan {
  kind: 'sift.datasetDiffPlan';
  version: 1;
  datasetId: string;
  template?: string;
  upsertBy?: string;
  batchSize?: number;
  sourceFile?: string;
  rows: Array<{fields: Record<string, unknown>}>;
  dryRunResult?: Record<string, unknown>;
}

export function assertDatasetDiffPlan(value: unknown): DatasetDiffPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Diff plan must be a JSON object.');
  }
  const plan = value as Partial<DatasetDiffPlan>;
  if (plan.kind !== 'sift.datasetDiffPlan' || plan.version !== 1) {
    throw new Error('Unsupported diff plan format.');
  }
  if (!plan.datasetId || typeof plan.datasetId !== 'string') {
    throw new Error('Diff plan is missing datasetId.');
  }
  if (!Array.isArray(plan.rows)) {
    throw new Error('Diff plan is missing rows.');
  }
  return plan as DatasetDiffPlan;
}

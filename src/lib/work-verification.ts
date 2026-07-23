export type WorkVerificationPlanView = {
  id?: string;
  workItemId?: string;
  version?: number;
  state?: string;
  revisionReason?: string;
  legacyUnboundEvidence?: unknown[];
  coverage?: {
    state?: string;
    required?: number;
    covered?: number;
    passed?: number;
    missingStepIds?: string[];
    failedStepIds?: string[];
    steps?: Array<{
      step?: {id?: string; key?: string; title?: string; kind?: string};
      latestAttempt?: {attemptId?: string; outcome?: string} | null;
    }>;
  };
};

export function formatVerificationPlan(plan: WorkVerificationPlanView): string {
  const coverage = plan.coverage ?? {};
  const lines = [
    `Plan v${plan.version ?? '?'} [${plan.state ?? 'unknown'}]`,
    `Coverage: ${coverage.state ?? 'unverified'} (${coverage.passed ?? 0}/${coverage.required ?? 0} required steps passing)`,
  ];
  for (const entry of coverage.steps ?? []) {
    const step = entry.step ?? {};
    const attempt = entry.latestAttempt;
    const outcome = attempt?.outcome ?? 'missing';
    lines.push(`  ${outcome === 'passed' ? 'PASS' : outcome === 'missing' ? 'MISS' : 'FAIL'}  ${step.key ?? step.id ?? '?'}  ${step.title ?? ''}`);
  }
  const unbound = plan.legacyUnboundEvidence?.length ?? 0;
  if (unbound > 0) lines.push(`Legacy unbound evidence: ${unbound}`);
  return lines.join('\n');
}

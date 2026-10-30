/**
 * Recording verification on the server (first-run U3-1b, verification
 * contract rev 2 R4/R4b and the rev 3 wiring addendum). The work item's
 * active verification plan is pinned before the attach; each step that ran is
 * submitted once to `POST /work-items/:id/verification-evidence` with a stable
 * attempt id and idempotency key. Only non-secret fields are journaled: the
 * claim token is attached at send time from the live or recovered claim.
 */
import type {RunRecord, VerifyRun} from './attemptVerify.js';

export const VERIFY_STEPS: readonly VerifyRun[] = ['base', 'selected', 'regression'];

export interface VerificationPin {planVersion: number; steps: Record<VerifyRun, string>}

export interface Submission {
  step: VerifyRun;
  key: string;
  state: 'pending' | 'confirmed' | 'conflict';
  /** Everything sent except the claim token. */
  body: Record<string, unknown>;
}

/** What the journal keeps about verification. */
export interface VerificationJournal {
  pin: VerificationPin;
  /** `passed`, or the first failure code; absent while verification has not finished. */
  outcome?: string;
  detail?: string;
  submissions?: Submission[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The active plan's version and its base, selected and regression step ids, or undefined if any is missing. */
export function pinOf(body: unknown): VerificationPin | undefined {
  const reply = body as {activePlanVersion?: unknown; plan?: {version?: unknown; state?: unknown; steps?: unknown}};
  const plan = reply?.plan;
  const version = plan?.version;
  if (!Number.isInteger(version) || (version as number) < 1 || reply.activePlanVersion !== version || plan?.state !== 'active') return undefined;
  if (!Array.isArray(plan.steps)) return undefined;
  const steps: Partial<Record<VerifyRun, string>> = {};
  for (const step of VERIFY_STEPS) {
    const matches = (plan.steps as Array<{key?: unknown; id?: unknown}>).filter((entry) => entry?.key === step);
    if (matches.length !== 1 || typeof matches[0].id !== 'string' || !UUID.test(matches[0].id)) return undefined;
    steps[step] = matches[0].id;
  }
  return {planVersion: version as number, steps: steps as Record<VerifyRun, string>};
}

/** What the user reads for each failure code, after the code itself. */
const EXPLAINED: Record<string, string> = {
  base_test_passes: 'the selected test passes on the base commit, so there is nothing to fix',
  no_tests_collected: 'the test run executed no tests',
  report_missing: 'the test command wrote no JUnit report at $SIFT_TEST_REPORT',
  report_invalid: 'the JUnit report could not be read',
  report_too_large: 'the JUnit report is larger than 8 MiB',
  report_inconsistent: 'the report shows a failing test but the command exited 0',
  frozen_tests_unknown: 'no test file could be identified to freeze; name them in test.files',
  frozen_path_invalid: 'a named test path is not a file or directory at the base commit',
  frozen_test_changed: 'the patch changes a test file that was frozen',
  test_identity_changed: 'the selected tests after the patch are not the ones that ran on the base commit',
  selected_test_failed: 'the selected test does not pass with the patch',
  regression_failed: 'the test suite fails with the patch',
  tree_mutated: 'a test run changed tracked files',
  patch_apply_failed: 'the patch did not apply to a fresh checkout',
  test_timeout: 'a test run passed its time limit',
  verification_interrupted: 'the supervisor restarted during verification; no step was repeated',
  verification_record_conflict: 'the server refused a verification record (the plan may have changed)',
};

export const failureText = (code: string, detail?: string) =>
  `${code}: ${EXPLAINED[code] ?? 'verification failed'}${detail ? ` (${detail.slice(0, 300)})` : ''}`;

/** A step's result: the run that answers it and whether it passed. */
export interface StepResult {step: VerifyRun; run: RunRecord; passed: boolean}

/**
 * The steps a verification answered: every run before the failing one passed; the failing run, if it was
 * recorded, failed. Without a selector the one selected run answers the regression step too.
 */
export function stepResults(runs: RunRecord[], failedAt: VerifyRun | undefined, selectorless: boolean): StepResult[] {
  const results = runs.map((run) => ({step: run.role, run, passed: run.role !== failedAt}));
  const selected = results.find((result) => result.step === 'selected');
  if (selectorless && selected) results.push({step: 'regression', run: selected.run, passed: selected.passed});
  return results;
}

/** One submission per step, built once; the body never holds the claim token. */
export function buildSubmissions(input: {pin: VerificationPin; executionAttemptId: string; environmentLabel: string; claimOwner: string;
  manifestDigest: string; ranAt: string; results: StepResult[]}): Submission[] {
  return input.results.map(({step, run, passed}) => ({
    step, key: `${input.executionAttemptId}:verify:${step}`, state: 'pending' as const,
    body: {
      planVersion: input.pin.planVersion, stepId: input.pin.steps[step], attemptId: `${input.executionAttemptId}:${step}`,
      outcome: passed ? 'passed' : 'failed', exitCode: run.exitCode,
      output: `${step}: ${run.counts.collected} collected, ${run.counts.passed} passed, ${run.counts.failed} failed, ${run.counts.skipped} skipped; exit ${run.exitCode}`,
      artifactRefs: [{type: 'evidence_manifest', attemptId: input.executionAttemptId, manifestDigest: input.manifestDigest, kind: 'verifier_log',
        role: run.role, reportSha256: run.reportSha256}],
      environmentLabel: input.environmentLabel, provenance: {source: 'sift-machine-supervisor', treeId: run.treeId},
      ranAt: input.ranAt, executionAttemptId: input.executionAttemptId, claimOwner: input.claimOwner,
    },
  }));
}

export type PostCall = (route: string, body: unknown, key: string) => Promise<{status: number} | null>;

/**
 * Sends every pending submission with the claim token attached here. 200 or 201 confirms (a replay returns the
 * stored record); 400, 409 and 422 are the server refusing it (a stale plan or a changed replay); anything else
 * leaves it pending, to resend unchanged.
 */
export async function sendSubmissions(post: PostCall, workItemId: string, submissions: Submission[], claimToken: string,
  saved: (next: Submission[]) => Promise<void>): Promise<Submission[]> {
  let current = submissions;
  for (const submission of submissions) {
    if (submission.state !== 'pending') continue;
    const reply = await post(`/api/v1/work-items/${workItemId}/verification-evidence`, {...submission.body, claimToken}, submission.key)
      .catch(() => null);
    const state = reply && (reply.status === 200 || reply.status === 201) ? 'confirmed'
      : reply && [400, 409, 422].includes(reply.status) ? 'conflict' : 'pending';
    if (state === 'pending') continue;
    current = current.map((entry) => (entry.key === submission.key ? {...entry, state} : entry));
    await saved(current);
  }
  return current;
}

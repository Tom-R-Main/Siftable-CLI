/**
 * The coverage-shadow flow shared by `sift work coverage-shadow` and the opt-in shadow that
 * `sift work review` runs when SIFT_COVERAGE_SHADOW=1.
 */
import {chmod, mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {GitReader, PlanStep} from './bind.js';
import {buildCoverageShadowPayload, type CoverageShadowPayload} from './payload.js';

export type CoverageShadowResponse = {
  status: 'recorded' | 'disabled' | 'too_broad' | 'no_candidates' | 'unavailable';
  recordId: string | null;
  criteria: number;
  requests: number;
};

export type CoverageShadowSummary = {
  workItemId: string;
  commit: string;
  planVersion: number;
  candidates: number;
  skippedCases: number;
  filteredCases: number;
  files: string[];
  candidatesComplete: boolean;
  incompleteReasons: string[];
  payloadBytes: number;
  savedTo?: string;
};

export type CoverageShadowOutcome =
  | {outcome: 'too_broad'; summary: CoverageShadowSummary}
  | {outcome: 'dry_run'; summary: CoverageShadowSummary}
  | {outcome: 'posted'; summary: CoverageShadowSummary; response: CoverageShadowResponse};

export type CoverageShadowRequest = <T>(path: string, options?: {method: 'POST'; body: unknown}) => Promise<T>;

type PlanResponse = {
  activePlanVersion?: number;
  plan?: {version?: number; steps?: PlanStep[]};
};

const SHA = /^[0-9a-f]{40}$/;

/** A file name for an automatic save: `<id>-<ISO timestamp with ':' and '.' replaced>.json`. */
export function autoSavePath(dir: string, workItemId: string, at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return join(dir, `${workItemId.replace(/[^\w.-]/g, '_')}-${stamp}.json`);
}

export async function saveCoverageShadowPayload(
  path: string,
  workItemId: string,
  payload: CoverageShadowPayload,
  at: Date = new Date(),
): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  // Saved payloads hold raw test bodies and assertions: owner-only permissions, also when overwriting.
  await writeFile(path, `${JSON.stringify({workItemId, savedAt: at.toISOString(), payload}, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
  await chmod(path, 0o600);
}

export async function runCoverageShadow(input: {
  workItemId: string;
  commitRef?: string;
  dryRun?: boolean;
  savePath?: string;
  git: GitReader;
  request: CoverageShadowRequest;
}): Promise<CoverageShadowOutcome> {
  const ref = input.commitRef ?? 'HEAD';
  const commit = (await input.git.resolveCommit(ref))?.toLowerCase() ?? null;
  if (!commit || !SHA.test(commit)) throw new Error(`Cannot resolve ${ref} to a 40-hex commit in this checkout.`);

  const id = encodeURIComponent(input.workItemId);
  const planResponse = await input.request<PlanResponse>(`/api/v1/work-items/${id}/verification-plan`);
  const planVersion = planResponse.activePlanVersion ?? planResponse.plan?.version;
  if (typeof planVersion !== 'number' || !Number.isInteger(planVersion)) {
    throw new Error('The work item has no active verification plan version.');
  }

  const built = await buildCoverageShadowPayload({commit, planVersion, steps: planResponse.plan?.steps ?? [], git: input.git});
  const summary: CoverageShadowSummary = {
    workItemId: input.workItemId,
    commit,
    planVersion,
    candidates: built.payload.candidates.length,
    skippedCases: built.skippedCases,
    filteredCases: built.filteredCases,
    files: built.binding.testFiles,
    candidatesComplete: built.payload.candidatesComplete,
    incompleteReasons: built.payload.incompleteReasons,
    payloadBytes: Buffer.byteLength(JSON.stringify(built.payload), 'utf8'),
  };
  if (input.savePath) {
    await saveCoverageShadowPayload(input.savePath, input.workItemId, built.payload);
    summary.savedTo = input.savePath;
  }

  if (built.tooBroad) return {outcome: 'too_broad', summary};
  if (input.dryRun) return {outcome: 'dry_run', summary};
  const response = await input.request<CoverageShadowResponse>(
    `/api/v1/work-items/${id}/coverage-shadow`,
    {method: 'POST', body: built.payload},
  );
  return {outcome: 'posted', summary, response};
}

/**
 * Request payload for `POST /api/v1/work-items/:id/coverage-shadow`
 * (docs/plans/jev-work-coverage-shadow.md, schemaVersion 1).
 */
import {createHash} from 'node:crypto';
import {bindPlan, type GitReader, type PlanBinding, type PlanStep} from './bind.js';
import {ASSERT_CHARS, BODY_CHARS, MAX_ASSERT, bodyOf, clip, extract} from './extract.js';

export const SCHEMA_VERSION = 1;
export const MAX_CANDIDATES = 150;
const ELLIPSIS = ' …';

export type CoverageCandidate = {
  caseId: string;
  file: string;
  line: number;
  describePath: string[];
  title: string;
  flags: string[];
  gates: string[];
  assertions: string[];
  body: string;
};

export type CoverageShadowPayload = {
  schemaVersion: 1;
  commit: string;
  planVersion: number;
  candidatesComplete: boolean;
  incompleteReasons: string[];
  candidates: CoverageCandidate[];
};

export type CoverageShadowBuild = {
  payload: CoverageShadowPayload;
  binding: PlanBinding;
  /** Unconditionally skipped cases found and left out of the payload. */
  skippedCases: number;
  tooBroad: boolean;
};

/** build_packets.py `case_id`: first 10 hex of sha256(`commit:file:line:title`). */
export function caseId(commit: string, file: string, line: number, title: string): string {
  return createHash('sha256').update(`${commit}:${file}:${line}:${title}`, 'utf8').digest('hex').slice(0, 10);
}

/**
 * The extractor bounds an assertion at ASSERT_CHARS and appends an ellipsis marker (the audited
 * behaviour); the contract bounds the whole string at ASSERT_CHARS, so a marked assertion is cut
 * back to fit with its marker.
 */
export function boundAssertion(text: string): string {
  if (text.length <= ASSERT_CHARS) return text;
  const base = text.endsWith(ELLIPSIS) ? text.slice(0, -ELLIPSIS.length) : text;
  return clip(base, ASSERT_CHARS - ELLIPSIS.length) + ELLIPSIS;
}

export async function buildCoverageShadowPayload(input: {
  commit: string;
  planVersion: number;
  steps: readonly PlanStep[];
  git: GitReader;
}): Promise<CoverageShadowBuild> {
  const files = await input.git.listFiles(input.commit);
  const binding = bindPlan(input.steps, files);
  const candidates: CoverageCandidate[] = [];
  let skippedCases = 0;
  for (const file of binding.testFiles) {
    const src = await input.git.show(input.commit, file);
    for (const c of extract(src)) {
      if (c.flags.includes('skipped')) {
        skippedCases += 1;
        continue;
      }
      candidates.push({
        caseId: caseId(input.commit, file, c.line, c.title),
        file,
        line: c.line,
        describePath: c.describePath,
        title: c.title,
        flags: c.flags,
        gates: c.gates,
        assertions: c.assertions.slice(0, MAX_ASSERT).map(boundAssertion),
        body: clip(bodyOf(src, c.line), BODY_CHARS),
      });
    }
  }
  return {
    payload: {
      schemaVersion: SCHEMA_VERSION,
      commit: input.commit,
      planVersion: input.planVersion,
      candidatesComplete: binding.candidatesComplete,
      incompleteReasons: binding.incompleteReasons,
      candidates,
    },
    binding,
    skippedCases,
    tooBroad: candidates.length > MAX_CANDIDATES,
  };
}

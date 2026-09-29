/**
 * Request payload for `POST /api/v1/work-items/:id/coverage-shadow`
 * (docs/plans/jev-work-coverage-shadow.md, schemaVersion 1).
 */
import {createHash} from 'node:crypto';
import {bindPlan, type GitReader, type PlanBinding, type PlanStep} from './bind.js';
import {ASSERT_CHARS, BODY_CHARS, MAX_ASSERT, bodyOf, clip, extract} from './extract.js';

export const SCHEMA_VERSION = 1;
export const MAX_CANDIDATES = 150;
/** Server-side schema bounds (exf-app workCoverageShadowService); the CLI never sends a payload outside them. */
export const BOUNDS = {file: 300, title: 500, describeItems: 10, describeChars: 200, gates: 5, gateChars: 200, flags: 10, flagChars: 40, reasons: 50, reasonChars: 300} as const;
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
  /** Cases no step would run because of its test-name filter. */
  filteredCases: number;
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

/**
 * Whether a case is run by at least one step that resolves its file. Jest `-t`/`--testNamePattern` and
 * Vitest `-t` match a regular expression against the full name (describe path and title joined by
 * spaces). A step without a name filter runs every case in the file. Titles whose runtime name is not
 * known statically (printf placeholders, dynamic titles) are kept.
 */
export function selectedByNameFilters(fullName: string, title: string, filterSets: ReadonlyArray<readonly string[]>): boolean {
  if (!filterSets.length) return true;
  if (/%[sdifjoO#%]|\$\{|<dynamic>/.test(title)) return true;
  return filterSets.some((filters) => filters.length === 0 || filters.some((f) => {
    try {
      return new RegExp(f).test(fullName);
    } catch {
      return fullName.includes(f);
    }
  }));
}

const clipAll = (items: readonly string[], n: number, chars: number) => items.slice(0, n).map((x) => clip(x, chars));

export async function buildCoverageShadowPayload(input: {
  commit: string;
  planVersion: number;
  steps: readonly PlanStep[];
  git: GitReader;
}): Promise<CoverageShadowBuild> {
  const files = await input.git.listFiles(input.commit);
  const binding = bindPlan(input.steps, files);
  // Name-filter sets of the steps that resolve each file.
  const filtersByFile = new Map<string, string[][]>();
  for (const step of binding.steps) {
    if (step.class !== 'patterned_test') continue;
    for (const f of step.resolved ?? []) {
      const sets = filtersByFile.get(f) ?? [];
      sets.push(step.nameFilters);
      filtersByFile.set(f, sets);
    }
  }
  const candidates: CoverageCandidate[] = [];
  let skippedCases = 0;
  let filteredCases = 0;
  const reasons = [...binding.incompleteReasons];
  for (const file of binding.testFiles) {
    if (file.length > BOUNDS.file) {
      reasons.push(`test file path over ${BOUNDS.file} characters: ${clip(file, 120)}`);
      continue;
    }
    const src = await input.git.show(input.commit, file);
    for (const c of extract(src)) {
      if (c.flags.includes('skipped')) {
        skippedCases += 1;
        continue;
      }
      if (!selectedByNameFilters([...c.describePath, c.title].join(' '), c.title, filtersByFile.get(file) ?? [])) {
        filteredCases += 1;
        continue;
      }
      candidates.push({
        caseId: caseId(input.commit, file, c.line, c.title),
        file,
        line: c.line,
        describePath: clipAll(c.describePath, BOUNDS.describeItems, BOUNDS.describeChars),
        title: clip(c.title, BOUNDS.title),
        flags: clipAll(c.flags, BOUNDS.flags, BOUNDS.flagChars),
        gates: clipAll(c.gates, BOUNDS.gates, BOUNDS.gateChars),
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
      candidatesComplete: reasons.length === 0,
      incompleteReasons: clipAll(reasons, BOUNDS.reasons, BOUNDS.reasonChars),
      candidates,
    },
    binding,
    skippedCases,
    filteredCases,
    tooBroad: candidates.length > MAX_CANDIDATES,
  };
}

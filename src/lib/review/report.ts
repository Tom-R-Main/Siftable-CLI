// Full local evidence accompanies the compact, backward-compatible v1 receipt.
// Its digest detects edits; it does not authenticate a machine or prove correctness.

import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import type {ReviewBudget, ReviewResult} from '@siftable/taster';
import {canonicalJson, verifyReceipt, type Receipt} from './receipt.js';

export const REVIEW_REPORT_FORMAT = 'taster.local-report/v1';

export interface ReviewReportMetadata {
  repositoryRoot?: string;
  cliVersion?: string;
  codexBin?: string;
  codexVersion?: string;
  budget?: ReviewBudget;
  deadlineMs?: number;
  /** Content identity of the selected packaged runtime's executable code, not its policy. */
  runtime?: {format: 'taster.runtime-code/v1'; digest: string; files: number};
}

/** Hash the shipped code tree, including imported modules, with stable relative names. */
export function fingerprintReviewRuntime(root: string): NonNullable<ReviewReportMetadata['runtime']> {
  const files: string[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), {withFileTypes: true})) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && /\.(?:c|m)?js$/u.test(entry.name)) files.push(name);
      else if (entry.isSymbolicLink()) throw new Error(`Packaged runtime contains a symbolic link: ${name}`);
    }
  };
  visit('');
  if (files.length === 0) throw new Error('Packaged runtime has no executable JavaScript files.');
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    const bytes = readFileSync(join(root, file));
    hash.update(`${Buffer.byteLength(file)}:${file}:${bytes.length}:`);
    hash.update(bytes);
  }
  return {format: 'taster.runtime-code/v1', digest: `sha256:${hash.digest('hex')}`, files: files.length};
}

export interface ReviewReportBody {
  format: typeof REVIEW_REPORT_FORMAT;
  receipt: Receipt;
  /** Null means the engine did not return a result; no missing evidence is invented. */
  result: ReviewResult | null;
  metadata: ReviewReportMetadata;
}

export interface ReviewReport extends ReviewReportBody {
  /** sha256 over all other fields, including the full findings, evidence and manifests. */
  digest: string;
}

function reportDigest(body: ReviewReportBody): string {
  return `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`;
}

export function buildReviewReport(input: {receipt: Receipt; result: ReviewResult | null; metadata: ReviewReportMetadata}): ReviewReport {
  if (!verifyReceipt(input.receipt)) throw new Error('Cannot report a receipt with an invalid digest.');
  if (input.result && (
    input.result.verdict.reviewedSha !== input.receipt.revision.head ||
    input.result.policyRevision !== input.receipt.policy.revision ||
    input.result.verdict.kind !== input.receipt.completion
  )) throw new Error('Review result does not match the receipt revision, policy or completion.');
  // Snapshot rather than retaining mutable engine arrays that could invalidate the digest.
  const body: ReviewReportBody = JSON.parse(JSON.stringify({
    format: REVIEW_REPORT_FORMAT, receipt: input.receipt, result: input.result, metadata: input.metadata,
  })) as ReviewReportBody;
  return {...body, digest: reportDigest(body)};
}

export function verifyReviewReport(report: ReviewReport): boolean {
  const {digest, ...body} = report;
  return report.format === REVIEW_REPORT_FORMAT && verifyReceipt(report.receipt) && digest === reportDigest(body);
}

/** Atomic replacement with private permissions; never leave half a JSON report. */
export function writeReviewReport(path: string, report: ReviewReport): void {
  const target = resolve(path);
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* The private temporary may not have been created. */ }
    throw error;
  }
}

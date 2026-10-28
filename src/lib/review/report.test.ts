import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Finding, ReviewResult, Verdict} from '@siftable/taster';
import {describe, expect, it} from 'vitest';
import {buildReceipt, renderReport, verifyReceipt} from './receipt.js';
import {buildReviewReport, fingerprintReviewRuntime, verifyReviewReport, writeReviewReport} from './report.js';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const finding: Finding = {
  id: 'tf-fixture', title: 'Tail dropped', body: 'A non-full last page is omitted by the new bound.',
  priority: 1, confidence: 0.9,
  location: {path: 'src/page.ts', start: 3, end: 3, side: 'RIGHT', revision: head},
  evidence: [{id: 'ev-1', kind: 'read', path: 'src/page.ts', start: 1, end: 7, revision: head}],
  validation: {outcome: 'confirmed', validator: 'fixture'},
};
const verdict: Verdict = {
  kind: 'complete', reviewedSha: head, blocking: 1, advisory: 0,
  coverage: {
    filesInScope: 2, filesReviewed: 1, filesSkipped: [{path: 'dist/bundle.js', reason: 'generated'}],
    stages: {prepass: 'complete', finders: 'complete', validation: 'complete', priorReconciliation: 'complete', ratchet: 'complete'},
    candidates: {proposed: 1, refuted: 0, unvalidated: 0, suppressed: 0, confirmed: 1},
  },
};

function fixture() {
  const receipt = buildReceipt({
    head, base, mergeBase: base, baseRef: 'main', worktreeDirty: false,
    policy: {name: 'default', revision: 'sha256:policy'}, model: 'fixture', finderPasses: 2,
    problems: [], startedAt: new Date('2026-10-28T00:00:00Z'), finishedAt: new Date('2026-10-28T00:00:01Z'),
  }, verdict, [finding]);
  const result: ReviewResult = {
    verdict, findings: [finding], identities: {}, publication: {inline: [finding.id], summary: [], trace: []},
    priorOutcomes: [], priorAnchors: [], ratchet: [], candidates: [], evidence: finding.evidence,
    incompleteCauses: [], policyRevision: 'sha256:policy', mode: 'local', trace: [],
  };
  return {receipt, result, metadata: {repositoryRoot: '/fixture', codexVersion: 'fixture', budget: {maxModelCalls: 40, concurrency: 2, callTimeoutMs: 1000, maxFiles: 60}}};
}

describe('complete review evidence report', () => {
  it('preserves full findings, evidence, exclusions and runtime budget without changing v1 receipt', () => {
    const input = fixture();
    const report = buildReviewReport(input);
    expect(verifyReceipt(report.receipt)).toBe(true);
    expect(report.receipt.format).toBe('taster.local-receipt/v1');
    expect(report.receipt.findings[0]).not.toHaveProperty('body');
    expect(report.result?.findings[0]?.body).toBe(finding.body);
    expect(report.result?.evidence).toEqual(finding.evidence);
    expect(report.result?.verdict).toEqual(verdict);
    expect(report.metadata.budget).toEqual(input.metadata.budget);
    expect(verifyReviewReport(report)).toBe(true);
    input.result.findings = [];
    expect(report.result?.findings).toHaveLength(1);
    expect(verifyReviewReport(report)).toBe(true);
  });

  it('detects edits to full evidence and rejects a mismatched revision', () => {
    const input = fixture();
    const report = buildReviewReport(input);
    if (!report.result) throw new Error('expected result');
    report.result.findings[0]!.body = 'changed';
    expect(verifyReviewReport(report)).toBe(false);
    input.result.verdict = {kind: 'failed', reviewedSha: base, reason: 'different review'};
    expect(() => buildReviewReport(input)).toThrow('does not match');
  });

  it('retains an honest null result when the engine did not return', () => {
    const {receipt} = fixture();
    const report = buildReviewReport({receipt, result: null, metadata: {}});
    expect(report.result).toBeNull();
    expect(verifyReviewReport(report)).toBe(true);
  });

  it('replaces an existing file atomically with private permissions', () => {
    const root = mkdtempSync(join(tmpdir(), 'taster-report-test-'));
    try {
      const path = join(root, 'report.json');
      writeFileSync(path, 'old', {mode: 0o644});
      const report = buildReviewReport(fixture());
      writeReviewReport(path, report);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(report);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(root)).toEqual(['report.json']);
    } finally { rmSync(root, {recursive: true, force: true}); }
  });

  it('shows actual scope exclusions in the existing terminal report', () => {
    const {receipt, result} = fixture();
    expect(renderReport(receipt, result)).toContain('Skipped: dist/bundle.js (generated)');
  });

  it('fingerprints imported runtime code rather than just its unchanged entrypoint', () => {
    const root = mkdtempSync(join(tmpdir(), 'taster-runtime-identity-'));
    try {
      mkdirSync(join(root, 'engine'));
      writeFileSync(join(root, 'index.js'), 'module.exports = require("./engine/review.js");');
      writeFileSync(join(root, 'engine/review.js'), 'exports.review = 1;');
      const original = fingerprintReviewRuntime(root);
      expect(original.files).toBe(2);
      expect(fingerprintReviewRuntime(root)).toEqual(original);
      writeFileSync(join(root, 'engine/review.js'), 'exports.review = 2;');
      expect(fingerprintReviewRuntime(root).digest).not.toBe(original.digest);
      writeFileSync(join(root, 'engine/review.js'), 'exports.review = 1;');
      expect(fingerprintReviewRuntime(root)).toEqual(original);
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
});

import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {Finding, Verdict} from '@siftable/taster';
import {describe, expect, it} from 'vitest';
import {buildReceipt} from './receipt.js';

// A real receipt as the supervisor's reviewer writes it, for the server's consumers (review summary, published
// check run) to read in their own tests (result-to-github-v1.md; Release M3-R3). Regenerate with
// WRITE_REVIEW_RECEIPT_GOLDEN=1 only for a deliberate receipt format change.
const FIXTURE = path.resolve(__dirname, '../../../../../docs/architecture/review-receipt-golden.json');
const head = 'c'.repeat(40);
const base = 'b'.repeat(40);
const finding = (id: string, priority: Finding['priority'], file: string, start: number, end: number): Finding => ({
  id, title: `Advisory ${id}`, body: 'Fixture body.', priority, confidence: 0.6,
  location: {path: file, start, end, side: 'RIGHT', revision: head},
  evidence: [], validation: {outcome: 'confirmed', validator: 'fixture'},
});
const verdict: Verdict = {
  kind: 'complete', reviewedSha: head, blocking: 0, advisory: 2,
  coverage: {
    filesInScope: 2, filesReviewed: 2, filesSkipped: [],
    stages: {prepass: 'complete', finders: 'complete', validation: 'complete', priorReconciliation: 'complete', ratchet: 'complete'},
    candidates: {proposed: 2, refuted: 0, unvalidated: 0, suppressed: 0, confirmed: 2},
  },
};

function golden() {
  return buildReceipt({
    head, base, mergeBase: base, baseRef: 'main', worktreeDirty: false, policy: {name: 'default', revision: 'sha256:policy'},
    model: 'fixture', finderPasses: 2, problems: [], startedAt: new Date('2026-11-01T00:00:00Z'), finishedAt: new Date('2026-11-01T00:00:05Z'),
  }, verdict, [finding('tf-b', 3, 'src/b.ts', 9, 12), finding('tf-a', 2, 'src/a.ts', 4, 4)]);
}

describe('review receipt golden', () => {
  it('is what buildReceipt writes now', () => {
    if (process.env.WRITE_REVIEW_RECEIPT_GOLDEN === '1') writeFileSync(FIXTURE, `${JSON.stringify(golden(), null, 2)}\n`);
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(golden());
  });

  it('carries numeric priorities, most severe first', () => {
    expect(golden().findings.map(item => [item.id, item.priority])).toEqual([['tf-a', 2], ['tf-b', 3]]);
  });
});

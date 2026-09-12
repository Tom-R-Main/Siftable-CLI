import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {assertAcceptanceReport} from './verify-packaged-runtime.mjs';

const names = [
  'actual read/write loop, JSONL receipts, and no hosted credential',
  'streamed text arrives before completion and prints exactly once',
  'verification passed is candidate-bound and durably recorded',
  'verification failed is candidate-bound and durably recorded',
  'verification stale is candidate-bound and durably recorded',
  'JSON output is exactly one object',
  'background jobs survive tool calls and drain at shutdown',
  'shell results project one output body and retain diagnostic receipts',
  'final answer excludes tool progress and failed partial text stays separate',
  'streamed tool progress and final answer retain separate response boundaries',
  'configured failed check reaches the model, repairs and passes in the same turn',
  'cleanup edits invalidate a previously passing check',
  'a withdrawn user-directed answer never becomes the result; a streamed one is marked in place',
];
const report = `<testsuite>${names.map(name => `<testcase name="cli-packaged: ${name}"></testcase>`).join('')}</testsuite>`;

test('accepts complete packaged evidence', () => assert.equal(assertAcceptanceReport(report), names.length));
test('rejects zero, missing and duplicate cases', () => {
  assert.throws(() => assertAcceptanceReport('<testsuite/>'));
  assert.throws(() => assertAcceptanceReport(report.replace(names[0], 'renamed')));
  assert.throws(() => assertAcceptanceReport(report + report));
});
test('rejects skipped and failed evidence even with all case names present', () => {
  for (const tag of ['skipped', 'failure', 'error']) {
    assert.throws(() => assertAcceptanceReport(report.replace('</testcase>', `<${tag}/></testcase>`)));
  }
});

test('ignores other modes excluded by the dedicated runner filter', () => {
  assert.equal(assertAcceptanceReport(report + '<testcase name="source: excluded"><skipped/></testcase>'), names.length);
});

test('keeps self-closing passed cases separate from filtered cases', () => {
  const selfClosing = report.replaceAll('></testcase>', '/>');
  assert.equal(assertAcceptanceReport(selfClosing + '<testcase name="excluded"><skipped/></testcase>'), names.length);
});

import {describe, expect, it} from 'vitest';
import {NEEDS_OPERATOR_AFTER, needsOperatorLine} from './supervise.js';

// Work item bbebed05: a recovery that keeps settling nothing says so once, instead of retrying silently.
describe('machine supervise operator line', () => {
  it('speaks once, on the recovery that reaches the cap', () => {
    const lines = Array.from({length: NEEDS_OPERATOR_AFTER + 3}, (_, index) => needsOperatorLine(index + 1));
    expect(lines.filter(Boolean)).toHaveLength(1);
    expect(lines[NEEDS_OPERATOR_AFTER - 1]).toContain('Needs an operator');
    expect(needsOperatorLine(0)).toBeUndefined();
  });
});

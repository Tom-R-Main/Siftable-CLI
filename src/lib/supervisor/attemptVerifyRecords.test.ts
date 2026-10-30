import {describe, expect, it} from 'vitest';
import type {RunRecord} from './attemptVerify.js';
import {buildSubmissions, failureText, pinOf, sendSubmissions, stepResults, type Submission} from './attemptVerifyRecords.js';

const ID = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
const plan = (steps: Array<{key: string; id: string}>, version = 3, state = 'active') => ({activePlanVersion: version, plan: {version, state, steps}});
const run = (role: RunRecord['role'], exitCode = 0): RunRecord => ({role, exitCode, treeId: 'f'.repeat(40),
  counts: {collected: 2, passed: 2, failed: 0, skipped: 0}, reportSha256: 'e'.repeat(64), report: '<testsuites/>', output: ''});
const EXECUTION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('verification records', () => {
  it('pins the active plan only when it has exactly one base, selected and regression step', () => {
    const steps = [{key: 'base', id: ID(1)}, {key: 'selected', id: ID(2)}, {key: 'regression', id: ID(3)}, {key: 'lint', id: ID(4)}];
    expect(pinOf(plan(steps))).toEqual({planVersion: 3, steps: {base: ID(1), selected: ID(2), regression: ID(3)}});
    expect(pinOf(plan(steps.slice(1)))).toBeUndefined();
    expect(pinOf(plan([...steps, {key: 'base', id: ID(5)}]))).toBeUndefined();
    expect(pinOf(plan(steps, 3, 'superseded'))).toBeUndefined();
    expect(pinOf({activePlanVersion: 2, plan: {version: 3, state: 'active', steps}})).toBeUndefined();
    expect(pinOf(plan([{key: 'base', id: 'not-a-uuid'}, ...steps.slice(1)]))).toBeUndefined();
    expect(pinOf(undefined)).toBeUndefined();
  });

  it('answers every step that ran: passed before the failure, failed at it; one run answers both without a selector', () => {
    expect(stepResults([run('base', 1), run('selected'), run('regression')], undefined, false).map((r) => [r.step, r.passed]))
      .toEqual([['base', true], ['selected', true], ['regression', true]]);
    expect(stepResults([run('base', 1), run('selected', 2)], 'selected', false).map((r) => [r.step, r.passed]))
      .toEqual([['base', true], ['selected', false]]);
    expect(stepResults([run('base', 0)], 'base', false).map((r) => [r.step, r.passed])).toEqual([['base', false]]);
    expect(stepResults([run('base', 1), run('selected')], undefined, true).map((r) => [r.step, r.passed]))
      .toEqual([['base', true], ['selected', true], ['regression', true]]);
  });

  it('builds each submission once, with stable keys and no claim token', () => {
    const pin = {planVersion: 3, steps: {base: ID(1), selected: ID(2), regression: ID(3)}};
    const [base] = buildSubmissions({pin, executionAttemptId: EXECUTION, environmentLabel: 'sift-machine:r1', claimOwner: 'mobile-runner:r1',
      manifestDigest: 'd'.repeat(64), ranAt: '2026-10-30T08:00:00.000Z', results: [{step: 'base', run: run('base', 1), passed: true}]});
    expect(base).toMatchObject({step: 'base', key: `${EXECUTION}:verify:base`, state: 'pending',
      body: {planVersion: 3, stepId: ID(1), attemptId: `${EXECUTION}:base`, outcome: 'passed', exitCode: 1, executionAttemptId: EXECUTION}});
    expect(JSON.stringify(base)).not.toMatch(/claimToken/);
    expect((base.body.attemptId as string)).toMatch(/^[a-z0-9][a-z0-9._:-]{0,127}$/i);
  });

  it('confirms on 200 or 201, records a refusal, and leaves anything else pending to resend unchanged', async () => {
    const subs: Submission[] = ['base', 'selected', 'regression'].map((step) =>
      ({step: step as Submission['step'], key: `k-${step}`, state: 'pending', body: {step}}));
    const sent: Array<{body: unknown; key: string}> = [];
    const statuses: Record<string, number | null> = {'k-base': 201, 'k-selected': 409, 'k-regression': null};
    const saves: Submission[][] = [];
    const post = async (_route: string, body: unknown, key: string) => {
      sent.push({body, key});
      const status = statuses[key];
      return status === null ? null : {status};
    };
    const after = await sendSubmissions(post, 'w1', subs, 'tok', async (next) => { saves.push(next); });
    expect(after.map((s) => s.state)).toEqual(['confirmed', 'conflict', 'pending']);
    expect(sent.map((s) => s.body)).toEqual([{step: 'base', claimToken: 'tok'}, {step: 'selected', claimToken: 'tok'}, {step: 'regression', claimToken: 'tok'}]);
    // Each state change is saved before the next send; the saved copies never hold the token.
    expect(saves).toHaveLength(2);
    expect(JSON.stringify(saves)).not.toMatch(/tok/);
    // A resend sends only what is still pending, with the same body and key.
    sent.length = 0;
    statuses['k-regression'] = 200;
    const again = await sendSubmissions(post, 'w1', after, 'tok2', async () => undefined);
    expect(sent).toEqual([{body: {step: 'regression', claimToken: 'tok2'}, key: 'k-regression'}]);
    expect(again.map((s) => s.state)).toEqual(['confirmed', 'conflict', 'confirmed']);
  });

  it('explains each failure code to the user', () => {
    expect(failureText('base_test_passes')).toBe('base_test_passes: the selected test passes on the base commit, so there is nothing to fix');
    expect(failureText('unknown_code', 'x')).toBe('unknown_code: verification failed (x)');
  });
});

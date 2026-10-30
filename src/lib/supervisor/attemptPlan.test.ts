import {describe, expect, it} from 'vitest';
import type {ApiResult} from './attemptReport.js';
import {canonicalJson, isAttemptPlan, planSha256, serverPlan, WRITER_ENTRY, writerPlanProblem, type AttemptPlan} from './attemptPlan.js';

const WORK = '70000000-0000-4000-8000-0000000000a1';
const PLAN: AttemptPlan = {
  repositoryId: 'github:example/parser', repositoryUrl: 'https://github.com/example/parser', branch: 'main', baseSha: 'a'.repeat(40),
  imageRef: `node@sha256:${'b'.repeat(64)}`, command: ['node', WRITER_ENTRY], writeScope: ['src'], install: {manager: 'npm'},
  test: {command: 'npm test', selector: 'test/dates.test.ts'}, review: {imageRef: `reviewer@sha256:${'d'.repeat(64)}`, model: 'gpt-6.1-sol'},
  writer: {protocol: 'anthropic', model: 'claude-opus-5-5'},
};

describe('attempt plan source (U6-D1)', () => {
  // The server's evidence/hashing.ts canonicalize gives the same text: keys sorted at every depth, arrays in order.
  it('hashes the canonical JSON the server hashes, whatever the key order', () => {
    expect(canonicalJson({b: [{d: 1, c: 2}], a: null})).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(PLAN).reverse()))) as AttemptPlan;
    expect(planSha256(reordered)).toBe(planSha256(PLAN));
    // Fixed vector, computed with the server's canonicalize + sha256Hex for this plan.
    expect(planSha256(PLAN)).toBe('fe7cabbe6b831a6a234f6b4f57eaf3f7a44b73ebf8aa2ba1c3d7bbc10308d3b1');
  });

  it('reads the frozen plan for the work item in the machine\'s scope, and trusts it only when it hashes to its sha256', async () => {
    const routes: string[] = [];
    const answer = (reply: ApiResult) => async (route: string) => { routes.push(route); return reply; };
    expect(await serverPlan(answer({status: 200, body: {plan: PLAN, sha256: planSha256(PLAN)}}), WORK, null)).toEqual(PLAN);
    expect(routes).toEqual([`/api/v1/work-items/${WORK}/attempt-plan?workspaceId=personal`]);
    await serverPlan(answer({status: 404, body: {}}), WORK, '80000000-0000-4000-8000-0000000000b2');
    expect(routes[1]).toContain('workspaceId=80000000-0000-4000-8000-0000000000b2');
    expect(await serverPlan(answer({status: 200, body: {plan: PLAN, sha256: 'f'.repeat(64)}}), WORK, null)).toBeNull();
    expect(await serverPlan(answer({status: 200, body: {plan: {...PLAN, baseSha: 'short'}, sha256: planSha256({...PLAN, baseSha: 'short'})}}), WORK, null)).toBeNull();
    expect(await serverPlan(answer({status: 404, body: {}}), WORK, null)).toBeNull();
  });

  it('retries a failed read within its attempts, and gives up after them', async () => {
    let calls = 0;
    const flaky = async () => { calls += 1; if (calls < 3) throw new Error('fetch failed'); return {status: 200, body: {plan: PLAN, sha256: planSha256(PLAN)}}; };
    expect(await serverPlan(flaky, WORK, null)).toEqual(PLAN);
    calls = 0;
    expect(await serverPlan(async () => { calls += 1; return {status: 502, body: {}}; }, WORK, null)).toBeNull();
    expect(calls).toBe(3);
  });

  it('needs a writer whenever the command is the adapter', () => {
    expect(writerPlanProblem(PLAN)).toBeUndefined();
    expect(writerPlanProblem({...PLAN, command: ['sh', '-c', 'true'], writer: undefined})).toBeUndefined();
    expect(writerPlanProblem({...PLAN, writer: undefined})).toMatch(/protocol/);
    expect(writerPlanProblem({...PLAN, writer: {protocol: 'gemini' as never, model: 'm'}})).toMatch(/protocol/);
    expect(writerPlanProblem({...PLAN, writer: {protocol: 'openai', model: 'has space'}})).toMatch(/model/);
    expect(isAttemptPlan(PLAN)).toBe(true);
    expect(isAttemptPlan({...PLAN, command: 'node'})).toBe(false);
  });
});

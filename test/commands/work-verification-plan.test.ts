import {installIsolatedConfigDirHooks} from '../helpers/config-env';
import {mockFetch, restoreFetch, runCommand} from '../helpers/mock-api';

installIsolatedConfigDirHooks('sift-cli-work-verification-test-');

afterEach(() => {
  restoreFetch();
});

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const STEP_ID = '22222222-2222-4222-8222-222222222222';

const plan = {
  id: '33333333-3333-4333-8333-333333333333',
  workItemId: WORK_ID,
  version: 2,
  state: 'active',
  coverage: {
    state: 'unverified',
    required: 1,
    covered: 0,
    passed: 0,
    missingStepIds: [STEP_ID],
    failedStepIds: [],
    steps: [{
      step: {id: STEP_ID, key: 'unit', title: 'Run unit tests', kind: 'shell'},
      latestAttempt: null,
    }],
  },
};

describe('work verification commands', () => {
  it('shows the active plan and coverage as JSON', async () => {
    mockFetch()
      .on('GET', `/api/v1/work-items/${WORK_ID}/verification-plan`)
      .reply(200, {plan})
      .install();

    const result = await runCommand([
      'work', 'verification', 'plan', WORK_ID,
      '--token', 'sift_pat_test', '--json',
    ]);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.version).toBe(2);
    expect(parsed.coverage.missingStepIds).toEqual([STEP_ID]);
  });

  it('lists immutable plan history', async () => {
    mockFetch()
      .on('GET', `/api/v1/work-items/${WORK_ID}/verification-plan/history`)
      .reply(200, {plans: [plan, {...plan, version: 1, state: 'superseded'}]})
      .install();

    const result = await runCommand([
      'work', 'verification', 'history', WORK_ID,
      '--token', 'sift_pat_test', '--json',
    ]);

    expect(JSON.parse(result.stdout)).toHaveLength(2);
  });

  it('submits evidence addressed by plan, step, and attempt identity', async () => {
    mockFetch()
      .on('POST', `/api/v1/work-items/${WORK_ID}/verification-evidence`)
      .body((body) => {
        const input = body as Record<string, unknown>;
        return input.planVersion === 2
          && input.stepId === STEP_ID
          && input.attemptId === 'ci-42'
          && input.outcome === 'passed'
          && input.environmentLabel === 'github-actions';
      })
      .reply(201, {
        attempt: {id: 'attempt-1', attemptId: 'ci-42', outcome: 'passed'},
        plan: {...plan, coverage: {...plan.coverage, state: 'commands_passed'}},
      })
      .install();

    const result = await runCommand([
      'work', 'verification', 'evidence', WORK_ID,
      '--plan-version', '2',
      '--step', STEP_ID,
      '--attempt', 'ci-42',
      '--outcome', 'passed',
      '--exit-code', '0',
      '--environment', 'github-actions',
      '--token', 'sift_pat_test',
      '--json',
    ]);

    expect(JSON.parse(result.stdout).attempt.attemptId).toBe('ci-42');
  });

  it('requires explicit confirmation and expected-version concurrency for revision', async () => {
    mockFetch()
      .on('POST', `/api/v1/work-items/${WORK_ID}/verification-plan/revisions`)
      .body((body) => {
        const input = body as {
          expectedActiveVersion?: number;
          reason?: string;
          steps?: Array<{key?: string}>;
        };
        return input.expectedActiveVersion === 2
          && input.reason === 'Repair stale command'
          && input.steps?.[0]?.key === 'unit';
      })
      .reply(201, {plan: {...plan, version: 3}})
      .install();

    const steps = JSON.stringify([{
      key: 'unit',
      title: 'Run unit tests',
      kind: 'shell',
      spec: {command: 'npm test'},
      expectedOutcome: {exitCodes: [0]},
      timeoutSeconds: 900,
      environmentLabel: 'workspace',
    }]);
    const result = await runCommand([
      'work', 'verification', 'revise', WORK_ID,
      '--expected-version', '2',
      '--reason', 'Repair stale command',
      '--steps', steps,
      '--yes',
      '--token', 'sift_pat_test',
      '--json',
    ]);

    expect(JSON.parse(result.stdout).version).toBe(3);
  });
});

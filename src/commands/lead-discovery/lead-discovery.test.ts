import {describe, expect, it, vi} from 'vitest';
import LeadDiscoveryCandidatesReview from './candidates/review.js';
import LeadDiscoveryCandidatesReviewMany from './candidates/review-many.js';
import LeadDiscoveryCompaniesPrepare from './companies/prepare.js';
import LeadDiscoveryCompaniesRun from './companies/run.js';
import LeadDiscoveryCompaniesSearch from './companies/search.js';
import LeadDiscoveryImportPlanCreate from './import-plan/create.js';
import LeadDiscoveryImportPlanLookup from './import-plan/lookup.js';
import LeadDiscoveryOriginGet from './origin/get.js';
import LeadDiscoveryRunsGet from './runs/get.js';

function command<T>(constructor: {prototype: T}): T {
  return Object.create(constructor.prototype) as T;
}

function quiet(instance: object): void {
  (instance as any).jsonEnabled = () => true;
  (instance as any).log = vi.fn();
}

describe('lead discovery CLI commands', () => {
  it('prepares and runs an opaque server-held contract without an execution token', async () => {
    const prepare = command(LeadDiscoveryCompaniesPrepare);
    const prepareApi = vi.fn().mockResolvedValue({
      prepared: {
        preparedQueryId: 'prepared-1', queryDigest: 'a'.repeat(64), expiresAt: '2026-08-29T00:00:00Z',
        estimate: {maximumChargeMicros: '21600'},
      },
    });
    (prepare as any).parse = vi.fn().mockResolvedValue({
      flags: {query: '{"contractVersion":1}', 'target-kind': 'organization', 'idempotency-key': 'prepare-1'},
    });
    (prepare as any).apiRequest = prepareApi;
    quiet(prepare);

    const prepared = await prepare.run();

    expect(prepareApi).toHaveBeenCalledWith(expect.anything(), '/api/v1/lead-discovery/commands/company/prepare', {
      method: 'POST',
      idempotencyKey: 'prepare-1',
      body: {targetKind: 'organization', idempotencyKey: 'prepare-1', query: {contractVersion: 1}},
    });
    expect(JSON.stringify(prepared)).not.toContain('executionToken');

    const run = command(LeadDiscoveryCompaniesRun);
    const runApi = vi.fn().mockResolvedValue({run: {runId: 'run-1', state: 'completed', resultCount: 2}});
    (run as any).parse = vi.fn().mockResolvedValue({
      args: {preparedQueryId: 'prepared-1'},
      flags: {'query-digest': 'a'.repeat(64), 'approved-maximum-charge-micros': '21600'},
    });
    (run as any).apiRequest = runApi;
    quiet(run);

    await run.run();

    expect(runApi).toHaveBeenCalledWith(expect.anything(), '/api/v1/lead-discovery/commands/company/run', {
      method: 'POST',
      body: {preparedQueryId: 'prepared-1', expectedQueryDigest: 'a'.repeat(64), approvedMaximumChargeMicros: '21600'},
    });
    expect(JSON.stringify(runApi.mock.calls)).not.toContain('executionToken');
  });

  it('preserves the ceiling-authorized composite using opaque prepare then exact run', async () => {
    const search = command(LeadDiscoveryCompaniesSearch);
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({prepared: {
        preparedQueryId: 'prepared-1', queryDigest: 'b'.repeat(64), estimate: {maximumChargeMicros: '21000'},
      }})
      .mockResolvedValueOnce({run: {runId: 'run-1', state: 'completed', resultCount: 1}});
    (search as any).parse = vi.fn().mockResolvedValue({flags: {
      query: '{"contractVersion":1}', 'maximum-charge-micros': '22000', 'idempotency-key': 'search-1',
    }});
    (search as any).apiRequest = apiRequest;
    quiet(search);

    await search.run();

    expect(apiRequest).toHaveBeenNthCalledWith(2, expect.anything(), '/api/v1/lead-discovery/commands/company/run', {
      method: 'POST',
      body: {preparedQueryId: 'prepared-1', expectedQueryDigest: 'b'.repeat(64), approvedMaximumChargeMicros: '21000'},
    });
    expect(JSON.stringify(apiRequest.mock.calls)).not.toContain('executionToken');
  });

  it.each([
    {digest: 'A'.repeat(64), charge: '21600', message: 'lowercase SHA-256 digest'},
    {digest: 'a'.repeat(63), charge: '21600', message: 'lowercase SHA-256 digest'},
    {digest: 'a'.repeat(64), charge: '-1', message: 'non-negative integer string'},
    {digest: 'a'.repeat(64), charge: '01', message: 'non-negative integer string'},
  ])('rejects non-canonical prepared-run flags before an API call', async ({digest, charge, message}) => {
    const run = command(LeadDiscoveryCompaniesRun);
    const apiRequest = vi.fn();
    (run as any).parse = vi.fn().mockResolvedValue({
      args: {preparedQueryId: 'prepared-1'},
      flags: {'query-digest': digest, 'approved-maximum-charge-micros': charge},
    });
    (run as any).apiRequest = apiRequest;
    quiet(run);

    await expect(run.run()).rejects.toThrow(message);
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('recovers a durable run by stable ID', async () => {
    const get = command(LeadDiscoveryRunsGet);
    const apiRequest = vi.fn().mockResolvedValue({run: {runId: 'run-1', state: 'held', resultCount: 0}});
    (get as any).parse = vi.fn().mockResolvedValue({args: {runId: 'run-1'}, flags: {}});
    (get as any).apiRequest = apiRequest;
    quiet(get);

    await get.run();

    expect(apiRequest).toHaveBeenCalledWith(expect.anything(), '/api/v1/lead-discovery/runs/run-1');
  });

  it('sends versioned structured single and ordered batch reviews', async () => {
    const review = command(LeadDiscoveryCandidatesReview);
    const reviewApi = vi.fn().mockResolvedValue({review: {
      candidate: {id: 'candidate-1', state: 'shortlisted', reasonNote: 'private operator note'},
      reviewVersion: 3,
    }});
    (review as any).parse = vi.fn().mockResolvedValue({args: {candidateId: 'candidate-1'}, flags: {
      state: 'shortlisted', 'expected-review-version': 2, 'reason-code': 'strong_use_case_fit',
      'reason-note': 'Qualified', 'idempotency-key': 'review-1',
    }});
    (review as any).apiRequest = reviewApi;
    const reviewLog = vi.fn();
    (review as any).jsonEnabled = () => false;
    (review as any).log = reviewLog;

    await review.run();

    expect(reviewApi).toHaveBeenCalledWith(expect.anything(), '/api/v1/lead-discovery/candidates/candidate-1/review', {
      method: 'POST',
      idempotencyKey: 'review-1',
      body: {
        expectedReviewVersion: 2, idempotencyKey: 'review-1', state: 'shortlisted',
        reasonCode: 'strong_use_case_fit', reasonNote: 'Qualified',
      },
    });
    expect(JSON.stringify(reviewLog.mock.calls)).not.toContain('private operator note');

    const batch = command(LeadDiscoveryCandidatesReviewMany);
    const batchApi = vi.fn().mockResolvedValue({reviewBatch: {outcome: 'partial', items: [
      {candidateId: 'candidate-1', ok: true}, {candidateId: 'candidate-2', ok: false},
    ]}});
    const reviews = [{
      candidateId: 'candidate-1', expectedReviewVersion: 2, idempotencyKey: 'review-1',
      state: 'shortlisted', reasonCode: 'strong_use_case_fit',
    }];
    (batch as any).parse = vi.fn().mockResolvedValue({flags: {reviews: JSON.stringify(reviews)}});
    (batch as any).apiRequest = batchApi;
    quiet(batch);

    await batch.run();

    expect(batchApi).toHaveBeenCalledWith(expect.anything(), '/api/v1/lead-discovery/candidates/review-many', {
      method: 'POST', body: {reviews},
    });
  });

  it('creates, recovers, and traces shortlist-bound import plans', async () => {
    const digest = 'c'.repeat(64);
    const create = command(LeadDiscoveryImportPlanCreate);
    const createApi = vi.fn().mockResolvedValue({importPlan: {planId: 'plan-1', runId: 'run-1', shortlistDigest: digest}});
    (create as any).parse = vi.fn().mockResolvedValue({args: {runId: 'run-1'}, flags: {
      'candidate-id': ['candidate-1'], 'expected-shortlist-digest': digest, 'idempotency-key': 'import-1',
    }});
    (create as any).apiRequest = createApi;
    quiet(create);
    await create.run();
    expect(createApi).toHaveBeenCalledWith(expect.anything(), '/api/v1/lead-discovery/commands/import-plan/create', {
      method: 'POST', idempotencyKey: 'import-1', body: {
        runId: 'run-1', candidateIds: ['candidate-1'], expectedShortlistDigest: digest, idempotencyKey: 'import-1',
      },
    });

    const lookup = command(LeadDiscoveryImportPlanLookup);
    const lookupApi = vi.fn().mockResolvedValue({importPlan: {planId: 'plan-1', runId: 'run-1', shortlistDigest: digest}});
    (lookup as any).parse = vi.fn().mockResolvedValue({args: {runId: 'run-1'}, flags: {'expected-shortlist-digest': digest}});
    (lookup as any).apiRequest = lookupApi;
    quiet(lookup);
    await lookup.run();
    expect(lookupApi).toHaveBeenCalledWith(expect.anything(), '/api/v1/lead-discovery/commands/import-plan/lookup', {
      method: 'POST', body: {runId: 'run-1', expectedShortlistDigest: digest},
    });

    const origin = command(LeadDiscoveryOriginGet);
    const originApi = vi.fn().mockResolvedValue({origin: {organizationId: 'organization-1', runId: 'run-1'}});
    (origin as any).parse = vi.fn().mockResolvedValue({args: {organizationId: 'organization-1'}, flags: {}});
    (origin as any).apiRequest = originApi;
    quiet(origin);
    await origin.run();
    expect(originApi).toHaveBeenCalledWith(expect.anything(), '/api/v1/lead-discovery/organizations/organization-1/origin');
  });
});

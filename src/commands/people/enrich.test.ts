import {describe, expect, it, vi} from 'vitest';
import PeopleEnrich from './enrich.js';

function command<T>(constructor: {prototype: T}): T {
  return Object.create(constructor.prototype) as T;
}

describe('people enrich CLI surface', () => {
  it('passes research depth, reconciliation target, and stable idempotency through the headless API', async () => {
    const enrich = command(PeopleEnrich);
    const apiRequest = vi.fn().mockResolvedValue({
      success: true,
      mode: 'ultra',
      profile: {facts: [{id: 'fact-1'}]},
      datasetDiffPlan: {plan: {id: 'plan-1', status: 'validated'}},
    });
    (enrich as any).parse = vi.fn().mockResolvedValue({
      args: {id: 'person-1'},
      flags: {
        mode: 'ultra',
        dataset: 'dataset-1',
        'dataset-upsert-by': 'linkedin_url',
        'idempotency-key': 'person-research-0001',
      },
    });
    (enrich as any).apiRequest = apiRequest;
    (enrich as any).jsonEnabled = () => true;

    await enrich.run();

    expect(apiRequest).toHaveBeenCalledWith(
      expect.anything(),
      '/api/v1/people/person-1/enrich',
      {
        method: 'POST',
        idempotencyKey: 'person-research-0001',
        body: {mode: 'ultra', datasetId: 'dataset-1', datasetUpsertBy: 'linkedin_url'},
      },
    );
  });
});

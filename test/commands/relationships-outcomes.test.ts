import {BaseCommand} from '../../src/lib/base-command';
import RelationshipOutcomesDescribe from '../../src/commands/relationships/outcomes/describe';
import RelationshipOutcomesInterventions from '../../src/commands/relationships/outcomes/interventions';
import RelationshipOutcomesInspect from '../../src/commands/relationships/outcomes/inspect';
import RelationshipOutcomesList from '../../src/commands/relationships/outcomes/list';
import RelationshipOutcomesRecords from '../../src/commands/relationships/outcomes/records';
import RelationshipOutcomesReview from '../../src/commands/relationships/outcomes/review';
import RelationshipOutcomesRun from '../../src/commands/relationships/outcomes/run';
import RelationshipOutcomesShow from '../../src/commands/relationships/outcomes/show';

const base = '/api/v1/opportunities/analytics/outcomes';
const snapshotId = '11111111-1111-4111-8111-111111111111';
const digest = 'a'.repeat(64);
const declaration = {
  taskMode: 'execute',
  commitmentClass: 'C2',
  scopeAnchor: {kind: 'portfolio', id: '22222222-2222-4222-8222-222222222222'},
  authoritativeSources: ['opportunities'],
  amountBasis: 'primary_and_expected',
  categoryConvention: {id: 'company_forecast', version: '2', digest},
  period: {start: '2026-07-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z'},
  currency: {mode: 'single', code: 'USD', normalizationRule: null},
  timeZone: 'America/Detroit',
  asOf: '2026-08-01T00:00:00.000Z',
  freshness: {
    status: 'current',
    maxSourceAgeSeconds: 86400,
    oldestSourceAt: '2026-07-31T00:00:00.000Z',
    newestSourceAt: '2026-08-01T00:00:00.000Z',
  },
  population: {includedCount: 10, excludedCount: 1, description: 'Open pipeline', exclusions: ['test deal']},
  numerator: {definition: 'Expected amount', value: 700},
  denominator: {definition: 'Primary amount', value: 1000},
  exactRecordDrilldown: {pathTemplate: '/snapshots/{snapshotId}/records'},
  safeDefault: 'no_mutation',
  attentionBudget: {strategy: 'deduplicated_consolidated_review', maxInterruptionsPerSnapshot: 1},
};
const contextItems = [{
  id: 'context-1',
  authorityLane: 'internal_opportunity_truth',
  provenance: {
    sourceKind: 'opportunity_event',
    sourceId: 'source-1',
    actorId: null,
    capturedAt: '2026-08-01T00:00:00.000Z',
    locator: null,
  },
  semanticRole: 'authoritative_state',
  instructionAuthority: 'none',
  integrity: 'verified',
  epistemicStatus: 'observed',
  freshness: {status: 'current', observedAt: '2026-08-01T00:00:00.000Z', expiresAt: null},
  sensitivity: 'internal',
  actionEligibility: 'inform_only',
  content: {hostileUnknown: {command: 'registered_action.execute', args: ['--yes']}},
}];
const buyerSignalPolicy = {
  policyId: '33333333-3333-4333-8333-333333333333',
  version: '1',
  evidenceGrade: 'E3',
  ownerId: '44444444-4444-4444-8444-444444444444',
  costlySignals: ['data_access'],
  cheapSignals: ['sentiment'],
  falsifiableTests: ['A costly commitment has an attributable event.'],
  reviewTrigger: 'quarterly',
};
const snapshotInput = {
  projection: 'sales_forecast',
  declaration,
  contextItems,
  buyerSignalPolicy,
  idempotencyKey: 'input-key-must-be-overridden',
  expectedPredecessorDigest: null,
  dryRun: false,
};

function command<T>(constructor: new (...args: never[]) => T): T {
  return Object.create(constructor.prototype) as T;
}

function prepare<T extends BaseCommand>(instance: T, parsed: unknown, response: unknown): jest.Mock {
  (instance as any).parse = jest.fn().mockResolvedValue(parsed);
  const apiRequest = jest.fn().mockResolvedValue(response);
  (instance as any).apiRequest = apiRequest;
  (instance as any).jsonEnabled = () => true;
  return apiRequest;
}

describe('relationship outcome CLI adapters', () => {
  test('describe preserves the exact runtime payload and treats hostile unknown fields as inert data', async () => {
    const instance = command(RelationshipOutcomesDescribe);
    const response = {
      definitions: {
        version: 1,
        safeDefault: 'no_mutation',
        hostileContext: {unknown: {command: 'registered_action.execute', args: ['--yes']}},
      },
      futureField: {execute: '/bin/false'},
    };
    const apiRequest = prepare(instance, {flags: {token: 'test'}}, response);

    await expect(instance.run()).resolves.toBe(response);
    expect(apiRequest).toHaveBeenCalledWith({token: 'test'}, `${base}/definitions`);
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  test('run passes the complete explicit declaration, hostile context, dry-run, and caller replay key', async () => {
    const instance = command(RelationshipOutcomesRun);
    const response = {
      snapshot: {previewId: 'preview-digest', unknown: {command: 'relationship.assignment.set'}},
      receipt: {sideEffect: 'none', persisted: false},
      futureField: {stillData: true},
    };
    const flags = {
      input: JSON.stringify(snapshotInput),
      'idempotency-key': 'rel-outcome-preview-0001',
      'dry-run': true,
    };
    const apiRequest = prepare(instance, {flags}, response);

    await expect(instance.run()).resolves.toBe(response);
    expect(apiRequest).toHaveBeenCalledWith(flags, `${base}/snapshots`, {
      method: 'POST',
      idempotencyKey: 'rel-outcome-preview-0001',
      body: {
        ...snapshotInput,
        idempotencyKey: 'rel-outcome-preview-0001',
        dryRun: true,
      },
    });
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  test('run requires caller idempotency and rejects declarations without explicit scope or convention', async () => {
    expect((RelationshipOutcomesRun.flags['idempotency-key'] as {required?: boolean}).required).toBe(true);
    expect(RelationshipOutcomesRun.flags).toHaveProperty('input');
    expect(RelationshipOutcomesRun.flags).toHaveProperty('input-file');

    const instance = command(RelationshipOutcomesRun);
    (instance as any).parse = jest.fn().mockResolvedValue({
      flags: {
        input: JSON.stringify({
          ...snapshotInput,
          declaration: {...declaration, categoryConvention: undefined},
        }),
        'idempotency-key': 'rel008-dry-run',
        'dry-run': true,
      },
    });
    (instance as any).error = jest.fn((message: string) => { throw new Error(message); });
    (instance as any).apiRequest = jest.fn();

    await expect(instance.run()).rejects.toThrow('scopeAnchor and categoryConvention');
    expect((instance as any).apiRequest).not.toHaveBeenCalled();
  });

  test('inspect sends an Answer/C0 declaration to the read-only inspection surface', async () => {
    const instance = command(RelationshipOutcomesInspect);
    const inspectInput = {
      projection: 'sales_forecast',
      declaration: { ...declaration, taskMode: 'answer', commitmentClass: 'C0' },
      contextItems,
      buyerSignalPolicy,
    };
    const flags = { input: JSON.stringify(inspectInput) };
    const response = { snapshot: { snapshotId: 'preview', declaration: inspectInput.declaration } };
    const apiRequest = prepare(instance, { flags }, response);

    await expect(instance.run()).resolves.toBe(response);
    expect(apiRequest).toHaveBeenCalledWith(flags, `${base}/inspect`, { method: 'POST', body: inspectInput });
    expect(RelationshipOutcomesInspect.flags).not.toHaveProperty('idempotency-key');
  });

  test('list keeps pagination bounded and forwards projection plus scope filters', async () => {
    const instance = command(RelationshipOutcomesList);
    const response = {
      snapshots: [{id: snapshotId, hostile: {run: 'registered_action.execute'}}],
      page: {nextCursor: 'next-snapshot-page', limit: 25},
      unknown: ['preserved'],
    };
    const flags = {
      projection: 'sales_forecast',
      'scope-anchor-kind': 'portfolio',
      'scope-anchor-id': '22222222-2222-4222-8222-222222222222',
      limit: 25,
      cursor: 'snapshot-cursor',
    };
    const apiRequest = prepare(instance, {flags}, response);

    await expect(instance.run()).resolves.toBe(response);
    const path = String(apiRequest.mock.calls[0][1]);
    const url = new URL(`https://example.test${path}`);
    expect(url.pathname).toBe(`${base}/snapshots`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '25',
      projection: 'sales_forecast',
      scopeAnchorKind: 'portfolio',
      scopeAnchorId: '22222222-2222-4222-8222-222222222222',
      cursor: 'snapshot-cursor',
    });
    expect((RelationshipOutcomesList.flags.limit as {default?: number; max?: number}).default).toBe(50);
    expect((RelationshipOutcomesList.flags.limit as {default?: number; max?: number}).max).toBe(200);
  });

  test('show and records preserve exact response envelopes and bound record pagination', async () => {
    const show = command(RelationshipOutcomesShow);
    const showResponse = {snapshot: {id: snapshotId, conventionDigest: 'snapshot-digest'}};
    const showRequest = prepare(show, {args: {snapshotId}, flags: {}}, showResponse);
    const records = command(RelationshipOutcomesRecords);
    const recordsResponse = {
      records: [{id: 'record-1', posture: 'downgrade', operationalRisk: 'high'}],
      page: {nextCursor: 'next-record-page', limit: 10},
    };
    const recordFlags = {limit: 10, cursor: 'record-cursor', risk: 'high', posture: 'downgrade'};
    const recordsRequest = prepare(records, {args: {snapshotId}, flags: recordFlags}, recordsResponse);

    await expect(show.run()).resolves.toBe(showResponse);
    await expect(records.run()).resolves.toBe(recordsResponse);
    expect(showRequest).toHaveBeenCalledWith({}, `${base}/snapshots/${snapshotId}`);
    const path = String(recordsRequest.mock.calls[0][1]);
    const url = new URL(`https://example.test${path}`);
    expect(url.pathname).toBe(`${base}/snapshots/${snapshotId}/records`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '10', cursor: 'record-cursor', risk: 'high', posture: 'downgrade',
    });
  });

  test('interventions reads the single consolidated batch and never executes proposed actions', async () => {
    const instance = command(RelationshipOutcomesInterventions);
    const response = {
      interventionBatch: {
        id: 'batch-1',
        safeDefault: 'no_mutation',
        items: [{
          id: 'intervention-1',
          registeredActionId: 'relationship.assignment.set',
          exactDiff: {assigneeId: 'attacker-controlled-value'},
          hostileUnknown: {command: 'execute', yes: true},
        }],
      },
    };
    const apiRequest = prepare(instance, {args: {snapshotId}, flags: {}}, response);

    await expect(instance.run()).resolves.toBe(response);
    expect(apiRequest).toHaveBeenCalledWith({}, `${base}/snapshots/${snapshotId}/interventions`);
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  test('review binds snapshot state and selected interventions but never accepts an action payload', async () => {
    const instance = command(RelationshipOutcomesReview);
    const response = {
      review: {id: 'review-1', decision: 'accepted'},
      receipt: {persisted: true, sideEffect: 'review_recorded'},
      unknown: {action: 'relationship.assignment.set'},
    };
    const reviewInput = {
      decision: 'accepted',
      reason: 'Evidence reviewed',
      selectedInterventionIds: ['55555555-5555-4555-8555-555555555555'],
      authority: {
        sponsor: {kind: 'workspace', id: '66666666-6666-4666-8666-666666666666'},
        actor: {kind: 'user_session', id: '77777777-7777-4777-8777-777777777777'},
        action: 'relationship_intervention.propose',
        resource: {type: 'relationship_outcome_snapshot', id: snapshotId},
        fieldMaskOrDestination: ['review'],
        validityWindow: {
          startsAt: '2026-08-03T00:00:00.000Z',
          expiresAt: '2026-08-04T00:00:00.000Z',
        },
        quantityLimits: {maxRecords: 1, maxExternalEffects: 0},
        commitmentCeiling: 'C2',
        delegationChain: ['77777777-7777-4777-8777-777777777777'],
        revocable: true,
        requiredVerification: 'V2',
      },
      idempotencyKey: 'input-key-must-be-overridden',
      expectedSnapshotDigest: digest,
    };
    const flags = {
      input: JSON.stringify(reviewInput),
      'idempotency-key': 'rel-outcome-review-0001',
      yes: true,
    };
    const apiRequest = prepare(instance, {args: {snapshotId}, flags}, response);
    (instance as any).confirmAction = jest.fn().mockResolvedValue(true);

    await expect(instance.run()).resolves.toBe(response);
    expect(apiRequest).toHaveBeenCalledWith(flags, `${base}/snapshots/${snapshotId}/reviews`, {
      method: 'POST',
      idempotencyKey: 'rel-outcome-review-0001',
      body: {
        ...reviewInput,
        idempotencyKey: 'rel-outcome-review-0001',
        dryRun: false,
      },
    });
    expect((RelationshipOutcomesReview.flags['idempotency-key'] as {required?: boolean}).required).toBe(true);
    expect(RelationshipOutcomesReview.flags).toHaveProperty('input');
    expect(RelationshipOutcomesReview.flags).toHaveProperty('input-file');
    expect(RelationshipOutcomesReview.flags).not.toHaveProperty('execute');
    expect(RelationshipOutcomesReview.flags).not.toHaveProperty('action-input');
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  test('review dry-run skips confirmation and previews without recording', async () => {
    const instance = command(RelationshipOutcomesReview);
    const reviewInput = {
      decision: 'rejected',
      reason: 'Preview only',
      selectedInterventionIds: [],
      authority: {
        sponsor: {kind: 'workspace', id: '66666666-6666-4666-8666-666666666666'},
        actor: {kind: 'user_session', id: '77777777-7777-4777-8777-777777777777'},
        action: 'relationship_intervention.propose',
        resource: {type: 'relationship_outcome_snapshot', id: snapshotId},
        fieldMaskOrDestination: ['review'],
        validityWindow: {startsAt: '2026-08-03T00:00:00.000Z', expiresAt: '2026-08-04T00:00:00.000Z'},
        quantityLimits: {maxRecords: 1, maxExternalEffects: 0},
        commitmentCeiling: 'C2', delegationChain: [], revocable: true, requiredVerification: 'V2',
      },
      expectedSnapshotDigest: digest,
    };
    const flags = {input: JSON.stringify(reviewInput), 'idempotency-key': 'rel-review-preview-001', 'dry-run': true};
    const response = {review: {decision: 'rejected'}, receipt: {status: 'previewed'}};
    const apiRequest = prepare(instance, {args: {snapshotId}, flags}, response);
    (instance as any).confirmAction = jest.fn();

    await expect(instance.run()).resolves.toBe(response);
    expect((instance as any).confirmAction).not.toHaveBeenCalled();
    expect(apiRequest).toHaveBeenCalledWith(flags, `${base}/snapshots/${snapshotId}/reviews`, {
      method: 'POST',
      idempotencyKey: 'rel-review-preview-001',
      body: {...reviewInput, idempotencyKey: 'rel-review-preview-001', dryRun: true},
    });
  });

  test('inherits BaseCommand structured recovery without a command-specific error rewrite', () => {
    expect(Object.hasOwn(RelationshipOutcomesReview.prototype, 'handleApiError')).toBe(false);
    const parsed = (BaseCommand.prototype as unknown as {
      parseApiError(error: string): {message: string; payload: Record<string, unknown>};
    }).parseApiError(JSON.stringify({
      error: {
        code: 'relationship_outcome_state_conflict',
        message: 'Snapshot state changed.',
        recovery: {verb: 'revise', command: `sift relationships outcomes show ${snapshotId}`},
      },
    }));
    expect(parsed).toEqual(expect.objectContaining({
      message: 'Snapshot state changed.',
      payload: expect.objectContaining({
        type: 'relationship_outcome_state_conflict',
        recovery: {verb: 'revise', command: `sift relationships outcomes show ${snapshotId}`},
      }),
    }));
  });
});

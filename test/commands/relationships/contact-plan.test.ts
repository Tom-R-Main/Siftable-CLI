import RelationshipsContactPlanInspect, {
  renderContactPlan,
} from '../../../src/commands/relationships/contact-plan/inspect.js';

function command<T>(constructor: new (...args: never[]) => T): T {
  return Object.create(constructor.prototype) as T;
}

const plan = {
  contractVersion: 1,
  owner: {type: 'workspace', id: '33333333-3333-4333-8333-333333333333'},
  person: {
    id: '22222222-2222-4222-8222-222222222222',
    displayName: 'Sidney Holt',
    timezone: 'America/New_York',
  },
  asOf: '2026-08-11T12:00:00.000Z',
  window: {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-09-01T00:00:00.000Z',
    timezone: 'America/New_York',
  },
  contactPoints: [],
  policy: {
    state: 'blocked',
    evaluatedAt: '2026-08-11T12:00:00.000Z',
    requiresLiveRecheck: true,
    timezone: 'America/New_York',
    blockingReasons: [{
      code: 'do_not_contact',
      severity: 'block',
      message: 'Recipient is suppressed.',
      sourceRef: {kind: 'person', id: '22222222-2222-4222-8222-222222222222', locator: 'email'},
    }],
    advisories: [],
  },
  items: [{
    id: 'contact-plan:composer_session:session-1',
    channel: 'email',
    intent: 'contact',
    actionKind: 'relationship.communication.send',
    state: 'pending_approval',
    title: 'Reconnect after Atlas',
    summary: null,
    plannedAt: '2026-08-13T14:00:00.000Z',
    occurredAt: null,
    observedAt: '2026-08-11T12:00:00.000Z',
    actor: {userId: '11111111-1111-4111-8111-111111111111', label: 'Thomas'},
    approval: {id: '44444444-4444-4444-8444-444444444444', state: 'pending', decidedAt: null},
    outcome: {state: 'none', occurredAt: null, receiptId: null},
    sourceRefs: [{kind: 'composer_session', id: 'session-1', locator: 'draft:7'}],
  }],
  collisions: [{
    id: 'collision-1',
    kind: 'contradictory_intent',
    itemIds: ['contact-plan:composer_session:session-1', 'contact-plan:task:task-1'],
    windowStart: '2026-08-13T14:00:00.000Z',
    windowEnd: '2026-08-13T15:00:00.000Z',
    reason: 'A send and stop action overlap.',
  }],
  diagnostics: [{
    code: 'source_visibility_partial',
    severity: 'warning',
    message: 'Private drafts remain actor scoped.',
    sourceRef: null,
  }],
  page: {limit: 100, returned: 1, hasMore: false},
};

describe('relationships contact-plan inspect', () => {
  test('forwards the exact authenticated scope and bounded read query', async () => {
    const instance = command(RelationshipsContactPlanInspect);
    const getRelationshipContactPlan = jest.fn().mockResolvedValue({
      statusCode: 200,
      data: {plan},
    });
    const flags = {
      workspace: plan.owner.id,
      from: plan.window.from,
      to: plan.window.to,
      timezone: plan.window.timezone,
      limit: 40,
    };
    (instance as any).parse = jest.fn().mockResolvedValue({args: {person: plan.person.id}, flags});
    (instance as any).client = jest.fn().mockResolvedValue({getRelationshipContactPlan});
    (instance as any).handleApiError = jest.fn();
    (instance as any).jsonEnabled = () => true;

    await expect(instance.run()).resolves.toBe(plan);
    expect((instance as any).client).toHaveBeenCalledWith(flags);
    expect(getRelationshipContactPlan).toHaveBeenCalledWith(plan.person.id, {
      from: plan.window.from,
      to: plan.window.to,
      timezone: plan.window.timezone,
      limit: 40,
    });
  });

  test('preserves the backend error envelope for ordinary CLI recovery', async () => {
    const instance = command(RelationshipsContactPlanInspect);
    const response = {
      statusCode: 403,
      error: JSON.stringify({type: 'about:blank', title: 'Forbidden', status: 403}),
    };
    (instance as any).parse = jest.fn().mockResolvedValue({args: {person: plan.person.id}, flags: {limit: 100}});
    (instance as any).client = jest.fn().mockResolvedValue({
      getRelationshipContactPlan: jest.fn().mockResolvedValue(response),
    });
    (instance as any).handleApiError = jest.fn(() => {
      throw new Error('Permission denied: Forbidden');
    });

    await expect(instance.run()).rejects.toThrow('Permission denied: Forbidden');
    expect((instance as any).handleApiError).toHaveBeenCalledWith(response);
  });

  test('human output exposes lifecycle, policy, collision, diagnostic, and source identity', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      renderContactPlan(plan);
      const output = log.mock.calls.map(call => call.join(' ')).join('\n');
      expect(output).toContain('pending_approval');
      expect(output).toContain('do_not_contact');
      expect(output).toContain('contradictory_intent');
      expect(output).toContain('source_visibility_partial');
      expect(output).toContain('composer_session:session-1#draft:7');
      expect(output).toContain('live recheck required');
      expect(output).toContain('Inspection only');
    } finally {
      log.mockRestore();
    }
  });

  test('advertises no mutation or approval escape hatch', () => {
    expect(RelationshipsContactPlanInspect.flags).not.toHaveProperty('yes');
    expect(RelationshipsContactPlanInspect.flags).not.toHaveProperty('idempotency-key');
    expect(RelationshipsContactPlanInspect.flags).not.toHaveProperty('approve');
    expect(RelationshipsContactPlanInspect.flags).not.toHaveProperty('send');
    expect(RelationshipsContactPlanInspect.flags.limit).toEqual(expect.objectContaining({
      default: 100,
      min: 1,
      max: 250,
    }));
  });
});

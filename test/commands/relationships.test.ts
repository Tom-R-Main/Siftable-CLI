import {BaseCommand} from '../../src/lib/base-command';
import RelationshipsComposerShow from '../../src/commands/relationships/composer/show';
import RelationshipsComposerConfirm from '../../src/commands/relationships/composer/confirm';
import RelationshipsComposerBindSender from '../../src/commands/relationships/composer/bind-sender';
import RelationshipsComposerEvaluate from '../../src/commands/relationships/composer/evaluate';
import RelationshipsComposerFindingAction from '../../src/commands/relationships/composer/finding-action';
import RelationshipsComposerHistory from '../../src/commands/relationships/composer/history';
import RelationshipsComposerReview from '../../src/commands/relationships/composer/review';
import RelationshipsComposerRequestApproval from '../../src/commands/relationships/composer/request-approval';
import RelationshipsComposerResolveIdentity from '../../src/commands/relationships/composer/resolve-identity';
import RelationshipsComposerRequestChanges from '../../src/commands/relationships/composer/request-changes';
import RelationshipsComposerApproverEdit from '../../src/commands/relationships/composer/approver-edit';
import {installIsolatedConfigDirHooks} from '../helpers/config-env';
import {mockFetch, restoreFetch, runCommand} from '../helpers/mock-api';

installIsolatedConfigDirHooks('sift-cli-relationships-test-');

afterEach(() => restoreFetch());

const recommendationId = '11111111-1111-4111-8111-111111111111';
const entityId = '22222222-2222-4222-8222-222222222222';
const workspaceId = '33333333-3333-4333-8333-333333333333';
const snapshot = {
  recommendationId,
  subject: {kind: 'opportunity', id: entityId},
  priorityScore: 82,
  executable: true,
  suppressionReasons: [],
  sourceDigest: 'a'.repeat(64),
  rankingVersion: 'relationship-ranking.v1',
  policyVersion: 'relationship-policy.v1',
  gates: [{code: 'citations_present', status: 'passed', reason: 'One exact citation is available.'}],
};
const recommendation = {snapshot, state: 'pending_review', latestReview: null, executedAt: null};

function command<T>(constructor: new (...args: never[]) => T): T {
  return Object.create(constructor.prototype) as T;
}

describe('relationship intelligence commands', () => {
  it('composes a structured brief and lists or shows immutable recommendations', async () => {
    mockFetch()
      .on('POST', '/api/v1/relationships/brief')
      .body((body) => (body as {subject?: {kind?: string}}).subject?.kind === 'opportunity')
      .reply(200, {brief: {subjectLabel: 'Acme renewal', citations: [{}], recommendations: [snapshot]}})
      .on('GET', '/api/v1/relationships/recommendations')
      .query((url) => url.searchParams.get('subjectType') === 'opportunity'
        && url.searchParams.get('subjectId') === entityId)
      .reply(200, {recommendations: [recommendation]})
      .on('GET', `/api/v1/relationships/recommendations/${recommendationId}`)
      .reply(200, {recommendation})
      .install();

    const brief = await runCommand([
      'relationships', 'brief', `opportunity:${entityId}`, '--json', '--token', 'exf_pat_test',
    ]);
    const list = await runCommand([
      'relationships', 'recommendations', 'list',
      '--subject', `opportunity:${entityId}`, '--json', '--token', 'exf_pat_test',
    ]);
    const show = await runCommand([
      'relationships', 'recommendations', 'show', recommendationId, '--json', '--token', 'exf_pat_test',
    ]);

    expect(JSON.parse(brief.stdout).subjectLabel).toBe('Acme renewal');
    expect(JSON.parse(list.stdout)[0].snapshot.recommendationId).toBe(recommendationId);
    expect(JSON.parse(show.stdout).snapshot.sourceDigest).toBe('a'.repeat(64));
  });

  it('completes review and execute without a GUI step', async () => {
    mockFetch()
      .on('POST', `/api/v1/relationships/recommendations/${recommendationId}/reviews`)
      .body((body) => (body as {decision?: string}).decision === 'accepted')
      .reply(201, {recommendation: {...recommendation, state: 'accepted'}})
      .on('POST', `/api/v1/relationships/recommendations/${recommendationId}/execute`)
      .reply(200, {
        recommendation: {...recommendation, state: 'executed'},
        outcome: {status: 'applied'},
      })
      .install();

    const reviewed = await runCommand([
      'relationships', 'recommendations', 'review', recommendationId,
      '--decision', 'accepted', '--yes', '--json', '--token', 'exf_pat_test',
    ]);
    const executed = await runCommand([
      'relationships', 'recommendations', 'execute', recommendationId,
      '--yes', '--json', '--token', 'exf_pat_test',
    ]);

    expect(JSON.parse(reviewed.stdout).state).toBe('accepted');
    expect(JSON.parse(executed.stdout).outcome.status).toBe('applied');
  });

  it('keeps the existing next-action CLI syntax compatible', async () => {
    mockFetch()
      .on('GET', '/api/v1/ontology/relationships/actions')
      .reply(200, {
        version: 2,
        actions: [{
          id: 'relationship.next_action.set',
          label: 'Set next action',
          commitmentClass: 'persistent_internal',
        }],
      })
      .on('POST', '/api/v1/ontology/relationship-actions/run')
      .body((body) => (body as {actionId?: string}).actionId === 'relationship.next_action.set')
      .reply(200, {result: {actionId: 'relationship.next_action.set', status: 'applied'}})
      .install();

    const listed = await runCommand([
      'relationships', 'actions', 'list', '--json', '--token', 'exf_pat_test',
    ]);
    const run = await runCommand([
      'relationships', 'actions', 'run', 'relationship.next_action.set',
      '--entity', `opportunity:${entityId}`,
      '--input', JSON.stringify({title: 'Follow up', dueAt: '2026-08-03T17:00:00.000Z'}),
      '--idempotency-key', 'next-action-compat-0001',
      '--yes', '--json', '--token', 'exf_pat_test',
    ]);

    expect(JSON.parse(listed.stdout)[0].id).toBe('relationship.next_action.set');
    expect(JSON.parse(run.stdout).status).toBe('applied');
  });

  it('resumes and advances the same durable composer session without a GUI', async () => {
    const sessionId = '55555555-5555-4555-8555-555555555555';
    const senderId = '66666666-6666-4666-8666-666666666666';
    const session = {
      id: sessionId,
      phase: 'brief',
      version: 2,
      senderAccountId: null,
      evidence: [{ rank: 1, decision: 'included', label: 'Atlas pilot recap' }],
    };
    const show = command(RelationshipsComposerShow);
    const confirm = command(RelationshipsComposerConfirm);
    const bind = command(RelationshipsComposerBindSender);
    const evaluate = command(RelationshipsComposerEvaluate);
    const findingAction = command(RelationshipsComposerFindingAction);
    const history = command(RelationshipsComposerHistory);
    const review = command(RelationshipsComposerReview);
    const requestApproval = command(RelationshipsComposerRequestApproval);
    const resolveIdentity = command(RelationshipsComposerResolveIdentity);
    const requestChanges = command(RelationshipsComposerRequestChanges);
    const approverEdit = command(RelationshipsComposerApproverEdit);
    const findingId = '77777777-7777-4777-8777-777777777777';
    const coached = { ...session, phase: 'draft', version: 4, findings: [{ id: findingId, status: 'active' }], reviewGate: { eligible: false } };
    const accepted = { ...coached, version: 5, findings: [{ id: findingId, status: 'accepted' }], reviewGate: { eligible: true } };
    const apiRequest = jest.fn()
      .mockResolvedValueOnce({ session })
      .mockResolvedValueOnce({ session: { ...session, phase: 'draft', version: 3, draft: { revisionId: recommendationId, revision: 1 } } })
      .mockResolvedValueOnce({ session: coached })
      .mockResolvedValueOnce({ session: accepted })
      .mockResolvedValueOnce({ session: { ...accepted, coachingHistory: [{ action: 'accepted' }] } })
      .mockResolvedValueOnce({ session: { ...accepted, phase: 'review', version: 6 } })
      .mockResolvedValueOnce({ session: { ...accepted, version: 7, senderAccountId: senderId } })
      .mockResolvedValueOnce({ session: {
        ...accepted,
        phase: 'review',
        version: 8,
        review: {
          digest: 'a'.repeat(64),
          approval: {
            id: '88888888-8888-4888-8888-888888888888',
            status: 'pending',
            approvalUrl: '/settings/security/approvals/88888888-8888-4888-8888-888888888888',
          },
        },
      } })
      .mockResolvedValueOnce({ session: {
        ...accepted,
        phase: 'review',
        version: 9,
        review: { digest: 'a'.repeat(64), identityCollision: { status: 'resolved' } },
      } })
      .mockResolvedValueOnce({ session: { ...accepted, phase: 'draft', version: 10 } })
      .mockResolvedValueOnce({ session: {
        ...accepted,
        phase: 'draft',
        version: 11,
        draft: { revisionId: recommendationId, revision: 2 },
      } });
    (show as any).parse = jest.fn().mockResolvedValue({ args: { id: sessionId }, flags: {} });
    (show as any).apiRequest = apiRequest;
    (show as any).jsonEnabled = () => true;
    (confirm as any).parse = jest.fn().mockResolvedValue({ args: { id: sessionId }, flags: { 'expected-version': 2, yes: true } });
    (confirm as any).apiRequest = apiRequest;
    (confirm as any).confirmAction = jest.fn().mockResolvedValue(true);
    (confirm as any).jsonEnabled = () => true;
    (evaluate as any).parse = jest.fn().mockResolvedValue({ args: { id: sessionId }, flags: { 'expected-version': 3 } });
    (evaluate as any).apiRequest = apiRequest;
    (evaluate as any).jsonEnabled = () => true;
    (findingAction as any).parse = jest.fn().mockResolvedValue({ args: { id: sessionId, finding: findingId }, flags: { 'expected-version': 4, action: 'accept', yes: true } });
    (findingAction as any).apiRequest = apiRequest;
    (findingAction as any).confirmAction = jest.fn().mockResolvedValue(true);
    (findingAction as any).jsonEnabled = () => true;
    (history as any).parse = jest.fn().mockResolvedValue({ args: { id: sessionId }, flags: {} });
    (history as any).apiRequest = apiRequest;
    (history as any).jsonEnabled = () => true;
    (review as any).parse = jest.fn().mockResolvedValue({ args: { id: sessionId }, flags: { 'expected-version': 5, yes: true } });
    (review as any).apiRequest = apiRequest;
    (review as any).confirmAction = jest.fn().mockResolvedValue(true);
    (review as any).jsonEnabled = () => true;
    (bind as any).parse = jest.fn().mockResolvedValue({ args: { id: sessionId }, flags: { 'expected-version': 6, sender: senderId } });
    (bind as any).apiRequest = apiRequest;
    (bind as any).jsonEnabled = () => true;
    (requestApproval as any).parse = jest.fn().mockResolvedValue({
      args: { id: sessionId },
      flags: { 'expected-version': 7, 'idempotency-key': 'composer-review-0001', yes: true },
    });
    (requestApproval as any).apiRequest = apiRequest;
    (requestApproval as any).confirmAction = jest.fn().mockResolvedValue(true);
    (requestApproval as any).jsonEnabled = () => true;
    (resolveIdentity as any).parse = jest.fn().mockResolvedValue({
      args: { id: sessionId },
      flags: { 'expected-version': 8, candidate: entityId, decision: 'same_person', yes: true },
    });
    (resolveIdentity as any).apiRequest = apiRequest;
    (resolveIdentity as any).confirmAction = jest.fn().mockResolvedValue(true);
    (resolveIdentity as any).jsonEnabled = () => true;
    (requestChanges as any).parse = jest.fn().mockResolvedValue({
      args: { id: sessionId },
      flags: { 'expected-version': 9, reason: 'Clarify timing.', yes: true },
    });
    (requestChanges as any).apiRequest = apiRequest;
    (requestChanges as any).confirmAction = jest.fn().mockResolvedValue(true);
    (requestChanges as any).jsonEnabled = () => true;
    (approverEdit as any).parse = jest.fn().mockResolvedValue({
      args: { id: sessionId },
      flags: {
        'expected-version': 10,
        subject: 'Updated subject',
        body: 'Preserved full message with one attributed edit.',
        reason: 'Use an exact day.',
        yes: true,
      },
    });
    (approverEdit as any).apiRequest = apiRequest;
    (approverEdit as any).confirmAction = jest.fn().mockResolvedValue(true);
    (approverEdit as any).jsonEnabled = () => true;

    await expect(show.run()).resolves.toMatchObject({ phase: 'brief' });
    await expect(confirm.run()).resolves.toMatchObject({ phase: 'draft', draft: { revision: 1 } });
    await expect(evaluate.run()).resolves.toMatchObject({ findings: [{ status: 'active' }] });
    await expect(findingAction.run()).resolves.toMatchObject({ findings: [{ status: 'accepted' }] });
    await expect(history.run()).resolves.toEqual([{ action: 'accepted' }]);
    await expect(review.run()).resolves.toMatchObject({ phase: 'review' });
    await expect(bind.run()).resolves.toMatchObject({ senderAccountId: senderId });
    await expect(requestApproval.run()).resolves.toMatchObject({
      review: { approval: { status: 'pending' } },
    });
    await expect(resolveIdentity.run()).resolves.toMatchObject({
      review: { identityCollision: { status: 'resolved' } },
    });
    await expect(requestChanges.run()).resolves.toMatchObject({ phase: 'draft' });
    await expect(approverEdit.run()).resolves.toMatchObject({ draft: { revision: 2 } });
    expect(apiRequest.mock.calls.map((call) => call[1])).toEqual([
      `/api/v1/relationships/composer-sessions/${sessionId}`,
      `/api/v1/relationships/composer-sessions/${sessionId}/confirm-brief`,
      `/api/v1/relationships/composer-sessions/${sessionId}/coaching/evaluate`,
      `/api/v1/relationships/composer-sessions/${sessionId}/coaching/findings/${findingId}/action`,
      `/api/v1/relationships/composer-sessions/${sessionId}`,
      `/api/v1/relationships/composer-sessions/${sessionId}/review`,
      `/api/v1/relationships/composer-sessions/${sessionId}/sender`,
      `/api/v1/relationships/composer-sessions/${sessionId}/approval-requests`,
      `/api/v1/relationships/composer-sessions/${sessionId}/identity-resolution`,
      `/api/v1/relationships/composer-sessions/${sessionId}/request-changes`,
      `/api/v1/relationships/composer-sessions/${sessionId}/approver-edit`,
    ]);
  });
});

describe('relationship collaboration commands', () => {
  it('shows the same typed append-only history the GUI reads', async () => {
    const snapshotWithHistory = {
      entity: {kind: 'opportunity', id: entityId},
      ownerType: 'workspace',
      ownerId: workspaceId,
      ownerUserId: recommendationId,
      assigneeUserId: null,
      teamQueue: {id: recommendationId, kind: 'general', name: 'General'},
      version: 8,
      isWatching: true,
      allowedActionIds: ['relationship.comment.add'],
      events: [{
        id: '55555555-5555-4555-8555-555555555555',
        actionId: 'relationship.comment.add',
        eventType: 'comment_added',
        actorUserId: recommendationId,
        versionBefore: 7,
        versionAfter: 8,
        occurredAt: '2026-07-30T12:00:00.000Z',
        detail: {commentExcerpt: 'Contract terms confirmed.', mentionUserIds: []},
      }],
      updatedAt: '2026-07-30T12:00:00.000Z',
    };
    mockFetch()
      .on('GET', `/api/v1/ontology/relationship-collaboration/opportunity/${entityId}`)
      .reply(200, {snapshot: snapshotWithHistory})
      .install();

    const human = await runCommand([
      'relationships', 'show', `opportunity:${entityId}`, '--token', 'sift_pat_test',
    ]);
    const json = await runCommand([
      'relationships', 'show', `opportunity:${entityId}`, '--json', '--token', 'sift_pat_test',
    ]);

    expect(human.stdout).toContain('Collaboration history (1):');
    expect(human.stdout).toContain('comment_added v7 -> v8');
    expect(human.stdout).toContain('Contract terms confirmed.');
    const parsed = JSON.parse(json.stdout);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({eventType: 'comment_added', versionAfter: 8});
  });

  it('discovers the live server registry without a copied CLI contract', async () => {
    mockFetch()
      .on('GET', '/api/v1/ontology/relationships/actions')
      .reply(200, {
        version: 2,
        actions: [{
          id: 'relationship.assignment.set',
          label: 'Set relationship assignment',
          description: 'Assign a relationship',
          commitmentClass: 'persistent_internal',
          inputJsonSchema: {type: 'object'},
          outputJsonSchema: {type: 'object'},
          surfaceBindings: [],
        }],
      })
      .install();

    const result = await runCommand([
      'relationships', 'actions', 'list', '--token', 'sift_pat_test', '--json',
    ]);

    expect(JSON.parse(result.stdout)).toMatchObject([
      {id: 'relationship.assignment.set'},
    ]);
  });

  it('forwards arbitrary action IDs, expected version, workspace, and the caller replay key', async () => {
    mockFetch()
      .on('POST', '/api/v1/ontology/relationship-actions/run')
      .body((body) => {
        const invocation = body as Record<string, any>;
        return invocation.actionId === 'relationship.assignment.set'
          && invocation.entity.kind === 'opportunity'
          && invocation.entity.id === entityId
          && invocation.input.assigneeId === workspaceId
          && invocation.input.teamQueueId === null
          && invocation.input.expectedVersion === 7;
      })
      .reply(200, {result: {actionId: 'relationship.assignment.set', status: 'applied'}})
      .install();

    const result = await runCommand([
      'relationships', 'actions', 'run',
      'relationship.assignment.set', `opportunity:${entityId}`,
      '--input', JSON.stringify({assigneeId: workspaceId, teamQueueId: null}),
      '--expected-version', '7',
      '--idempotency-key', 'rel-assignment-0001',
      '--workspace', workspaceId,
      '--yes',
      '--token', 'sift_pat_test',
      '--json',
    ]);

    expect(result.error).toBeUndefined();
    const fetchMock = global.fetch as jest.Mock;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      'Idempotency-Key': 'rel-assignment-0001',
      'X-Workspace-Id': workspaceId,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({actionId: 'relationship.assignment.set'});
  });

  it('surfaces stable nested relationship conflict codes', async () => {
    mockFetch()
      .on('POST', '/api/v1/ontology/relationship-actions/run')
      .reply(409, {
        error: {
          actionId: 'relationship.watch.set',
          code: 'RELATIONSHIP_ACTION_CONFLICT',
          message: 'Relationship changed from version 2 to 3',
        },
      })
      .install();

    const result = await runCommand([
      'relationships', 'actions', 'run',
      'relationship.watch.set', `opportunity:${entityId}`,
      '--input', JSON.stringify({watching: true}),
      '--expected-version', '2',
      '--idempotency-key', 'rel-watch-0001',
      '--yes',
      '--token', 'sift_pat_test',
      '--json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const parsed = (BaseCommand.prototype as unknown as {
      parseApiError(error: string): {message: string; payload: Record<string, unknown>};
    }).parseApiError(JSON.stringify({
      error: {
        actionId: 'relationship.watch.set',
        code: 'RELATIONSHIP_ACTION_CONFLICT',
        message: 'Relationship changed from version 2 to 3',
      },
    }));
    expect(parsed).toMatchObject({
      message: 'Relationship changed from version 2 to 3',
      payload: {type: 'RELATIONSHIP_ACTION_CONFLICT', actionId: 'relationship.watch.set'},
    });
  });
});

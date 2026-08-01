import {BaseCommand} from '../../src/lib/base-command';
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
